import type { PaneNode } from "../../model";
import { createIcon } from "./icons";
import { MAX_SPLIT_DEPTH, MAX_TABS_PER_PANE } from "../constants";
import { TerminalFrontend } from "../terminal-frontend";
import { createControl, reconcileChildren } from "./controls";
import { MenuController, type MenuItem } from "./menu";
import type { WorkspaceActions } from "./types";
import {
  clearAllDragIndicators,
  clearAllInsertionMarkers,
  clearInsertionMarker,
  dropSideAt,
  isTabDrag,
  showInsertionMarker,
  readDraggedTab,
  writeDraggedTab,
} from "./tab-drag";

export class PaneView {
  readonly element = document.createElement("section");
  private readonly tabs = document.createElement("div");
  private readonly tabInsertionMarker = document.createElement("div");
  private readonly surface = document.createElement("div");
  private readonly tabButtons = new Map<string, HTMLButtonElement>();
  private readonly mounts = new Map<string, HTMLElement>();
  private readonly add: HTMLButtonElement;
  private readonly shield: HTMLButtonElement;
  private readonly splitButtons: HTMLButtonElement[];
  private node: PaneNode;

  constructor(
    node: PaneNode,
    private readonly actions: WorkspaceActions,
    private readonly terminals: TerminalFrontend,
    private readonly menu: MenuController,
  ) {
    this.node = node;
    this.element.className = "terminal-pane";
    this.element.dataset.paneId = node.id;
    this.element.setAttribute("aria-label", "Terminal pane");

    const header = document.createElement("header");
    header.className = "pane-header";
    const tabGroup = document.createElement("div");
    tabGroup.className = "pane-header__tabs";
    this.tabs.className = "terminal-tabs";
    this.tabs.setAttribute("role", "tablist");
    this.tabs.setAttribute("aria-label", "Terminal tabs");
    this.tabInsertionMarker.className = "drag-insertion-marker";
    this.tabInsertionMarker.dataset.axis = "horizontal";
    this.tabInsertionMarker.setAttribute("aria-hidden", "true");
    this.tabInsertionMarker.hidden = true;
    this.add = createControl({
      label: "New Tab · ⌘T",
      icon: "add",
      onClick: () => actions.createTab(this.node.id),
    });
    tabGroup.append(this.tabs, this.add);

    const tools = document.createElement("div");
    tools.className = "pane-header__actions";
    tools.setAttribute("role", "toolbar");
    tools.setAttribute("aria-label", "Pane actions");
    this.shield = createControl({
      label:
        "Protect Session\n\nMove this idle terminal into a persistent session that survives extension host and editor restarts.",
      icon: "shield",
      onClick: () => {
        if (this.node.activeTabId)
          actions.protectTab(this.node.id, this.node.activeTabId);
      },
    });
    this.splitButtons = [
      createControl({
        label: "Split Down · ⌥⇧↓ / ⌥⇧D",
        icon: "split-vertical",
        className: "pane-header__split",
        onClick: () => actions.splitPane(this.node.id, "bottom"),
      }),
      createControl({
        label: "Split Right · ⌥⇧→ / ⌥⇧R",
        icon: "split-horizontal",
        className: "pane-header__split",
        onClick: () => actions.splitPane(this.node.id, "right"),
      }),
    ];
    tools.append(this.shield, ...this.splitButtons);
    const more = createControl({
      label: "More Pane Actions",
      icon: "ellipsis",
      onClick: () => {
        actions.focusPane(this.node.id);
        this.menu.open(this.menuItems(false), { anchor: more });
      },
    });
    more.setAttribute("aria-haspopup", "menu");
    more.setAttribute("aria-expanded", "false");
    more.setAttribute("aria-controls", "gaogrid-pane-menu");
    tools.append(more);
    header.append(tabGroup, tools);
    this.surface.className = "terminal-surface";
    this.surface.addEventListener(
      "dragover",
      (event) => {
        if (!isTabDrag(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
        const tabId = readDraggedTab(event.dataTransfer);
        if (!tabId || !actions.canSplitTabIntoPane(tabId, this.node.id)) {
          this.clearDropPreview();
          event.dataTransfer!.dropEffect = "none";
          return;
        }
        const side = dropSideAt(
          this.surface.getBoundingClientRect(),
          event.clientX,
          event.clientY,
        );
        this.surface.dataset.dropSide = side;
        this.surface.dataset.dropPreview = "true";
        event.dataTransfer!.dropEffect = "move";
      },
      true,
    );
    this.surface.addEventListener(
      "dragleave",
      (event) => {
        if (!isTabDrag(event.dataTransfer)) return;
        if (
          event.relatedTarget instanceof Node &&
          this.surface.contains(event.relatedTarget)
        )
          return;
        this.clearDropPreview();
      },
      true,
    );
    this.surface.addEventListener(
      "drop",
      (event) => {
        const tabId = readDraggedTab(event.dataTransfer);
        if (!tabId) return;
        event.preventDefault();
        event.stopPropagation();
        const side =
          (this.surface.dataset.dropSide as
            "left" | "right" | "top" | "bottom" | undefined) ||
          dropSideAt(
            this.surface.getBoundingClientRect(),
            event.clientX,
            event.clientY,
          );
        this.clearDropPreview();
        this.actions.splitTabIntoPane(tabId, this.node.id, side);
      },
      true,
    );
    this.tabs.addEventListener(
      "dragover",
      (event) => {
        if (!isTabDrag(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
        showInsertionMarker(
          this.tabs,
          this.tabInsertionMarker,
          [...this.tabs.querySelectorAll<HTMLElement>(".terminal-tab")],
          "horizontal",
          event.clientX,
          event.clientY,
        );
        event.dataTransfer!.dropEffect = "move";
      },
      true,
    );
    this.tabs.addEventListener(
      "dragleave",
      (event) => {
        if (!isTabDrag(event.dataTransfer)) return;
        if (
          event.relatedTarget instanceof Node &&
          this.tabs.contains(event.relatedTarget)
        )
          return;
        clearInsertionMarker(this.tabs, this.tabInsertionMarker);
      },
      true,
    );
    this.tabs.addEventListener(
      "drop",
      (event) => {
        const tabId = readDraggedTab(event.dataTransfer);
        if (!tabId) return;
        event.preventDefault();
        event.stopPropagation();
        const targetIndex = Number(this.tabs.dataset.insertionIndex || 0);
        clearInsertionMarker(this.tabs, this.tabInsertionMarker);
        clearAllInsertionMarkers();
        this.actions.moveTabToPane(tabId, this.node.id, targetIndex);
      },
      true,
    );
    this.element.append(header, this.surface);

    this.element.addEventListener("pointerdown", () =>
      actions.focusPane(this.node.id),
    );
    this.element.addEventListener("focusin", () =>
      actions.focusPane(this.node.id),
    );
    this.element.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      actions.focusPane(this.node.id);
      this.menu.open(this.menuItems(), { x: event.clientX, y: event.clientY });
    });
  }

  update(node: PaneNode, focused: boolean) {
    this.node = node;
    this.setFocused(focused);
    const active = node.tabs.find((tab) => tab.id === node.activeTabId);
    this.shield.hidden = !this.actions.protectionAvailable() || !active;
    this.shield.disabled =
      active?.backend === "tmux" && active.connectionState !== "disconnected";
    this.shield.title =
      active?.backend === "tmux"
        ? active.connectionState === "disconnected"
          ? "Reconnect Protected Session"
          : "Protected Session\n\nThis terminal is backed by tmux and can survive extension host and editor restarts."
        : "Protect Session\n\nMove this idle terminal into a persistent session that survives extension host and editor restarts.";
    this.shield.setAttribute("aria-label", this.shield.title);
    this.add.disabled = node.tabs.length >= MAX_TABS_PER_PANE;
    this.add.title = this.add.disabled
      ? "Tab limit reached (9)"
      : "New Tab · ⌘T";
    const canSplit = this.actions.canSplitPane(node.id);
    for (const button of this.splitButtons) {
      button.disabled = !canSplit;
      button.title = canSplit
        ? button.getAttribute("aria-label")!
        : `Maximum split depth reached (${MAX_SPLIT_DEPTH})`;
    }
    const ids = new Set(node.tabs.map((tab) => tab.id));
    for (const [id, button] of this.tabButtons) {
      if (!ids.has(id)) {
        button.remove();
        this.tabButtons.delete(id);
        this.mounts.get(id)?.remove();
        this.mounts.delete(id);
      }
    }
    const buttons = node.tabs.map((tab, index) => {
      let button = this.tabButtons.get(tab.id);
      if (!button) {
        button = createControl({
          label: "",
          text: `⌘${index + 1}`,
          className: "terminal-tab",
          onClick: () => this.actions.activateTab(this.node.id, tab.id),
        });
        button.setAttribute("role", "tab");
        button.draggable = true;
        button.addEventListener("dblclick", () =>
          this.actions.closeTab(this.node.id, tab.id),
        );
        button.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          event.stopPropagation();
          this.actions.focusPane(this.node.id);
          this.menu.open(this.tabMenuItems(tab.id), {
            x: event.clientX,
            y: event.clientY,
          });
        });
        button.addEventListener(
          "click",
          (event) => {
            const target =
              event.target instanceof Element ? event.target : undefined;
            const current = this.node.tabs.find((item) => item.id === tab.id);
            if (
              current?.backend === "tmux" &&
              (current.degraded || current.displayState === "failed") &&
              target?.closest('[data-icon="shield"], [data-icon="refresh"]')
            ) {
              event.preventDefault();
              event.stopImmediatePropagation();
              this.actions.retryProtectedTab(this.node.id, tab.id);
            }
          },
          true,
        );
        button.addEventListener("dragstart", (event) => {
          clearAllDragIndicators();
          writeDraggedTab(event.dataTransfer, tab.id);
          if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
        });
        button.addEventListener("dragend", () => {
          clearAllDragIndicators();
        });
        this.tabButtons.set(tab.id, button);
      }
      const selected = tab.id === node.activeTabId;
      button.querySelector(".control__label")!.textContent = `⌘${index + 1}`;
      const protectedTab = tab.backend === "tmux";
      const indicator = button.querySelector('[data-icon="shield"]');
      if (protectedTab && !indicator) button.append(createIcon("shield"));
      if (!protectedTab) indicator?.remove();
      const refresh = button.querySelector('[data-icon="refresh"]');
      if (
        protectedTab &&
        (tab.degraded || tab.displayState === "failed") &&
        !refresh
      )
        button.append(createIcon("refresh"));
      if (
        (!protectedTab || (!tab.degraded && tab.displayState !== "failed")) &&
        refresh
      )
        refresh.remove();
      button.dataset.protection = tab.degraded
        ? "degraded"
        : protectedTab
          ? "on"
          : "off";
      button.title = protectedTab
        ? `Protected Session\n\n${tab.transport === "attach" ? "Native Attach Mode" : "Control Mode"}.${tab.degraded ? "\nProtection degraded to native tmux attach. History uses the tmux copy-mode buffer, and mouse input is managed by tmux. Click the shield to retry Control Mode." : ""}${tab.displayState === "failed" ? "\nDisplay refresh failed. Click refresh to retry." : ""}${tab.connectionState === "disconnected" ? "\nDisconnected. Right-click to reconnect." : ""}`
        : `Terminal ${index + 1} · ⌘${index + 1} · Double-click to close`;
      button.id = `tab-${tab.id}`;
      button.setAttribute(
        "aria-label",
        `${protectedTab ? "Protected " : ""}Terminal ${index + 1}`,
      );
      button.setAttribute("aria-selected", String(selected));
      button.setAttribute("aria-controls", `terminal-${tab.id}`);
      button.tabIndex = selected ? 0 : -1;
      button.onkeydown = (event) => {
        if (
          event.key === "ContextMenu" ||
          (event.shiftKey && event.key === "F10")
        ) {
          event.preventDefault();
          event.stopPropagation();
          const bounds = button!.getBoundingClientRect();
          this.menu.open(this.tabMenuItems(tab.id), {
            x: bounds.left,
            y: bounds.bottom,
          });
          return;
        }
        const offset =
          event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
        if (!offset) return;
        event.preventDefault();
        const next =
          this.node.tabs[
            (index + offset + this.node.tabs.length) % this.node.tabs.length
          ];
        this.actions.activateTab(this.node.id, next.id);
      };

      let mount = this.mounts.get(tab.id);
      if (!mount) {
        mount = document.createElement("div");
        mount.className = "terminal-mount";
        mount.id = `terminal-${tab.id}`;
        mount.setAttribute("role", "tabpanel");
        mount.setAttribute("aria-labelledby", button.id);
        this.mounts.set(tab.id, mount);
        this.surface.append(mount);
        this.terminals.mount(tab, mount);
      } else this.terminals.updateTab(tab);
      mount.hidden = !selected;
      return button;
    });
    reconcileChildren(this.tabs, [...buttons, this.tabInsertionMarker]);
    const selected = this.tabButtons.get(node.activeTabId || "");
    requestAnimationFrame(() =>
      selected?.scrollIntoView({ block: "nearest", inline: "nearest" }),
    );
  }

