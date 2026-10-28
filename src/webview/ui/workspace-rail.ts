import type { Workspace } from "../../model";
import { MAX_WORKSPACES } from "../constants";
import { createControl, reconcileChildren } from "./controls";
import { createIcon } from "./icons";
import type { WorkspaceActions } from "./types";
import {
  clearAllDragIndicators,
  clearAllInsertionMarkers,
  clearInsertionMarker,
  isTabDrag,
  isWorkspaceDrag,
  readDraggedTab,
  readDraggedWorkspace,
  showInsertionMarker,
  WORKSPACE_DRAG_TYPE,
} from "./tab-drag";

export class WorkspaceRail {
  readonly element = document.createElement("nav");
  private readonly list = document.createElement("div");
  private readonly workspaceInsertionMarker = document.createElement("div");
  private readonly buttons = new Map<string, HTMLButtonElement>();
  private readonly add: HTMLButtonElement;
  private readonly windowButton: HTMLButtonElement;
  private readonly maximizeButton: HTMLButtonElement;
  private readonly settingsButton: HTMLButtonElement;
  private readonly settingsPanel: HTMLDivElement;
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
    this.add.addEventListener("dragover", (event) => {
      if (isWorkspaceDrag(event.dataTransfer)) {
        event.preventDefault();
        event.stopPropagation();
        const workspaces = [
          ...this.list.querySelectorAll<HTMLElement>(".workspace-label"),
        ];
        showInsertionMarker(
          this.list,
          this.workspaceInsertionMarker,
          workspaces,
          "vertical",
          event.clientX,
          event.clientY,
        );
        this.list.dataset.insertionIndex = String(this.buttons.size);
        const bounds = this.list.getBoundingClientRect();
        this.workspaceInsertionMarker.style.top = workspaces.length
          ? `${workspaces.at(-1)!.getBoundingClientRect().bottom - bounds.top + this.list.scrollTop}px`
          : "0px";
        event.dataTransfer!.dropEffect = "move";
        return;
      }
      if (!isTabDrag(event.dataTransfer) || this.add.disabled) return;
      event.preventDefault();
      event.stopPropagation();
      this.add.dataset.dropNew = "true";
      event.dataTransfer!.dropEffect = "move";
    });
    this.add.addEventListener("dragleave", (event) => {
      if (isWorkspaceDrag(event.dataTransfer)) {
        clearInsertionMarker(this.list, this.workspaceInsertionMarker);
        return;
      }
      if (
        event.relatedTarget instanceof Node &&
        this.add.contains(event.relatedTarget)
      )
        return;
      delete this.add.dataset.dropNew;
    });
    this.add.addEventListener("drop", (event) => {
      const workspaceId = readDraggedWorkspace(event.dataTransfer);
      if (workspaceId) {
        event.preventDefault();
        event.stopPropagation();
        clearInsertionMarker(this.list, this.workspaceInsertionMarker);
        clearAllInsertionMarkers();
        this.actions.reorderWorkspace(workspaceId, this.buttons.size);
        return;
      }
      const tabId = readDraggedTab(event.dataTransfer);
      if (!tabId || this.add.disabled) return;
      event.preventDefault();
      event.stopPropagation();
      delete this.add.dataset.dropNew;
      actions.moveTabToNewWorkspace(tabId);
    });
    this.list.addEventListener("dragover", (event) => {
      if (!isTabDrag(event.dataTransfer)) return;
      if (
        event.target instanceof Element &&
        event.target.closest(".workspace-label")
      ) {
        delete this.list.dataset.dropNew;
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      this.list.dataset.dropNew = "true";
      event.dataTransfer!.dropEffect = "move";
    });
    this.list.addEventListener(
      "dragover",
      (event) => {
        if (
          !isWorkspaceDrag(event.dataTransfer) &&
          !isTabDrag(event.dataTransfer)
        )
          return;
        event.preventDefault();
        if (isWorkspaceDrag(event.dataTransfer)) event.stopPropagation();
        showInsertionMarker(
          this.list,
          this.workspaceInsertionMarker,
          [...this.list.querySelectorAll<HTMLElement>(".workspace-label")],
          "vertical",
          event.clientX,
          event.clientY,
        );
        event.dataTransfer!.dropEffect = "move";
      },
      true,
    );
    this.list.addEventListener(
      "dragleave",
      (event) => {
        if (
          !isWorkspaceDrag(event.dataTransfer) &&
          !isTabDrag(event.dataTransfer)
        )
          return;
        if (
          event.relatedTarget instanceof Node &&
          this.list.contains(event.relatedTarget)
        )
          return;
        clearInsertionMarker(this.list, this.workspaceInsertionMarker);
      },
      true,
    );
    this.list.addEventListener(
      "drop",
      (event) => {
        const workspaceId = readDraggedWorkspace(event.dataTransfer);
        if (!workspaceId) return;
        event.preventDefault();
        event.stopPropagation();
        const targetIndex = Number(this.list.dataset.insertionIndex || 0);
        clearInsertionMarker(this.list, this.workspaceInsertionMarker);
        clearAllInsertionMarkers();
        this.actions.reorderWorkspace(workspaceId, targetIndex);
      },
      true,
    );
    this.list.addEventListener("dragleave", (event) => {
      if (
        event.relatedTarget instanceof Node &&
        this.list.contains(event.relatedTarget)
      )
        return;
      delete this.list.dataset.dropNew;
    });
    this.list.addEventListener("drop", (event) => {
      const tabId = readDraggedTab(event.dataTransfer);
      if (
        !tabId ||
        (event.target instanceof Element &&
          event.target.closest(".workspace-label"))
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      delete this.list.dataset.dropNew;
      showInsertionMarker(
        this.list,
        this.workspaceInsertionMarker,
        [...this.list.querySelectorAll<HTMLElement>(".workspace-label")],
        "vertical",
        event.clientX,
        event.clientY,
      );
      const targetIndex = Number(this.list.dataset.insertionIndex || 0);
      clearInsertionMarker(this.list, this.workspaceInsertionMarker);
      actions.moveTabToNewWorkspace(tabId, targetIndex);
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
      this.settingsPanel,
      this.settingsButton,
      this.windowButton,
      this.maximizeButton,
    );
    this.element.append(scroll, footer);
    this.element.addEventListener("dragover", (event) => {
      if (!isTabDrag(event.dataTransfer) || event.target !== this.element)
        return;
      if (this.add.disabled) return;
      event.preventDefault();
      this.element.dataset.dropNew = "true";
      event.dataTransfer!.dropEffect = "move";
    });
    this.element.addEventListener("dragleave", (event) => {
      if (
        event.relatedTarget instanceof Node &&
        this.element.contains(event.relatedTarget)
      )
        return;
      delete this.element.dataset.dropNew;
    });
    this.element.addEventListener("drop", (event) => {
      const tabId = readDraggedTab(event.dataTransfer);
      if (!tabId || event.target !== this.element || this.add.disabled) return;
      event.preventDefault();
      delete this.element.dataset.dropNew;
      actions.moveTabToNewWorkspace(tabId);
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
    this.settingsButton.disabled = false;
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
          event.dataTransfer?.setData(WORKSPACE_DRAG_TYPE, workspace.id);
          if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
          clearAllDragIndicators();
        });
        button.addEventListener("dragend", () => {
          clearAllDragIndicators();
        });
        button.addEventListener("dragover", (event) => {
          if (!isTabDrag(event.dataTransfer)) return;
          event.preventDefault();
          event.stopPropagation();
          button!.dataset.dropTarget = "true";
          event.dataTransfer!.dropEffect = "move";
        });
        button.addEventListener("dragleave", (event) => {
          if (
            event.relatedTarget instanceof Node &&
            button!.contains(event.relatedTarget)
          )
            return;
          delete button!.dataset.dropTarget;
        });
        button.addEventListener("drop", (event) => {
          const tabId = readDraggedTab(event.dataTransfer);
          if (!tabId) return;
          event.preventDefault();
          event.stopPropagation();
          delete button!.dataset.dropTarget;
          delete this.list.dataset.dropNew;
          clearInsertionMarker(this.list, this.workspaceInsertionMarker);
          this.actions.moveTabToWorkspace(tabId, workspace.id);
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
          "Start new terminals as direct sessions. They do not survive extension host or editor restarts.",
        ],
        [
          "Protected",
          true,
          "Start new terminals in tmux. They survive extension host and editor restarts.",
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
          "In Attach Mode, tmux owns selection, scrolling, and terminal application mouse input.",
        ],
        [
          "Off",
          false,
          "In Attach Mode, use local terminal selection and scrolling. Terminal applications can still request mouse input.",
        ],
      ],
      () => this.actions.terminalPreferences().tmuxMouse,
      (value) =>
        this.actions.updatePreferences({
          ...this.actions.terminalPreferences(),
          tmuxMouse: value,
        }),
      "Only affects Attach Mode. Turn off tmux Mouse to use local terminal selection.",
    );
    const mouse = this.settingsGroup(
      "Terminal Mouse",
      [
        [
          "Application",
          "application",
          "Terminal applications receive mouse input first. Hold Shift to scroll terminal history while an application tracks the mouse.",
        ],
        [
          "Terminal",
          "terminal",
          "Terminal scrolling is handled locally, even when a terminal application requests mouse input.",
        ],
        [
          "App Exclusive",
          "exclusive",
          "Terminal applications exclusively handle mouse input. Scrolling is not intercepted.",
        ],
      ] as const,
      () => this.actions.terminalPreferences().mousePolicy,
      (value) =>
        this.actions.updatePreferences({
          ...this.actions.terminalPreferences(),
          mousePolicy: value,
        }),
      "The Terminal Mouse policy applies only in Control Mode. Attach Mode uses the separate tmux Mouse setting.",
    );
    const section = document.createElement("section");
    section.className = "terminal-settings__section";
    const sectionTitle = document.createElement("h2");
    sectionTitle.className = "terminal-settings__section-title";
    sectionTitle.textContent = "Terminal & tmux Settings";
    section.append(
      sectionTitle,
      protection.element,
      transport.element,
      tmuxMouse.element,
      mouse.element,
    );
    panel.append(section, availability);
    this.updateSettingsControls = () => {
      const available = this.actions.protectionAvailable();
      availability.hidden = available;
      availability.textContent = "tmux 3.2a or newer is required.";
      protection.refresh(this.actions.terminalPreferences().defaultProtected);
      transport.refresh(this.actions.terminalPreferences().transport);
      tmuxMouse.refresh(this.actions.terminalPreferences().tmuxMouse);
      mouse.refresh(this.actions.terminalPreferences().mousePolicy);
      protection.buttons.forEach((button) => (button.disabled = !available));
      transport.buttons.forEach((button) => (button.disabled = !available));
      tmuxMouse.buttons.forEach((button) => (button.disabled = !available));
      const attach =
        available && this.actions.terminalPreferences().transport === "attach";
      tmuxMouse.element.hidden = !attach;
      mouse.element.hidden = attach;
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
    options: readonly (readonly [string, T, string?])[],
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
    if (info) {
      const infoIcon = document.createElement("button");
      infoIcon.type = "button";
      infoIcon.className = "terminal-settings__info";
      infoIcon.setAttribute("aria-label", info);
      infoIcon.append(createIcon("info"));
      this.bindSettingsTooltip(infoIcon, info);
      heading.append(infoIcon);
    }
    const buttons = document.createElement("div");
    buttons.className = "terminal-settings__options";
    buttons.setAttribute("role", "group");
    buttons.setAttribute("aria-label", title);
    const controls = options.map(([text, value, description]) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "terminal-settings__option";
      button.textContent = text;
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
