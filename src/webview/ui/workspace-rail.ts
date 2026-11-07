import type { Workspace } from "../../model";
import { MAX_WORKSPACES } from "../constants";
import { createControl, reconcileChildren } from "./controls";
import { createIcon } from "./icons";
import type { WorkspaceActions } from "./types";
import {
  installDropTarget,
  installInsertionTarget,
  startInternalDrag,
} from "./drag-target";

type SettingsOption<T> = readonly [
  label: string,
  value: T,
  description?: string,
  markers?: { default?: boolean; recommended?: boolean },
];

const SETTINGS_LEGEND = [
  ["default", "○", "Default"],
  ["recommended", "★", "Recommended"],
] as const;
const TRANSFER_REFRESH_MS = 2000;
const formatRelativeTime = (timestampSeconds: number) => {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - timestampSeconds));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
};

export class WorkspaceRail {
  readonly element = document.createElement("nav");
  private readonly list = document.createElement("div");
  private readonly workspaceInsertionMarker = document.createElement("div");
  private readonly buttons = new Map<string, HTMLButtonElement>();
  private readonly add: HTMLButtonElement;
  private readonly windowButton: HTMLButtonElement;
  private readonly maximizeButton: HTMLButtonElement;
  private readonly transferButton: HTMLButtonElement;
  private readonly transferPanel: HTMLDivElement;
  private readonly transferList: HTMLDivElement;
  private readonly settingsButton: HTMLButtonElement;
  private readonly settingsPanel: HTMLDivElement;
  private transferRefreshTimer?: ReturnType<typeof setInterval>;
  private updateTransferControls = () => {};
  private updateSettingsControls = () => {};
  private settingsTooltip?: HTMLDivElement;
  private settingsTooltipAnchor?: HTMLElement;
  private settingsDismissal?: AbortController;

