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
    const footer = document.createElement("div");
    footer.className = "workspace-rail__footer";
    footer.append(this.windowButton, this.maximizeButton);
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
}
