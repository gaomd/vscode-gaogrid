import type {
  PaneNode,
  PersistedState,
  SplitNode,
  TerminalTab,
  Workspace,
} from "../model";
import { MAX_TABS_PER_PANE, MAX_WORKSPACES } from "./constants";
import {
  findNode,
  findPane,
  getPanes,
  getTabs,
  removePane,
  replaceNode,
} from "./layout";
import { TerminalFrontend } from "./terminal-frontend";
import { WorkspaceView } from "./ui/workspace-view";
import type { WorkspaceActions } from "./ui/types";

interface WorkspaceBridge {
  send(message: unknown): void;
  persist(state: PersistedState): void;
}

const id = () => crypto.randomUUID();
const makeTab = (): TerminalTab => ({
  id: id(),
  title: "terminal",
  cwd: "",
  sessionId: id(),
});
const makePane = (): PaneNode => {
  const tab = makeTab();
  return { type: "pane", id: id(), activeTabId: tab.id, tabs: [tab] };
};

/** Coordinates workspace state and UI intent; the view never persists state. */
export class WorkspaceController {
  private state: PersistedState = { workspaces: [], activeWorkspaceId: "" };
  private readonly view: WorkspaceView;

  constructor(
    root: HTMLElement,
    private readonly terminals: TerminalFrontend,
    private readonly bridge: WorkspaceBridge,
  ) {
    const actions: WorkspaceActions = {
      createWorkspace: () => this.createWorkspace(),
      activateWorkspace: (workspaceId) => this.activateWorkspace(workspaceId),
      closeWorkspace: (workspaceId) => this.closeWorkspace(workspaceId),
      focusPane: (paneId) => this.focusPane(paneId),
      createTab: (paneId) => this.createTab(paneId),
      activateTab: (paneId, tabId) => this.activateTab(paneId, tabId),
      closeTab: (paneId, tabId) => this.closeTab(paneId, tabId),
      reorderTab: (paneId, tabId, targetId) =>
        this.reorderTab(paneId, tabId, targetId),
      splitPane: (paneId, direction) => this.splitPane(paneId, direction),
      resizeSplit: (splitId, ratio, complete) =>
        this.resizeSplit(splitId, ratio, complete),
      copyDirectory: (paneId) => {
        const tab = this.activeTab(paneId);
        if (tab)
          this.bridge.send({ type: "copyCwd", sessionId: tab.sessionId });
      },
    };
    this.view = new WorkspaceView(root, actions, terminals);
  }

  restore(state: PersistedState) {
    this.state = state;
    if (!state.workspaces.length) {
      this.createWorkspace();
      return;
    }
    if (!this.workspace()) state.activeWorkspaceId = state.workspaces[0].id;
    this.renumberWorkspaces();
    this.commit(false);
  }

  performAction(action: string, index?: number) {
    if (
      ["increaseFontSize", "decreaseFontSize", "resetFontSize"].includes(action)
    ) {
      const pane = this.focusedPane();
      const tab = pane?.tabs.find((item) => item.id === pane.activeTabId);
      if (!tab) return;
      if (action === "resetFontSize") this.terminals.resetFontSize(tab.id);
      else
        this.terminals.adjustFontSize(
          tab.id,
          action === "increaseFontSize" ? 1 : -1,
        );
      this.terminals.focus(tab.id);
      return;
    }
    if (action === "newWorkspace") this.createWorkspace();
    else if (action === "newTab") this.createTab();
    else if (action === "closeTab") {
      const pane = this.focusedPane();
      const tab = pane?.tabs.find((item) => item.id === pane.activeTabId);
      if (pane && tab) this.closeTab(pane.id, tab.id);
    } else if (action === "switchWorkspace") {
      const workspace = this.state.workspaces[(index || 0) - 1];
      if (workspace) this.activateWorkspace(workspace.id);
    } else if (action === "switchTab") {
      const pane = this.focusedPane();
      const tab = pane?.tabs[(index || 0) - 1];
      if (pane && tab) this.activateTab(pane.id, tab.id);
    }
  }

  private workspace(): Workspace | undefined {
    return this.state.workspaces.find(
      (workspace) => workspace.id === this.state.activeWorkspaceId,
    );
  }

  private focusedPane(): PaneNode | undefined {
    const workspace = this.workspace();
    return (
      workspace &&
      (findPane(workspace.root, workspace.focusedPaneId) ||
        getPanes(workspace.root)[0])
    );
  }

  private activeTab(paneId: string) {
    const pane = findPane(this.workspace()?.root || null, paneId);
    return pane?.tabs.find((tab) => tab.id === pane.activeTabId);
  }

  private commit(focusTerminal = true) {
    const workspace = this.workspace();
    const pane = this.focusedPane();
    if (workspace) workspace.focusedPaneId = pane?.id;
    this.bridge.persist(this.state);
    this.view.update(this.state);
    const tab = pane?.tabs.find((item) => item.id === pane.activeTabId);
    if (focusTerminal && tab) this.terminals.focus(tab.id);
  }

  private focusPane(paneId: string) {
    const workspace = this.workspace();
    if (!workspace || !findPane(workspace.root, paneId)) return;
    if (workspace.focusedPaneId !== paneId) {
      workspace.focusedPaneId = paneId;
      this.bridge.persist(this.state);
    }
    this.view.setFocusedPane(paneId);
  }

