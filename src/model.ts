export interface Workspace {
  id: string;
  name: string;
  root: LayoutNode | null;
  focusedPaneId?: string;
}
export type LayoutNode = PaneNode | SplitNode;
export interface SplitNode {
  type: "split";
  id: string;
  direction: "horizontal" | "vertical";
  ratio: number;
  first: LayoutNode;
  second: LayoutNode;
}
export interface PaneNode {
  type: "pane";
  id: string;
  activeTabId: string | null;
  tabs: TerminalTab[];
  lastKnownCwd?: string;
}
export type TerminalBackendType = "direct" | "tmux";
export interface TerminalTab {
  id: string;
  title: string;
  cwd: string;
  profile?: string;
  sessionId: string;
  backend: TerminalBackendType;
  backendSessionId?: string;
  createdAt?: number;
  updatedAt?: number;
  connectionState?: "connected" | "disconnected";
}
export interface PersistedState {
  workspaces: Workspace[];
  activeWorkspaceId: string;
}
