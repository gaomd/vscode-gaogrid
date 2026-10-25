import type { LayoutNode, PersistedState } from "../../model";
import { getNodeIds } from "../layout";
import { TerminalFrontend } from "../terminal-frontend";
import { createControl, reconcileChildren } from "./controls";
import { MenuController } from "./menu";
import { PaneView } from "./pane-view";
import { SplitView } from "./split-view";
import type { WorkspaceActions } from "./types";
import { WorkspaceRail } from "./workspace-rail";

/** Persistent view hierarchy: shell → rail/stage → split tree → pane. */
export class WorkspaceView {
  private readonly rail: WorkspaceRail;
  private readonly stage = document.createElement("main");
  private readonly panes = new Map<string, PaneView>();
  private readonly splits = new Map<string, SplitView>();
  private readonly menu = new MenuController();

  constructor(
    root: HTMLElement,
    private readonly actions: WorkspaceActions,
    private readonly terminals: TerminalFrontend,
  ) {
    root.className = "gaogrid";
    this.rail = new WorkspaceRail(actions);
    this.stage.id = "workspace-stage";
    this.stage.className = "workspace-stage";
    this.stage.setAttribute("role", "tabpanel");
    this.stage.setAttribute("aria-label", "Active workspace");
    root.append(this.rail.element, this.stage);
  }

  update(state: PersistedState) {
    this.menu.close();
    this.rail.update(state.workspaces, state.activeWorkspaceId);
    const active = state.workspaces.find(
      (workspace) => workspace.id === state.activeWorkspaceId,
    );
    if (active)
      this.stage.setAttribute("aria-labelledby", `workspace-${active.id}`);
    else this.stage.removeAttribute("aria-labelledby");
    const content = active?.root
      ? this.renderNode(active.root, active.focusedPaneId)
      : this.emptyState(!!active);
    reconcileChildren(this.stage, [content]);

    const liveIds = new Set(
      state.workspaces.flatMap((workspace) => getNodeIds(workspace.root)),
    );
    for (const [id, pane] of this.panes) {
      if (!liveIds.has(id)) {
        pane.element.remove();
        this.panes.delete(id);
      }
    }
    for (const [id, split] of this.splits) {
      if (!liveIds.has(id)) {
        split.dispose();
        this.splits.delete(id);
      }
    }
    this.terminals.scheduleFit();
  }

  setFocusedPane(id: string) {
    for (const [paneId, pane] of this.panes) pane.setFocused(paneId === id);
  }

  private renderNode(node: LayoutNode, focusedPaneId?: string): HTMLElement {
    if (node.type === "pane") {
      let pane = this.panes.get(node.id);
      if (!pane) {
        pane = new PaneView(node, this.actions, this.terminals, this.menu);
        this.panes.set(node.id, pane);
      }
      pane.update(node, node.id === focusedPaneId);
      return pane.element;
    }
    let split = this.splits.get(node.id);
    if (!split) {
      split = new SplitView(node, this.actions);
      this.splits.set(node.id, split);
    }
    split.update(
      node,
      this.renderNode(node.first, focusedPaneId),
      this.renderNode(node.second, focusedPaneId),
    );
    return split.element;
  }

  private emptyState(hasWorkspace: boolean) {
    const empty = document.createElement("section");
    empty.className = "empty-state";
    const description = document.createElement("p");
    description.className = "empty-state__description";
    description.textContent = hasWorkspace
      ? "This workspace has no terminals."
      : "Create a workspace to begin.";
    empty.append(
      description,
      createControl({
        label: hasWorkspace ? "New Tab · ⌘T" : "New Workspace · ⌘N",
        text: hasWorkspace ? "New Terminal" : "New Workspace",
        icon: "add",
        onClick: () =>
          hasWorkspace
            ? this.actions.createTab("")
            : this.actions.createWorkspace(),
      }),
    );
    return empty;
  }
}