  constructor(private readonly actions: WorkspaceActions) {
    this.element.className = "workspace-rail";
    this.element.setAttribute("aria-label", "Workspaces");
    this.list.className = "workspace-rail__list";
    this.list.setAttribute("role", "tablist");
    this.list.setAttribute("aria-label", "Workspaces");
    this.list.setAttribute("aria-orientation", "vertical");
    this.workspaceInsertionMarker.className = "drag-insertion-marker";
    this.workspaceInsertionMarker.dataset.axis = "vertical";
    this.workspaceInsertionMarker.setAttribute("aria-hidden", "true");
    this.workspaceInsertionMarker.hidden = true;
    this.add = createControl({
      label: "New Workspace · ⌘N",
      icon: "add",
      className: "workspace-rail__add",
      onClick: () => actions.createWorkspace(),
    });
    const scroll = document.createElement("div");
    scroll.className = "workspace-rail__scroll";
    scroll.append(this.list, this.add);
    this.windowButton = createControl({
      label: "Detach Window",
      icon: "detach",
      className: "workspace-rail__window",
      onClick: () => actions.toggleWindow(),
    });
    this.windowButton.hidden = true;
    this.maximizeButton = createControl({
      label: "Maximize / Restore Sidebar · ⌘X",
      icon: "maximize",
      className: "workspace-rail__maximize",
      onClick: () => actions.toggleSidebarSize(),
    });
    this.maximizeButton.hidden = true;
    this.transferButton = createControl({
      label: "Transfer tmux Session",
      icon: "arrow-swap",
      className: "workspace-rail__transfer",
      onClick: () => this.toggleTransfer(undefined, true),
    });
    this.transferButton.setAttribute("aria-expanded", "false");
    this.transferButton.setAttribute("aria-controls", "transfer-sessions");
    this.transferPanel = this.createTransferPanel();
    this.transferList = this.transferPanel.querySelector(
      "#transfer-sessions-list",
    )! as HTMLDivElement;
    this.settingsButton = createControl({
      label: "Terminal Settings",
      icon: "settings",
      className: "workspace-rail__settings",
      onClick: () => this.toggleSettings(undefined, true),
    });
    this.settingsButton.setAttribute("aria-expanded", "false");
    this.settingsButton.setAttribute("aria-controls", "terminal-settings");
    this.settingsPanel = this.createSettingsPanel();
    const footer = document.createElement("div");
    footer.className = "workspace-rail__footer";
    footer.append(
      this.transferPanel,
      this.settingsPanel,
      this.transferButton,
      this.settingsButton,
      this.windowButton,
      this.maximizeButton,
    );
    this.element.append(scroll, footer);
    window.addEventListener("resize", () => {
      if (!this.transferPanel.hidden) this.positionTransferPanel();
    });
    installInsertionTarget({
      owner: this.element,
      container: this.list,
      marker: this.workspaceInsertionMarker,
      items: () => [
        ...this.list.querySelectorAll<HTMLElement>(".workspace-label"),
      ],
      axis: "vertical",
      accepts: (drag) => drag.kind === "workspace" || drag.kind === "tab",
      ignore: (event, drag) => {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest(".workspace-rail__footer")) return true;
        return drag.kind === "tab" && !!target?.closest(".workspace-label");
      },
      canDrop: (drag) => drag.kind === "workspace" || !this.add.disabled,
      onDrop: (drag, targetIndex) => {
        if (drag.kind === "workspace")
          this.actions.reorderWorkspace(drag.id, targetIndex);
        else this.actions.moveTabToNewWorkspace(drag.id, targetIndex);
      },
    });
  }

  update(workspaces: Workspace[], activeId: string) {
    const presentation = this.actions.windowPresentation();
    const detached = presentation.mode === "window";
    const label = detached ? "Attach to Sidebar · ⌘D" : "Detach Window · ⌘D";
    const icon = detached ? "attach" : "detach";
    this.windowButton.hidden = !detached && !presentation.canDetach;
    this.windowButton.disabled = presentation.transitioning;
    this.windowButton.title = label;
    this.windowButton.setAttribute("aria-label", label);
    this.maximizeButton.hidden = !presentation.canMaximize;
    this.maximizeButton.disabled = detached || presentation.transitioning;
    this.maximizeButton.title = detached
      ? "Maximize / Restore Sidebar · Attach to the sidebar to use this action"
      : "Maximize / Restore Sidebar · ⌘X";
    this.maximizeButton.setAttribute("aria-label", this.maximizeButton.title);
    this.transferButton.disabled =
      !this.actions.protectionAvailable() || presentation.transitioning;
    this.transferButton.title = this.actions.protectionAvailable()
      ? "Transfer tmux Session"
      : "Transfer tmux Session · Requires tmux 3.2a or newer";
    this.transferButton.setAttribute("aria-label", this.transferButton.title);
    this.settingsButton.disabled = false;
    this.updateTransferControls();
    this.updateSettingsControls();
    if (!this.windowButton.querySelector(`[data-icon="${icon}"]`))
      this.windowButton.replaceChildren(createIcon(icon));
    const ids = new Set(workspaces.map((workspace) => workspace.id));
    for (const [id, button] of this.buttons) {
      if (!ids.has(id)) {
        button.remove();
        this.buttons.delete(id);
      }
    }
    const children = workspaces.map((workspace, index) => {
      let button = this.buttons.get(workspace.id);
      if (!button) {
        button = createControl({
          label: "",
          text: workspace.name,
          className: "workspace-label",
          onClick: () => this.actions.activateWorkspace(workspace.id),
        });
        button.setAttribute("role", "tab");
        button.addEventListener("dblclick", () =>
          this.actions.closeWorkspace(workspace.id),
        );
        button.draggable = true;
        button.addEventListener("dragstart", (event) => {
          startInternalDrag(event.dataTransfer, {
            kind: "workspace",
            id: workspace.id,
          });
        });
        installDropTarget({
          owner: button,
          accepts: (drag) => drag.kind === "tab",
          onDrop: (drag) => {
            this.actions.moveTabToWorkspace(drag.id, workspace.id);
          },
        });
        this.buttons.set(workspace.id, button);
      }
      const selected = workspace.id === activeId;
      button.id = `workspace-${workspace.id}`;
      button.querySelector(".control__label")!.textContent = workspace.name;
      button.title = `${workspace.name} · Control+${index + 1} to activate · Double-click to close`;
      button.setAttribute("aria-label", `Workspace ${index + 1}`);
      button.setAttribute("aria-selected", String(selected));
      button.setAttribute("aria-controls", "workspace-stage");
      button.tabIndex = selected ? 0 : -1;
      button.onkeydown = (event) => {
        const offset =
          event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
        if (!offset) return;
        event.preventDefault();
        const next =
          workspaces[(index + offset + workspaces.length) % workspaces.length];
        this.actions.activateWorkspace(next.id);
      };
      return button;
    });
    reconcileChildren(this.list, [...children, this.workspaceInsertionMarker]);
    this.add.disabled = workspaces.length >= MAX_WORKSPACES;
    this.add.title = this.add.disabled
      ? "Workspace limit reached (9)"
      : "New Workspace · ⌘N";
  }

  private toggleSettings(force?: boolean, restoreFocus = false) {
    const visible = force === undefined ? this.settingsPanel.hidden : force;
    if (visible) this.toggleTransfer(false);
    this.settingsPanel.hidden = !visible;
    this.settingsButton.setAttribute("aria-expanded", String(visible));
    if (visible) {
      this.startSettingsDismissal();
      this.positionSettingsPanel();
      this.updateSettingsControls();
      this.settingsPanel
        .querySelector<HTMLButtonElement>('button[aria-pressed="true"]')
        ?.focus();
    } else {
      this.settingsDismissal?.abort();
      this.settingsDismissal = undefined;
      this.hideSettingsTooltip();
      if (restoreFocus) this.settingsButton.focus();
    }
  }

  private startSettingsDismissal() {
    this.settingsDismissal?.abort();
    const listeners = new AbortController();
    this.settingsDismissal = listeners;
    document.addEventListener(
      "pointerdown",
      (event) => {
        const target = event.target;
        if (
          target instanceof Node &&
          (this.settingsPanel.contains(target) ||
            this.settingsButton.contains(target))
        )
          return;
        this.toggleSettings(false);
      },
      { capture: true, signal: listeners.signal },
    );
    window.addEventListener("blur", () => this.toggleSettings(false), {
      signal: listeners.signal,
    });
    window.addEventListener("resize", () => this.toggleSettings(false), {
      signal: listeners.signal,
    });
  }

  private createTransferPanel() {
    const panel = document.createElement("div");
    panel.className = "transfer-sessions";
    panel.id = "transfer-sessions";
    panel.hidden = true;
    panel.setAttribute("role", "region");
    panel.setAttribute("aria-label", "Transfer tmux sessions");
    panel.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      this.toggleTransfer(false, true);
    });

    const heading = document.createElement("div");
    heading.className = "transfer-sessions__heading";
    const title = document.createElement("h2");
    title.textContent = "Transfer tmux Sessions";
    const close = createControl({
      label: "Close transfer sessions",
      icon: "close",
      className: "transfer-sessions__close",
      onClick: () => this.toggleTransfer(false, true),
    });
    heading.append(title, close);
    const note = document.createElement("p");
    note.className = "transfer-sessions__note";
    note.textContent =
      "Drag a session into a pane or tab strip. Attached sessions move their display client here.";
    const list = document.createElement("div");
    list.id = "transfer-sessions-list";
    list.className = "transfer-sessions__list";
    list.setAttribute("aria-live", "polite");
    panel.append(heading, note, list);
    this.updateTransferControls = () => {
      this.renderTransferSessions();
      if (!this.transferPanel.hidden) this.positionTransferPanel();
    };
    return panel;
  }

  private toggleTransfer(force?: boolean, restoreFocus = false) {
    const visible = force === undefined ? this.transferPanel.hidden : force;
    if (visible) this.toggleSettings(false);
    this.transferPanel.hidden = !visible;
    this.transferButton.setAttribute("aria-expanded", String(visible));
    if (visible) {
      this.actions.refreshTransferSessions();
      this.updateTransferControls();
      this.positionTransferPanel();
      this.transferRefreshTimer ||= setInterval(
        () => this.actions.refreshTransferSessions(),
        TRANSFER_REFRESH_MS,
      );
    } else if (this.transferRefreshTimer) {
      clearInterval(this.transferRefreshTimer);
      this.transferRefreshTimer = undefined;
    }
    if (restoreFocus) this.transferButton.focus();
  }

  private positionTransferPanel() {
    const bounds = this.transferButton.getBoundingClientRect();
    const panelWidth = this.transferPanel.getBoundingClientRect().width;
    this.transferPanel.style.left = `${Math.round(Math.max(4, Math.min(bounds.right + 4, window.innerWidth - panelWidth - 4)))}px`;
    this.transferPanel.style.bottom = `${Math.round(window.innerHeight - bounds.bottom)}px`;
  }

  private renderTransferSessions() {
    const sessions = this.actions.transferSessions();
    const signature = JSON.stringify(sessions);
    if (this.transferList.dataset.signature === signature) return;
    this.transferList.dataset.signature = signature;
    if (!sessions.length) {
      const empty = document.createElement("p");
      empty.className = "transfer-sessions__empty";
      empty.textContent = "No tmux sessions are available to transfer.";
      this.transferList.replaceChildren(empty);
      return;
    }
    const groups = [
      ["running", "Running"],
      ["idle", "Idle"],
      ["unknown", "Unknown"],
    ] as const;
    const sections = groups.flatMap(([activity, label]) => {
      const matches = sessions.filter(
        (session) => session.activity === activity,
      );
      if (!matches.length) return [];
      const section = document.createElement("section");
      section.className = "transfer-sessions__section";
      const heading = document.createElement("div");
      heading.className = "transfer-sessions__section-heading";
      const title = document.createElement("h3");
      title.textContent = label;
      heading.append(title);
      if (activity === "idle") {
        const cleanAll = createControl({
          label: `Clean up all ${matches.length} idle tmux sessions`,
          icon: "trash",
          text: "Clean Up",
          className: "transfer-sessions__clean-all",
          onClick: () =>
            this.actions.cleanupTransferSessions(
              matches.map((session) => session.backendSessionId),
            ),
        });
        heading.append(cleanAll);
      } else if (activity === "running") {
        const canAttach = this.actions.canAttachTransfersToNewWorkspace(
          matches.length,
        );
        const attachAll = createControl({
          label: canAttach
            ? `Attach all ${matches.length} running tmux sessions to a new workspace`
            : "Cannot create another workspace or attach more than nine sessions",
          icon: "attach",
          text: "Attach All",
          className: "transfer-sessions__attach-all",
          onClick: () =>
            this.actions.attachTransfersToNewWorkspace(
              matches.map((session) => session.backendSessionId),
            ),
        });
        attachAll.disabled = !canAttach;
        heading.append(attachAll);
      }
      const items = document.createElement("div");
      items.className = "transfer-sessions__items";
      items.append(
        ...matches.map((session) => {
          const shortId = session.backendSessionId
            .replace(/^gaogrid-/, "")
            .slice(0, 8);
          const nameText = `${session.command || "tmux session"} · ${shortId}`;
          const item = document.createElement("button");
          item.type = "button";
          item.className = "transfer-session";
          item.draggable = true;
          item.dataset.activity = session.activity;
          item.title = `${nameText}\n${session.cwd}\nDrag to a pane or tab strip`;
          item.setAttribute(
            "aria-label",
            `${nameText}, ${session.activity}, ${session.cwd}`,
          );
          const status = document.createElement("span");
          status.className = "transfer-session__status";
          status.setAttribute("aria-hidden", "true");
          const content = document.createElement("span");
          content.className = "transfer-session__content";
          const name = document.createElement("span");
          name.className = "transfer-session__name";
          name.textContent = nameText;
          const details = document.createElement("span");
          details.className = "transfer-session__meta";
          const age =
            session.lastFocusedAt > 0
              ? formatRelativeTime(session.lastFocusedAt)
              : "unknown";
          details.textContent = `${session.cwd || "unknown cwd"} · ${age}${session.attached ? " · attached elsewhere" : ""}`;
          content.append(name, details);
          item.append(status, content);
          item.addEventListener("click", () =>
            this.actions.importTransferSessionToFocusedPane(
              session.backendSessionId,
            ),
          );
          item.addEventListener("dragstart", (event) => {
            startInternalDrag(event.dataTransfer, {
              kind: "transfer",
              id: session.backendSessionId,
            });
          });
          const row = document.createElement("div");
          row.className = "transfer-session-row";
          row.append(item);
          if (session.activity === "idle") {
            const clean = createControl({
              label: `Clean up ${nameText}`,
              icon: "trash",
              className: "transfer-session__clean",
              onClick: () =>
                this.actions.cleanupTransferSessions([
                  session.backendSessionId,
                ]),
            });
            row.append(clean);
          }
          return row;
        }),
      );
      section.append(heading, items);
      return [section];
    });
    this.transferList.replaceChildren(...sections);
  }

  private createSettingsPanel() {
    const panel = document.createElement("div");
    panel.className = "terminal-settings";
    panel.id = "terminal-settings";
    panel.hidden = true;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "New terminal settings");
    panel.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      this.toggleSettings(false, true);
    });

    const availability = document.createElement("p");
    availability.className = "terminal-settings__note";
    availability.hidden = true;
    const protection = this.settingsGroup(
      "Default new terminal",
      [
        [
          "Unprotected",
          false,
          "Start new terminals as Direct sessions that end when the extension host or editor restarts.",
          { default: true },
        ],
        [
          "Protected",
          true,
          "Start new terminals in tmux so sessions survive extension host and editor restarts.",
          { recommended: true },
        ],
      ],
      () => this.actions.terminalPreferences().defaultProtected,
      (value) =>
        this.actions.updatePreferences({
          ...this.actions.terminalPreferences(),
          defaultProtected: value,
        }),
    );
    const transport = this.settingsGroup(
      "tmux Transport",
      [
        [
          "Control Mode",
          "control",
          "Use the structured tmux connection for full history, snapshots, and display refresh.",
          { default: true, recommended: true },
        ],
        [
          "Attach Mode",
          "attach",
          "Use tmux's native attach client for terminal rendering and input.",
        ],
      ] as const,
      () => this.actions.terminalPreferences().transport,
      (value) =>
        this.actions.updatePreferences({
          ...this.actions.terminalPreferences(),
          transport: value,
        }),
    );
    const tmuxMouse = this.settingsGroup(
      "tmux Mouse",
      [
        [
          "On",
          true,
          "Enable tmux mouse handling for protected sessions in Control and Attach modes.",
          { default: true, recommended: true },
        ],
        [
          "Off",
          false,
          "Disable tmux's own mouse handling. Terminal applications can still request mouse input.",
        ],
      ],
      () => this.actions.terminalPreferences().tmuxMouse,
      (value) =>
        this.actions.updatePreferences({
          ...this.actions.terminalPreferences(),
          tmuxMouse: value,
        }),
      "On by default in Control and Attach modes. Changes apply to existing protected sessions.",
    );
    const mouse = this.settingsGroup(
      "Scroll Behavior",
      [
        [
          "App First",
          "application",
          "Send wheel events to applications that request mouse input. Hold Shift to use terminal scrolling instead.",
          { default: true },
        ],
        [
          "Terminal First",
          "terminal",
          "Use terminal scrollback for wheel events. In full-screen applications without scrollback, send Up/Down keys instead.",
        ],
        [
          "App Only",
          "exclusive",
          "Leave wheel events to the application when it requests mouse input. The Shift-wheel shortcut for terminal scrolling is disabled.",
        ],
      ] as const,
      () => this.actions.terminalPreferences().mousePolicy,
      (value) =>
        this.actions.updatePreferences({
          ...this.actions.terminalPreferences(),
          mousePolicy: value,
        }),
      "When an application requests mouse input, choose who handles scrolling. Applies to Direct sessions and tmux Control Mode; disabled in Attach Mode. Clicks and text selection are unchanged.",
    );
    const section = document.createElement("section");
    section.className = "terminal-settings__section";
    const sectionHeading = document.createElement("div");
    sectionHeading.className =
      "terminal-settings__heading terminal-settings__section-heading";
    const sectionTitle = document.createElement("h2");
    sectionTitle.className = "terminal-settings__section-title";
    sectionTitle.textContent = "Terminal & tmux Settings";
    sectionHeading.append(
      sectionTitle,
      this.createSettingsInfo(
        [
          '"Terminal" refers to GaoGrid\'s built-in terminal, powered by xterm.js.',
          "Protected sessions require tmux 3.2a or newer and use a dedicated tmux server and configuration, separate from your other tmux sessions and ~/.tmux.conf.",
          "If no supported tmux is detected, this menu stays visible with its setting choices disabled. Unprotected terminals remain available. Connection failures after detection are reported in the terminal.",
        ].join("\n\n"),
      ),
    );
    section.append(
      sectionHeading,
      protection.element,
      transport.element,
      tmuxMouse.element,
      mouse.element,
    );
    const legend = document.createElement("p");
    legend.className = "terminal-settings__legend";
    for (const [, symbol, label] of SETTINGS_LEGEND) {
      const item = document.createElement("span");
      item.textContent = `${symbol} ${label}`;
      legend.append(item);
    }
    panel.append(section, legend, availability);
    this.updateSettingsControls = () => {
      const available = this.actions.protectionAvailable();
      availability.hidden = available;
      availability.textContent =
        "No supported tmux was detected. These settings require tmux 3.2a or newer. Unprotected terminals remain available.";
      protection.refresh(this.actions.terminalPreferences().defaultProtected);
      transport.refresh(this.actions.terminalPreferences().transport);
      tmuxMouse.refresh(this.actions.terminalPreferences().tmuxMouse);
      mouse.refresh(this.actions.terminalPreferences().mousePolicy);
      protection.buttons.forEach((button) => (button.disabled = !available));
      transport.buttons.forEach((button) => (button.disabled = !available));
      tmuxMouse.buttons.forEach((button) => (button.disabled = !available));
      const attach =
        available && this.actions.terminalPreferences().transport === "attach";
      mouse.buttons.forEach(
        (button) => (button.disabled = attach || !available),
      );
      if (!panel.hidden) this.positionSettingsPanel();
    };
    return panel;
  }

  private positionSettingsPanel() {
    const bounds = this.settingsButton.getBoundingClientRect();
    const panelWidth = this.settingsPanel.getBoundingClientRect().width;
    this.settingsPanel.style.left = `${Math.round(Math.max(4, Math.min(bounds.right + 4, window.innerWidth - panelWidth - 4)))}px`;
    this.settingsPanel.style.bottom = `${Math.round(window.innerHeight - bounds.bottom)}px`;
  }

  private settingsGroup<T>(
    title: string,
    options: readonly SettingsOption<T>[],
    getValue: () => T,
    setValue: (value: T) => void,
    info?: string,
  ) {
    const group = document.createElement("section");
    group.className = "terminal-settings__group";
    const heading = document.createElement("div");
    heading.className = "terminal-settings__heading";
    const label = document.createElement("h3");
    label.textContent = title;
    heading.append(label);
    if (info) heading.append(this.createSettingsInfo(info));
    const buttons = document.createElement("div");
    buttons.className = "terminal-settings__options";
    buttons.setAttribute("role", "group");
    buttons.setAttribute("aria-label", title);
    const controls = options.map(([text, value, description, markers]) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "terminal-settings__option";
      button.textContent = text;
      const indicators = SETTINGS_LEGEND.filter(([key]) => markers?.[key]);
      if (indicators.length) {
        const indicator = document.createElement("span");
        indicator.className = "terminal-settings__markers";
        indicator.setAttribute("aria-hidden", "true");
        indicator.textContent = indicators.map(([, symbol]) => symbol).join("");
        button.append(indicator);
        button.setAttribute(
          "aria-label",
          [text, ...indicators.map(([, , label]) => label)].join(", "),
        );
      }
      if (description) this.bindSettingsTooltip(button, description);
      button.setAttribute("aria-pressed", String(getValue() === value));
      button.addEventListener("click", () => {
        setValue(value);
        controls.forEach((item) =>
          item.setAttribute("aria-pressed", String(item === button)),
        );
      });
      buttons.append(button);
      return button;
    });
    group.append(heading, buttons);
    return {
      element: group,
      buttons: controls,
      refresh(value: T) {
        controls.forEach((item, index) =>
          item.setAttribute(
            "aria-pressed",
            String(options[index][1] === value),
          ),
        );
      },
    };
  }

  private createSettingsInfo(description: string) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "terminal-settings__info";
    button.setAttribute("aria-label", description);
    button.append(createIcon("info"));
    this.bindSettingsTooltip(button, description);
    return button;
  }

  private bindSettingsTooltip(anchor: HTMLElement, description: string) {
    anchor.addEventListener("pointerenter", () =>
      this.showSettingsTooltip(anchor, description),
    );
    anchor.addEventListener("pointerleave", () =>
      this.hideSettingsTooltip(anchor),
    );
    anchor.addEventListener("focus", () => {
      if (anchor.matches(":focus-visible"))
        this.showSettingsTooltip(anchor, description);
    });
    anchor.addEventListener("blur", () => this.hideSettingsTooltip(anchor));
  }

  private showSettingsTooltip(anchor: HTMLElement, description: string) {
    let tooltip = this.settingsTooltip;
    if (!tooltip) {
      tooltip = document.createElement("div");
      tooltip.id = "terminal-settings-tooltip";
      tooltip.className = "settings-tooltip";
      tooltip.setAttribute("role", "tooltip");
      tooltip.hidden = true;
      document.body.append(tooltip);
      this.settingsTooltip = tooltip;
    }

    this.settingsTooltipAnchor?.removeAttribute("aria-describedby");
    this.settingsTooltipAnchor = anchor;
    anchor.setAttribute("aria-describedby", tooltip.id);
    tooltip.textContent = description;
    tooltip.hidden = false;

    const anchorBounds = anchor.getBoundingClientRect();
    const tooltipBounds = tooltip.getBoundingClientRect();
    const gutter = 4;
    let top = anchorBounds.bottom + gutter;
    if (top + tooltipBounds.height > window.innerHeight - gutter)
      top = anchorBounds.top - tooltipBounds.height - gutter;
    const left = Math.max(
      gutter,
      Math.min(
        anchorBounds.left + anchorBounds.width / 2 - tooltipBounds.width / 2,
        window.innerWidth - tooltipBounds.width - gutter,
      ),
    );
    tooltip.style.left = `${Math.round(left)}px`;
    tooltip.style.top = `${Math.round(Math.max(gutter, top))}px`;
  }

  private hideSettingsTooltip(anchor?: HTMLElement) {
    if (anchor && this.settingsTooltipAnchor !== anchor) return;
    this.settingsTooltipAnchor?.removeAttribute("aria-describedby");
    this.settingsTooltipAnchor = undefined;
    if (this.settingsTooltip) this.settingsTooltip.hidden = true;
  }
}
