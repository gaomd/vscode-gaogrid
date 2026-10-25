import type { SplitNode } from "../../model";

export interface WorkspaceActions {
  createWorkspace(): void;
  activateWorkspace(workspaceId: string): void;
  closeWorkspace(workspaceId: string): void;
  focusPane(paneId: string): void;
  createTab(paneId: string): void;
  protectionAvailable(): boolean;
  protectTab(paneId: string, tabId: string): void;
  unprotectTab(paneId: string, tabId: string): void;
  activateTab(paneId: string, tabId: string): void;
  closeTab(paneId: string, tabId: string): void;
  reorderTab(paneId: string, tabId: string, targetTabId: string): void;
  splitPane(paneId: string, direction: SplitNode["direction"]): void;
  resizeSplit(splitId: string, ratio: number, complete: boolean): void;
  copyDirectory(paneId: string): void;
}
