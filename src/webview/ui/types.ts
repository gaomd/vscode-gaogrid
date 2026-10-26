import type { WindowPresentation } from "../../terminal-protocol";

export interface WorkspaceActions {
  windowPresentation(): WindowPresentation;
  toggleWindow(): void;
  toggleSidebarSize(): void;
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
  moveTabToPane(
    tabId: string,
    targetPaneId: string,
    targetIndex?: number,
  ): void;
  splitTabIntoPane(tabId: string, targetPaneId: string, side: DropSide): void;
  moveTabToWorkspace(tabId: string, workspaceId: string): void;
  moveTabToNewWorkspace(tabId: string, targetIndex?: number): void;
  reorderWorkspace(workspaceId: string, targetIndex: number): void;
  canSplitPane(paneId: string): boolean;
  canSplitTabIntoPane(tabId: string, targetPaneId: string): boolean;
  splitPane(paneId: string, side: DropSide): void;
  resizeSplit(splitId: string, ratio: number, complete: boolean): void;
  copyDirectory(paneId: string): void;
}

export type DropSide = "left" | "right" | "top" | "bottom";