  private createWorkspace() {
    if (this.state.workspaces.length >= MAX_WORKSPACES) return;
    const pane = makePane();
    const workspace: Workspace = {
      id: id(),
      name: `^${this.state.workspaces.length + 1}`,
      root: pane,
      focusedPaneId: pane.id,
    };
    this.state.workspaces.push(workspace);
    this.state.activeWorkspaceId = workspace.id;
    this.commit();
    this.startTab(pane.tabs[0]);
  }

  private activateWorkspace(workspaceId: string) {
    if (
      !this.state.workspaces.some((workspace) => workspace.id === workspaceId)
    )
      return;
    this.state.activeWorkspaceId = workspaceId;
    this.commit();
  }

  private closeWorkspace(workspaceId: string) {
    const index = this.state.workspaces.findIndex(
      (workspace) => workspace.id === workspaceId,
    );
    const workspace = this.state.workspaces[index];
    if (!workspace) return;
    getTabs(workspace.root).forEach((tab) => this.disposeTab(tab));
    this.state.workspaces.splice(index, 1);
    this.renumberWorkspaces();
    if (this.state.activeWorkspaceId === workspaceId) {
      this.state.activeWorkspaceId =
        this.state.workspaces[Math.min(index, this.state.workspaces.length - 1)]
          ?.id || "";
    }
    if (!this.state.workspaces.length) this.createWorkspace();
    else this.commit();
  }

  private createTab(paneId?: string) {
    const workspace = this.workspace();
    if (!workspace) {
      this.createWorkspace();
      return;
    }
    let pane = findPane(workspace.root, paneId) || this.focusedPane();
    if (!pane) {
      pane = makePane();
      workspace.root = pane;
      workspace.focusedPaneId = pane.id;
      this.commit();
      this.startTab(pane.tabs[0]);
      return;
    }
    if (pane.tabs.length >= MAX_TABS_PER_PANE) return;
    const tab = makeTab();
    pane.tabs.push(tab);
    pane.activeTabId = tab.id;
    workspace.focusedPaneId = pane.id;
    this.commit();
    this.startTab(tab);
  }

  private activateTab(paneId: string, tabId: string) {
    const workspace = this.workspace();
    const pane = findPane(workspace?.root || null, paneId);
    if (!workspace || !pane || !pane.tabs.some((tab) => tab.id === tabId))
      return;
    pane.activeTabId = tabId;
    workspace.focusedPaneId = paneId;
    this.commit();
  }

  private closeTab(paneId: string, tabId: string) {
    const workspace = this.workspace();
    const pane = findPane(workspace?.root || null, paneId);
    if (!workspace || !pane) return;
    const index = pane.tabs.findIndex((tab) => tab.id === tabId);
    if (index < 0) return;
    const [tab] = pane.tabs.splice(index, 1);
    this.disposeTab(tab);
    if (pane.activeTabId === tabId)
      pane.activeTabId =
        pane.tabs[Math.min(index, pane.tabs.length - 1)]?.id || null;
    if (!pane.tabs.length) {
      const paneIndex = getPanes(workspace.root).findIndex(
        (item) => item.id === paneId,
      );
      workspace.root = removePane(workspace.root, paneId);
      const remaining = getPanes(workspace.root);
      workspace.focusedPaneId =
        remaining[Math.min(paneIndex, remaining.length - 1)]?.id;
    }
    this.commit();
  }

  private reorderTab(paneId: string, tabId: string, targetId: string) {
    const pane = findPane(this.workspace()?.root || null, paneId);
    if (!pane || tabId === targetId) return;
    const from = pane.tabs.findIndex((tab) => tab.id === tabId);
    const to = pane.tabs.findIndex((tab) => tab.id === targetId);
    if (from < 0 || to < 0) return;
    const [tab] = pane.tabs.splice(from, 1);
    pane.tabs.splice(to, 0, tab);
    this.commit();
  }

  private splitPane(paneId: string, direction: SplitNode["direction"]) {
    const workspace = this.workspace();
    const pane = findPane(workspace?.root || null, paneId);
    if (!workspace?.root || !pane) return;
    const fresh = makePane();
    const split: SplitNode = {
      type: "split",
      id: id(),
      direction,
      ratio: 0.5,
      first: pane,
      second: fresh,
    };
    workspace.root = replaceNode(workspace.root, pane.id, split);
    workspace.focusedPaneId = fresh.id;
    this.commit();
    this.startTab(fresh.tabs[0]);
  }

  private resizeSplit(splitId: string, ratio: number, complete: boolean) {
    const node = findNode(this.workspace()?.root || null, splitId);
    if (node?.type !== "split") return;
    node.ratio = ratio;
    this.terminals.scheduleFit();
    if (complete) this.bridge.persist(this.state);
  }

  private renumberWorkspaces() {
    this.state.workspaces.forEach((workspace, index) => {
      workspace.name = `^${index + 1}`;
    });
  }

  private startTab(tab: TerminalTab) {
    this.bridge.send({
      type: "start",
      sessionId: tab.sessionId,
      cwd: tab.cwd,
      profile: tab.profile,
    });
  }

  private disposeTab(tab: TerminalTab) {
    this.bridge.send({ type: "close", sessionId: tab.sessionId });
    this.terminals.disposeTab(tab);
  }
}
