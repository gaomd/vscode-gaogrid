import type { PaneNode } from "../../model";
import { createIcon } from "./icons";
import { MAX_TABS_PER_PANE } from "../constants";
import { TerminalFrontend } from "../terminal-frontend";
import { createControl, reconcileChildren } from "./controls";
import { MenuController, type MenuItem } from "./menu";
import type { WorkspaceActions } from "./types";

const TAB_DRAG_TYPE = "application/x-gaogrid-tab";

export class PaneView {
  readonly element = document.createElement("section");
  private readonly tabs = document.createElement("div");
  private readonly surface = document.createElement("div");
  private readonly tabButtons = new Map<string, HTMLButtonElement>();
  private readonly mounts = new Map<string, HTMLElement>();
  private readonly add: HTMLButtonElement;
  private readonly shield: HTMLButtonElement;
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
        "Protect Session\n\nMove this idle terminal into a persistent session that survives VS Code restarts.",
      icon: "shield",
      onClick: () => {
        if (this.node.activeTabId)
          actions.protectTab(this.node.id, this.node.activeTabId);
      },
    });
    tools.append(
      this.shield,
      createControl({
        label: "Split Horizontally",
        icon: "split-horizontal",
        className: "pane-header__split",
        onClick: () => actions.splitPane(this.node.id, "horizontal"),
      }),
      createControl({
        label: "Split Vertically",
        icon: "split-vertical",
        className: "pane-header__split",
        onClick: () => actions.splitPane(this.node.id, "vertical"),
      }),
    );
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
          : "Protected Session\n\nThis terminal is backed by tmux and can survive VS Code restarts."
        : "Protect Session\n\nMove this idle terminal into a persistent session that survives VS Code restarts.";
    this.shield.setAttribute("aria-label", this.shield.title);
    this.add.disabled = node.tabs.length >= MAX_TABS_PER_PANE;
    this.add.title = this.add.disabled
      ? "Tab limit reached (9)"
      : "New Tab · ⌘T";
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
        button.addEventListener("dragstart", (event) => {
          event.dataTransfer?.setData(TAB_DRAG_TYPE, tab.id);
        });
        button.addEventListener("dragover", (event) => {
          if (event.dataTransfer?.types.includes(TAB_DRAG_TYPE))
            event.preventDefault();
        });
        button.addEventListener("drop", (event) => {
          event.preventDefault();
          const id = event.dataTransfer?.getData(TAB_DRAG_TYPE);
          if (id) this.actions.reorderTab(this.node.id, id, tab.id);
        });
        this.tabButtons.set(tab.id, button);
      }
      const selected = tab.id === node.activeTabId;
      button.querySelector(".control__label")!.textContent = `⌘${index + 1}`;
      const protectedTab = tab.backend === "tmux";
      const indicator = button.querySelector('[data-icon="shield"]');
      if (protectedTab && !indicator) button.prepend(createIcon("shield"));
      if (!protectedTab) indicator?.remove();
      button.title = protectedTab
        ? `Protected Session\n\nThis terminal is backed by tmux and can survive VS Code restarts.${tab.connectionState === "disconnected" ? "\nDisconnected. Right-click to reconnect." : ""}`
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
      }
      mount.hidden = !selected;
      return button;
    });
    reconcileChildren(this.tabs, buttons);
    const selected = this.tabButtons.get(node.activeTabId || "");
    requestAnimationFrame(() =>
      selected?.scrollIntoView({ block: "nearest", inline: "nearest" }),
    );
  }

  setFocused(focused: boolean) {
    this.element.dataset.focused = String(focused);
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
    const items: MenuItem[] = [
      {
        label: "Copy Current Directory",
        icon: "copy",
        separatorBefore: contextMenu,
        run: () => this.actions.copyDirectory(id),
      },
    ];
    if (contextMenu)
      items.unshift(
        {
          label: "Split Vertically",
          icon: "split-vertical",
          run: () => this.actions.splitPane(id, "vertical"),
        },
        {
          label: "Split Horizontally",
          icon: "split-horizontal",
          run: () => this.actions.splitPane(id, "horizontal"),
        },
        {
          label: "New Tab",
          icon: "add",
          shortcut: "⌘T",
          disabled: this.node.tabs.length >= MAX_TABS_PER_PANE,
          separatorBefore: true,
          run: () => this.actions.createTab(id),
        },
      );
    return items;
  }
}
