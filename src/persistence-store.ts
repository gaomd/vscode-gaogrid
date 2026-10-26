import type { LayoutNode, PersistedState, TerminalTab } from "./model";

export const STATE_KEY = "gaogrid.state.v2";
export const LEGACY_STATE_KEY = "gaogrid.state.v1";
// Keep older, deeper layouts intact. New splits enforce their product limit
// separately; recovery's bound only guards malformed or excessive input.
const MAX_RESTORE_DEPTH = 64;

/** Copy and validate saved layout metadata; never recover executable commands. */
export function restoreState(saved: unknown): PersistedState {
  const value = saved as Partial<PersistedState> | undefined;
  const workspaces = Array.isArray(value?.workspaces)
    ? value.workspaces.flatMap((workspace) => {
        if (!workspace || typeof workspace.id !== "string") return [];
        return [
          {
            id: workspace.id,
            name:
              typeof workspace.name === "string" ? workspace.name : "Workspace",
            focusedPaneId: workspace.focusedPaneId,
            root: restoreNode(workspace.root),
          },
        ];
      })
    : [];
  return {
    workspaces,
    activeWorkspaceId: workspaces.some(
      (item) => item.id === value?.activeWorkspaceId,
    )
      ? value!.activeWorkspaceId!
      : workspaces[0]?.id || "",
  };
}

function restoreNode(value: unknown, depth = 0): LayoutNode | null {
  if (!value || typeof value !== "object" || depth > MAX_RESTORE_DEPTH)
    return null;
  const node = value as LayoutNode;
  if (typeof node.id !== "string") return null;
  if (node.type === "split") {
    const first = restoreNode(node.first, depth + 1);
    const second = restoreNode(node.second, depth + 1);
    if (!first || !second) return first || second;
    return {
      type: "split",
      id: node.id,
      direction: node.direction === "vertical" ? "vertical" : "horizontal",
      ratio: Number.isFinite(node.ratio)
        ? Math.max(0.12, Math.min(0.88, node.ratio))
        : 0.5,
      first,
      second,
    };
  }
  if (node.type !== "pane") return null;
  const tabs: TerminalTab[] = Array.isArray(node.tabs)
    ? node.tabs.flatMap((tab) => {
        if (
          !tab ||
          typeof tab.id !== "string" ||
          typeof tab.sessionId !== "string"
        )
          return [];
        return [
          {
            id: tab.id,
            sessionId: tab.sessionId,
            title: typeof tab.title === "string" ? tab.title : "terminal",
            cwd: typeof tab.cwd === "string" ? tab.cwd : "",
            profile: typeof tab.profile === "string" ? tab.profile : undefined,
            backend: tab.backend === "tmux" ? "tmux" : "direct",
            backendSessionId:
              tab.backend === "tmux" && typeof tab.backendSessionId === "string"
                ? tab.backendSessionId
                : undefined,
            createdAt:
              typeof tab.createdAt === "number" ? tab.createdAt : undefined,
            updatedAt:
              typeof tab.updatedAt === "number" ? tab.updatedAt : undefined,
          },
        ];
      })
    : [];
  return {
    type: "pane",
    id: node.id,
    tabs,
    activeTabId: tabs.some((tab) => tab.id === node.activeTabId)
      ? node.activeTabId
      : tabs[0]?.id || null,
    lastKnownCwd:
      typeof node.lastKnownCwd === "string" ? node.lastKnownCwd : undefined,
  };
}
