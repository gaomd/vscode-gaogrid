import type {
  LayoutNode,
  PaneNode,
  PersistedState,
  TerminalTab,
} from "../model";
import { MAX_SPLIT_DEPTH } from "./constants";

/** The initial pane has depth zero; each enclosing split adds one level. */
export function getPaneDepth(
  node: LayoutNode | null,
  paneId: string,
  depth = 0,
): number | undefined {
  if (!node) return undefined;
  if (node.type === "pane") return node.id === paneId ? depth : undefined;
  return (
    getPaneDepth(node.first, paneId, depth + 1) ??
    getPaneDepth(node.second, paneId, depth + 1)
  );
}

export function canSplitPane(node: LayoutNode | null, paneId: string): boolean {
  const depth = getPaneDepth(node, paneId);
  return depth !== undefined && depth < MAX_SPLIT_DEPTH;
}

export function getPanes(node: LayoutNode | null): PaneNode[] {
  if (!node) return [];
  return node.type === "pane"
    ? [node]
    : [...getPanes(node.first), ...getPanes(node.second)];
}

export function findNode(
  node: LayoutNode | null,
  id: string,
): LayoutNode | undefined {
  if (!node || node.id === id) return node || undefined;
  if (node.type === "pane") return undefined;
  return findNode(node.first, id) || findNode(node.second, id);
}

export function findPane(
  node: LayoutNode | null,
  id?: string,
): PaneNode | undefined {
  const match = id ? findNode(node, id) : undefined;
  return match?.type === "pane" ? match : undefined;
}

export function getTabs(node: LayoutNode | null): TerminalTab[] {
  return getPanes(node).flatMap((pane) => pane.tabs);
}

export function replaceNode(
  node: LayoutNode,
  id: string,
  replacement: LayoutNode,
): LayoutNode {
  if (node.id === id) return replacement;
  if (node.type === "pane") return node;
  return {
    ...node,
    first: replaceNode(node.first, id, replacement),
    second: replaceNode(node.second, id, replacement),
  };
}

export function removePane(
  node: LayoutNode | null,
  id: string,
): LayoutNode | null {
  if (!node) return null;
  if (node.type === "pane") return node.id === id ? null : node;
  const first = removePane(node.first, id);
  const second = removePane(node.second, id);
  if (!first) return second;
  if (!second) return first;
  return { ...node, first, second };
}

export function removeTabFromState(
  state: PersistedState,
  sessionId: string,
): TerminalTab | undefined {
  for (const workspace of state.workspaces) {
    const panes = getPanes(workspace.root);
    const pane = panes.find((item) =>
      item.tabs.some((tab) => tab.sessionId === sessionId),
    );
    if (!pane) continue;
    const tabIndex = pane.tabs.findIndex((tab) => tab.sessionId === sessionId);
    const [tab] = pane.tabs.splice(tabIndex, 1);
    if (pane.activeTabId === tab.id) {
      pane.activeTabId =
        pane.tabs[Math.min(tabIndex, pane.tabs.length - 1)]?.id || null;
      pane.lastKnownCwd =
        pane.tabs.find((item) => item.id === pane.activeTabId)?.cwd ||
        pane.lastKnownCwd;
    }
    if (!pane.tabs.length) {
      workspace.root = removePane(workspace.root, pane.id);
      const remaining = getPanes(workspace.root);
      if (workspace.focusedPaneId === pane.id)
        workspace.focusedPaneId =
          remaining[Math.min(panes.indexOf(pane), remaining.length - 1)]?.id;
    }
    if (!workspace.root && state.workspaces.length > 1) {
      const index = state.workspaces.indexOf(workspace);
      state.workspaces.splice(index, 1);
      state.workspaces.forEach((item, position) => {
        item.name = `^${position + 1}`;
      });
      if (state.activeWorkspaceId === workspace.id)
        state.activeWorkspaceId =
          state.workspaces[Math.min(index, state.workspaces.length - 1)]?.id ||
          "";
    }
    return tab;
  }
  return undefined;
}

export function getNodeIds(node: LayoutNode | null): string[] {
  if (!node) return [];
  return node.type === "pane"
    ? [node.id]
    : [node.id, ...getNodeIds(node.first), ...getNodeIds(node.second)];
}