  setFocused(focused: boolean) {
    this.element.dataset.focused = String(focused);
  }

  private clearDropPreview() {
    delete this.surface.dataset.dropSide;
    delete this.surface.dataset.dropPreview;
  }

  private tabMenuItems(tabId: string): MenuItem[] {
    const tab = this.node.tabs.find((item) => item.id === tabId)!;
    const items: MenuItem[] = [];
    if (tab.backend === "tmux") {
      items.push({
        label:
          tab.connectionState === "disconnected"
            ? "Reconnect Protected Session"
            : "Protected Session",
        icon: "shield",
        disabled: tab.connectionState !== "disconnected",
        run: () => this.actions.protectTab(this.node.id, tab.id),
      });
      items.push({
        label: "Remove Protection",
        icon: "shield",
        separatorBefore: true,
        run: () => this.actions.unprotectTab(this.node.id, tab.id),
      });
    } else if (this.actions.protectionAvailable())
      items.push({
        label: "Protect Session",
        icon: "shield",
        run: () => this.actions.protectTab(this.node.id, tab.id),
      });
    items.push({
      label: "Close Tab",
      icon: "close",
      separatorBefore: items.length > 0,
      run: () => this.actions.closeTab(this.node.id, tab.id),
    });
    return items;
  }

  private menuItems(contextMenu = true): MenuItem[] {
    const id = this.node.id;
    const splitDisabled = !this.actions.canSplitPane(id);
    const items: MenuItem[] = [
      {
        label: "Split Up",
        disabled: splitDisabled,
        icon: "split-vertical",
        shortcut: "⌥⇧↑ / ⌥⇧T",
        run: () => this.actions.splitPane(id, "top"),
      },
      {
        label: "Split Down",
        disabled: splitDisabled,
        icon: "split-vertical",
        shortcut: "⌥⇧↓ / ⌥⇧D",
        run: () => this.actions.splitPane(id, "bottom"),
      },
      {
        label: "Split Left",
        disabled: splitDisabled,
        icon: "split-horizontal",
        shortcut: "⌥⇧← / ⌥⇧L",
        run: () => this.actions.splitPane(id, "left"),
      },
      {
        label: "Split Right",
        disabled: splitDisabled,
        icon: "split-horizontal",
        shortcut: "⌥⇧→ / ⌥⇧R",
        run: () => this.actions.splitPane(id, "right"),
      },
    ];
    if (contextMenu)
      items.push({
        label: "New Tab",
        icon: "add",
        shortcut: "⌘T",
        disabled: this.node.tabs.length >= MAX_TABS_PER_PANE,
        separatorBefore: true,
        run: () => this.actions.createTab(id),
      });
    items.push({
      label: "Copy Current Directory",
      icon: "copy",
      separatorBefore: true,
      run: () => this.actions.copyDirectory(id),
    });
    return items;
  }
}
