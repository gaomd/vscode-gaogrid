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
}
export interface TerminalTab {
  id: string;
  title: string;
  cwd: string;
  profile?: string;
  sessionId: string;
}
export interface PersistedState {
  workspaces: Workspace[];
  activeWorkspaceId: string;
}
