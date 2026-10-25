import type { Workspace } from "../../model";
import { MAX_WORKSPACES } from "../constants";
import { createControl, reconcileChildren } from "./controls";
import type { WorkspaceActions } from "./types";

export class WorkspaceRail {
  readonly element = document.createElement("nav");
  private readonly list = document.createElement("div");
  private readonly buttons = new Map<string, HTMLButtonElement>();
  private readonly add: HTMLButtonElement;

  constructor(private readonly actions: WorkspaceActions) {
    this.element.className = "workspace-rail";
    this.element.setAttribute("aria-label", "Workspaces");
    this.list.className = "workspace-rail__list";
    this.list.setAttribute("role", "tablist");
    this.list.setAttribute("aria-label", "Workspaces");
    this.list.setAttribute("aria-orientation", "vertical");
    this.add = createControl({
      label: "New Workspace · ⌘N",
      icon: "add",
      className: "workspace-rail__add",
      onClick: () => actions.createWorkspace(),
    });
    this.element.append(this.list, this.add);
  }

  update(workspaces: Workspace[], activeId: string) {
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
    reconcileChildren(this.list, children);
    this.add.disabled = workspaces.length >= MAX_WORKSPACES;
    this.add.title = this.add.disabled
      ? "Workspace limit reached (9)"
      : "New Workspace · ⌘N";
  }
}
