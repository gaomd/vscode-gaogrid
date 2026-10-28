import type {
  PaneNode,
  PersistedState,
  SplitNode,
  TerminalTab,
  Workspace,
} from "../model";
import { MAX_TABS_PER_PANE, MAX_WORKSPACES } from "./constants";
import {
  canSplitPane,
  findAdjacentPane,
  distributePanes,
  findNode,
  findPane,
  findPaneAfterRemoval,
  findParentSplit,
  getPanes,
  getTabs,
  removeTabFromState,
  removePane,
  replaceNode,
  type PaneDirection,
} from "./layout";
import { TerminalFrontend } from "./terminal-frontend";
import { WorkspaceView } from "./ui/workspace-view";
import type { DropSide, WorkspaceActions } from "./ui/types";
import type {
  CloseScope,
  LifecycleRequest,
  LifecycleResult,
  TerminalMetadata,
  NewTerminalOptions,
  BackendCapabilities,
  WindowPresentation,
  TerminalPreferences,
} from "../terminal-protocol";

interface WorkspaceBridge {
  send(message: unknown): void;
  persist(state: PersistedState): void;
  request(request: LifecycleRequest): Promise<LifecycleResult>;
}

interface TabLocation {
  workspace: Workspace;
  pane: PaneNode;
  tab: TerminalTab;
}

const id = () => crypto.randomUUID();
const makeTab = (cwd: string): TerminalTab => ({
  id: id(),
  title: "terminal",
  cwd,
  sessionId: id(),
  backend: "direct",
});
const makePane = (cwd: string): PaneNode => {
  const tab = makeTab(cwd);
  return {
    type: "pane",
    id: id(),
    activeTabId: tab.id,
    tabs: [tab],
    lastKnownCwd: cwd,
  };
};

/** Coordinates workspace state and UI intent; the view never persists state. */
export class WorkspaceController {
  private state: PersistedState = { workspaces: [], activeWorkspaceId: "" };
  private readonly view: Pick<WorkspaceView, "update" | "setFocusedPane">;
  private capabilities: BackendCapabilities = { tmux: { available: false } };
  private preferences: TerminalPreferences = {
    defaultProtected: false,
    transport: "control",
    tmuxMouse: true,
    mousePolicy: "application",
  };
  private presentation: WindowPresentation = {
    mode: "sidebar",
    canDetach: false,
    canMaximize: false,
    transitioning: false,
  };
  private mutations: Promise<void> = Promise.resolve();
  private lastDistribution?: {
    workspaceId: string;
    paneId: string;
    time: number;
  };

  // Serialize lifecycle mutations; switching/focusing terminals stays immediate.
  private enqueue(operation: () => Promise<void>) {
    this.mutations = this.mutations.then(operation).catch((error) => {
      this.bridge.send({ type: "lifecycleError", message: String(error) });
    });
  }

  constructor(
    private readonly root: HTMLElement,
    private readonly terminals: TerminalFrontend,
    private readonly bridge: WorkspaceBridge,
    createView = (
      root: HTMLElement,
      actions: WorkspaceActions,
      terminals: TerminalFrontend,
    ): Pick<WorkspaceView, "update" | "setFocusedPane"> =>
      new WorkspaceView(root, actions, terminals),
  ) {
    const actions: WorkspaceActions = {
      windowPresentation: () => this.presentation,
      toggleWindow: () => this.bridge.send({ type: "toggleWindow" }),
      toggleSidebarSize: () => this.bridge.send({ type: "toggleSidebarSize" }),
      createWorkspace: () => this.createWorkspace(),
      activateWorkspace: (workspaceId) => this.activateWorkspace(workspaceId),
      closeWorkspace: (workspaceId) => this.closeWorkspace(workspaceId),
      focusPane: (paneId) => this.focusPane(paneId),
      createTab: (paneId) => this.createTab(paneId),
      protectionAvailable: () =>
        this.capabilities.tmux.available &&
        this.capabilities.tmux.supported !== false,
      terminalPreferences: () => this.preferences,
      updatePreferences: (preferences) => {
        this.preferences = preferences;
        this.view.update(this.state);
        this.bridge.send({ type: "preferences", preferences });
      },
      protectTab: (paneId, tabId) => this.protectTab(paneId, tabId),
      retryProtectedTab: (paneId, tabId) =>
        this.retryProtectedTab(paneId, tabId),
      unprotectTab: (paneId, tabId) => this.unprotectTab(paneId, tabId),
      activateTab: (paneId, tabId) => this.activateTab(paneId, tabId),
      closeTab: (paneId, tabId) => this.closeTabs(paneId, tabId),
      moveTabToPane: (tabId, paneId, targetIndex) =>
        this.moveTabToPane(tabId, paneId, targetIndex),
      splitTabIntoPane: (tabId, paneId, side) =>
        this.splitTabIntoPane(tabId, paneId, side),
      moveTabToWorkspace: (tabId, workspaceId) =>
        this.moveTabToWorkspace(tabId, workspaceId),
      moveTabToNewWorkspace: (tabId, targetIndex) =>
        this.moveTabToNewWorkspace(tabId, targetIndex),
      reorderWorkspace: (workspaceId, targetIndex) =>
        this.reorderWorkspace(workspaceId, targetIndex),
      canSplitPane: (paneId) =>
        this.state.workspaces.some((workspace) =>
          canSplitPane(workspace.root, paneId),
        ),
      canSplitTabIntoPane: (tabId, paneId) =>
        this.canSplitTabIntoPane(tabId, paneId),
      splitPane: (paneId, side) => this.splitPane(paneId, side),
      resizeSplit: (splitId, ratio, complete) =>
        this.resizeSplit(splitId, ratio, complete),
      copyDirectory: (paneId) => {
        const tab = this.activeTab(paneId);
        if (tab)
          this.bridge.send({ type: "copyCwd", sessionId: tab.sessionId });
      },
    };
    this.view = createView(root, actions, terminals);
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

  setCapabilities(capabilities: BackendCapabilities) {
    this.capabilities = capabilities;
    this.view.update(this.state);
  }

  setPresentation(presentation: WindowPresentation) {
    const wasTransitioning = this.presentation.transitioning;
    this.presentation = presentation;
    this.root.inert = presentation.transitioning;
    this.view.update(this.state);
    if (wasTransitioning && !presentation.transitioning) {
      const pane = this.focusedPane();
      if (pane?.activeTabId) this.terminals.focus(pane.activeTabId);
    }
  }

  setPreferences(preferences: TerminalPreferences) {
    this.preferences = preferences;
    this.view.update(this.state);
  }

  async preparePresentation(): Promise<PersistedState> {
    await this.mutations;
    return this.state;
  }

  canToggleSidebarSize() {
    return (
      this.presentation.mode === "sidebar" &&
      this.presentation.canMaximize &&
      !this.presentation.transitioning
    );
  }

  canToggleWindow() {
    return (
      !this.presentation.transitioning &&
      (this.presentation.canDetach || this.presentation.mode === "window")
    );
  }

  updateTerminal(sessionId: string, metadata: TerminalMetadata) {
    for (const workspace of this.state.workspaces)
      for (const pane of getPanes(workspace.root)) {
        const tab = pane.tabs.find((item) => item.sessionId === sessionId);
        if (!tab) continue;
        const changed =
          tab.backend !== metadata.backend ||
          tab.connectionState !== metadata.connectionState ||
          tab.transport !== metadata.transport ||
          tab.degraded !== metadata.degraded ||
          tab.displayState !== metadata.displayState;
        Object.assign(tab, {
          cwd: metadata.cwd,
          profile: metadata.profile,
          backend: metadata.backend,
          backendSessionId: metadata.backendSessionId,
          createdAt: metadata.createdAt,
          updatedAt: metadata.updatedAt,
          connectionState: metadata.connectionState,
          transport: metadata.transport,
          degraded: metadata.degraded,
          displayState: metadata.displayState,
        });
        if (changed) this.view.update(this.state);
        if (pane.activeTabId === tab.id) pane.lastKnownCwd = metadata.cwd;
      }
  }

  performAction(action: string, index?: number, options?: NewTerminalOptions) {
    if (action !== "distributePanes") this.lastDistribution = undefined;
    if (action === "distributePanes" || action === "distributeWorkspacePanes") {
      const workspace = this.workspace();
      const pane = this.focusedPane();
      if (!workspace || !pane) return;
      const time = performance.now();
      const all =
        action === "distributeWorkspacePanes" ||
        (this.lastDistribution?.workspaceId === workspace.id &&
          this.lastDistribution.paneId === pane.id &&
          time - this.lastDistribution.time <= 400);
      this.lastDistribution = all
        ? undefined
        : { workspaceId: workspace.id, paneId: pane.id, time };
      this.enqueue(async () => {
        if (!this.state.workspaces.includes(workspace) || !workspace.root)
          return;
        const target = all
          ? workspace.root
          : findParentSplit(workspace.root, pane.id);
        if (!target || target.type === "pane") return;
        distributePanes(target, all);
        this.commit();
      });
      return;
    }
    const direction = (
      {
        focusPaneUp: "up",
        focusPaneDown: "down",
        focusPaneLeft: "left",
        focusPaneRight: "right",
      } as Partial<Record<string, PaneDirection>>
    )[action];
    if (direction) {
      const workspace = this.workspace();
      const pane = this.focusedPane();
      const target =
        workspace &&
        pane &&
        findAdjacentPane(workspace.root, pane.id, direction);
      if (target) {
        this.focusPane(target.id);
        if (target.activeTabId) this.terminals.focus(target.activeTabId);
      }
      return;
    }
    if (action === "focusTerminal") {
      const pane = this.focusedPane();
      if (!this.presentation.transitioning && pane?.activeTabId)
        this.terminals.focus(pane.activeTabId);
      return;
    }
    if (action === "toggleWindow") {
      if (this.canToggleWindow()) this.bridge.send({ type: "toggleWindow" });
      return;
    }
    if (action === "toggleSidebarSize") {
      if (this.canToggleSidebarSize())
        this.bridge.send({ type: "toggleSidebarSize" });
      return;
    }
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
    if (
      action === "splitUp" ||
      action === "splitDown" ||
      action === "splitLeft" ||
      action === "splitRight"
    ) {
      const pane = this.focusedPane();
      const side =
        action === "splitUp"
          ? "top"
          : action === "splitDown"
            ? "bottom"
            : action === "splitLeft"
              ? "left"
              : "right";
      if (pane) this.splitPane(pane.id, side);
    } else if (action === "newWorkspace") this.createWorkspace();
    else if (action === "newTab") this.createTab(undefined, options);
    else if (action === "closeTab") {
      const pane = this.focusedPane();
      const tab = pane?.tabs.find((item) => item.id === pane.activeTabId);
      if (pane && tab) this.closeTabs(pane.id, tab.id);
    } else if (action === "closePane") {
      const pane = this.focusedPane();
      if (pane) this.closeTabs(pane.id);
    } else if (action === "switchWorkspace") {
      const workspace = this.state.workspaces[(index || 0) - 1];
      if (workspace) this.activateWorkspace(workspace.id);
    } else if (action === "switchTab") {
      const pane = this.focusedPane();
      const tab = pane?.tabs[(index || 0) - 1];
      if (pane && tab) this.activateTab(pane.id, tab.id);
    } else if (action === "previousTab" || action === "nextTab") {
      const pane = this.focusedPane();
      if (!pane?.tabs.length) return;
      const current = pane.tabs.findIndex((tab) => tab.id === pane.activeTabId);
      const direction = action === "nextTab" ? 1 : -1;
      const next =
        current < 0
          ? 0
          : (current + direction + pane.tabs.length) % pane.tabs.length;
      this.activateTab(pane.id, pane.tabs[next].id);
    }
  }

  resetDistributionShortcut() {
    this.lastDistribution = undefined;
  }

  sessionEnded(sessionId: string) {
    this.enqueue(async () => {
      const tab = removeTabFromState(this.state, sessionId);
      if (!tab) return;
      this.terminals.disposeTab(tab);
      this.commit();
    });
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
    this.bridge.send({
      type: "activeTerminal",
      sessionId: tab?.sessionId,
    });
    if (focusTerminal && tab) this.terminals.focus(tab.id);
  }

  private focusPane(paneId: string) {
    const workspace = this.workspace();
    if (!workspace || !findPane(workspace.root, paneId)) return;
    if (workspace.focusedPaneId !== paneId) {
      this.resetDistributionShortcut();
      workspace.focusedPaneId = paneId;
      this.bridge.persist(this.state);
    }
    this.view.setFocusedPane(paneId);
  }

  private createWorkspace() {
    this.enqueue(() => this.addWorkspace());
  }

  private async addWorkspace() {
    if (this.state.workspaces.length >= MAX_WORKSPACES) return;
    const cwd = await this.resolveDirectory();
    const pane = makePane(cwd);
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
    this.resetDistributionShortcut();
    this.state.activeWorkspaceId = workspaceId;
    this.commit();
  }

  private closeWorkspace(workspaceId: string) {
    this.enqueue(async () => {
      const index = this.state.workspaces.findIndex(
        (workspace) => workspace.id === workspaceId,
      );
      const workspace = this.state.workspaces[index];
      if (!workspace) return;
      const tabs = getTabs(workspace.root);
      if (!(await this.requestClose(tabs, "workspace", workspace.name))) return;
      tabs.forEach((tab) => this.terminals.disposeTab(tab));
      this.state.workspaces.splice(index, 1);
      this.renumberWorkspaces();
      if (this.state.activeWorkspaceId === workspaceId) {
        this.state.activeWorkspaceId =
          this.state.workspaces[
            Math.min(index, this.state.workspaces.length - 1)
          ]?.id || "";
      }
      if (!this.state.workspaces.length) await this.addWorkspace();
      else this.commit();
    });
  }

  private createTab(paneId?: string, options?: NewTerminalOptions) {
    const workspace = this.workspace();
    const sourcePaneId = paneId || this.focusedPane()?.id;
    this.enqueue(async () => {
      if (!workspace) {
        await this.addWorkspace();
        return;
      }
      if (!this.state.workspaces.includes(workspace)) return;
      let pane =
        findPane(workspace.root, sourcePaneId) ||
        (!sourcePaneId ? getPanes(workspace.root)[0] : undefined);
      if (sourcePaneId && !pane) return;
      if (pane && pane.tabs.length >= MAX_TABS_PER_PANE) return;
      const cwd = await this.resolveDirectory(pane, options?.cwd);
      if (!pane) {
        pane = makePane(cwd);
        pane.tabs[0].profile = options?.profile;
        pane.tabs[0].backend = options?.backend || "direct";
        workspace.root = pane;
        workspace.focusedPaneId = pane.id;
        this.commit();
        this.startTab(pane.tabs[0]);
        return;
      }
      const tab = makeTab(cwd);
      tab.profile = options?.profile;
      tab.backend = options?.backend || "direct";
      pane.tabs.push(tab);
      pane.activeTabId = tab.id;
      pane.lastKnownCwd = cwd;
      workspace.focusedPaneId = pane.id;
      this.commit();
      this.startTab(tab);
    });
  }

  private protectTab(paneId: string, tabId: string) {
    this.enqueue(async () => {
      const workspace = this.state.workspaces.find((item) =>
        findPane(item.root, paneId),
      );
      const pane = findPane(workspace?.root || null, paneId);
      const source = pane?.tabs.find((tab) => tab.id === tabId);
      if (!workspace || !pane || !source) return;
      const value = await this.bridge.request(
        source.backend === "tmux"
          ? { kind: "reconnect", sessionId: source.sessionId }
          : {
              kind: "protect",
              sessionId: source.sessionId,
              canOpenTab: pane.tabs.length < MAX_TABS_PER_PANE,
              transport: this.preferences.transport,
            },
      );
      if (value === "openProtectedTab") {
        if (pane.tabs.length >= MAX_TABS_PER_PANE) return;
        const cwd = (await this.bridge.request({
          kind: "resolveCwd",
          sessionId: source.sessionId,
          lastKnownCwd: source.cwd,
        })) as string;
        const tab = makeTab(cwd);
        tab.backend = "tmux";
        tab.profile = source.profile;
        pane.tabs.push(tab);
        pane.activeTabId = tab.id;
        pane.lastKnownCwd = cwd;
        workspace.focusedPaneId = pane.id;
        this.commit();
        this.startTab(tab);
      } else if (value && typeof value === "object") {
        this.updateTerminal(source.sessionId, value);
        this.commit();
      } else this.terminals.focus(source.id);
    });
  }

  private retryProtectedTab(paneId: string, tabId: string) {
    this.enqueue(async () => {
      const pane = findPane(this.workspace()?.root || null, paneId);
      const tab = pane?.tabs.find((item) => item.id === tabId);
      if (!tab || tab.backend !== "tmux" || tab.displayState === "refreshing")
        return;
      const value = await this.bridge.request({
        kind: "reconnectDisplay",
        sessionId: tab.sessionId,
      });
      if (value && typeof value === "object")
        this.updateTerminal(tab.sessionId, value);
    });
  }

  private unprotectTab(paneId: string, tabId: string) {
    this.enqueue(async () => {
      const workspace = this.state.workspaces.find((item) =>
        findPane(item.root, paneId),
      );
      const pane = findPane(workspace?.root || null, paneId);
      const tab = pane?.tabs.find((item) => item.id === tabId);
      if (!workspace || !pane || !tab || tab.backend !== "tmux") return;
      const value = await this.bridge.request({
        kind: "unprotect",
        sessionId: tab.sessionId,
      });
      if (value && typeof value === "object") {
        this.updateTerminal(tab.sessionId, value);
        this.commit();
      }
    });
  }

  private activateTab(paneId: string, tabId: string) {
    this.resetDistributionShortcut();
    const workspace = this.workspace();
    const pane = findPane(workspace?.root || null, paneId);
    if (!workspace || !pane || !pane.tabs.some((tab) => tab.id === tabId))
      return;
    pane.activeTabId = tabId;
    const tab = pane.tabs.find((item) => item.id === tabId)!;
    pane.lastKnownCwd = tab.cwd;
    workspace.focusedPaneId = paneId;
    this.commit();
  }

  private closeTabs(paneId: string, tabId?: string) {
    this.enqueue(async () => {
      const workspace = this.state.workspaces.find((item) =>
        findPane(item.root, paneId),
      );
      const pane = findPane(workspace?.root || null, paneId);
      if (!workspace || !pane) return;
      const index = tabId ? pane.tabs.findIndex((tab) => tab.id === tabId) : 0;
      if (index < 0) return;
      const tabs = tabId ? [pane.tabs[index]] : [...pane.tabs];
      if (!(await this.requestClose(tabs, tabId ? "terminal" : "pane"))) return;
      tabs.forEach((tab) => this.terminals.disposeTab(tab));
      pane.tabs = pane.tabs.filter((tab) => !tabs.includes(tab));
      if (!pane.tabs.some((tab) => tab.id === pane.activeTabId))
        pane.activeTabId =
          pane.tabs[Math.min(index, pane.tabs.length - 1)]?.id || null;
      if (!pane.tabs.length) {
        const target = findPaneAfterRemoval(workspace.root, paneId);
        workspace.root = removePane(workspace.root, paneId);
        if (workspace.focusedPaneId === paneId)
          workspace.focusedPaneId = target?.id;
      }
      if (!workspace.root && this.state.workspaces.length > 1) {
        const workspaceIndex = this.state.workspaces.indexOf(workspace);
        this.state.workspaces.splice(workspaceIndex, 1);
        this.renumberWorkspaces();
        if (this.state.activeWorkspaceId === workspace.id) {
          this.state.activeWorkspaceId =
            this.state.workspaces[
              Math.min(workspaceIndex, this.state.workspaces.length - 1)
            ]?.id || "";
        }
      }
      this.commit();
    });
  }

  private moveTabToPane(
    tabId: string,
    targetPaneId: string,
    targetIndex?: number,
  ) {
    this.enqueue(async () => {
      const source = this.locateTab(tabId);
      const targetWorkspace = this.state.workspaces.find((workspace) =>
        findPane(workspace.root, targetPaneId),
      );
      const targetPane = findPane(targetWorkspace?.root || null, targetPaneId);
      if (!source || !targetWorkspace || !targetPane) return;
      if (source.pane === targetPane) {
        if (targetIndex !== undefined)
          this.reorderTabAtIndex(targetPaneId, tabId, targetIndex);
        return;
      }
      if (targetPane.tabs.length >= MAX_TABS_PER_PANE) return;

      this.removeMovedTab(source);
      targetPane.tabs.splice(
        Math.max(
          0,
          Math.min(
            targetIndex ?? targetPane.tabs.length,
            targetPane.tabs.length,
          ),
        ),
        0,
        source.tab,
      );
      targetPane.activeTabId = source.tab.id;
      targetPane.lastKnownCwd = source.tab.cwd;
      targetWorkspace.focusedPaneId = targetPane.id;
      this.state.activeWorkspaceId = targetWorkspace.id;
      this.commit();
    });
  }

  private reorderTabAtIndex(
    paneId: string,
    tabId: string,
    targetIndex: number,
  ) {
    const workspace = this.state.workspaces.find((item) =>
      findPane(item.root, paneId),
    );
    const pane = findPane(workspace?.root || null, paneId);
    if (!pane) return;
    const sourceIndex = pane.tabs.findIndex((tab) => tab.id === tabId);
    if (sourceIndex < 0) return;
    const [tab] = pane.tabs.splice(sourceIndex, 1);
    const adjustedIndex =
      sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
    pane.tabs.splice(
      Math.max(0, Math.min(adjustedIndex, pane.tabs.length)),
      0,
      tab,
    );
    if (pane.tabs[sourceIndex]?.id === tabId) return;
    this.commit();
  }

  private reorderWorkspace(workspaceId: string, targetIndex: number) {
    const sourceIndex = this.state.workspaces.findIndex(
      (workspace) => workspace.id === workspaceId,
    );
    if (sourceIndex < 0) return;
    const [workspace] = this.state.workspaces.splice(sourceIndex, 1);
    const adjustedIndex =
      sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
    this.state.workspaces.splice(
      Math.max(0, Math.min(adjustedIndex, this.state.workspaces.length)),
      0,
      workspace,
    );
    if (this.state.workspaces[sourceIndex]?.id === workspaceId) return;
    this.renumberWorkspaces();
    this.commit(false);
  }

  private canSplitTabIntoPane(tabId: string, targetPaneId: string): boolean {
    const source = this.locateTab(tabId);
    const targetWorkspace = this.state.workspaces.find((workspace) =>
      findPane(workspace.root, targetPaneId),
    );
    if (!source || !targetWorkspace) return false;
    // Moving a sole tab removes its old pane and can shorten the target path.
    const root =
      source.workspace === targetWorkspace &&
      source.pane.id !== targetPaneId &&
      source.pane.tabs.length === 1
        ? removePane(targetWorkspace.root, source.pane.id)
        : targetWorkspace.root;
    return canSplitPane(root, targetPaneId);
  }

  private splitTabIntoPane(
    tabId: string,
    targetPaneId: string,
    side: DropSide,
  ) {
    this.enqueue(async () => {
      const source = this.locateTab(tabId);
      const targetWorkspace = this.state.workspaces.find((workspace) =>
        findPane(workspace.root, targetPaneId),
      );
      const targetPane = findPane(targetWorkspace?.root || null, targetPaneId);
      if (!source || !targetWorkspace || !targetPane) return;
      if (!this.canSplitTabIntoPane(tabId, targetPaneId)) return;

      const samePane = source.pane === targetPane;
      const needsReplacement = samePane && source.pane.tabs.length === 1;
      const replacement = needsReplacement
        ? makeTab(await this.resolveDirectory(source.pane))
        : undefined;
      if (replacement) replacement.profile = source.tab.profile;

      this.removeMovedTab(source, samePane);
      if (replacement) {
        source.pane.tabs = [replacement];
        source.pane.activeTabId = replacement.id;
        source.pane.lastKnownCwd = replacement.cwd;
      }

      const fresh: PaneNode = {
        type: "pane",
        id: id(),
        activeTabId: source.tab.id,
        tabs: [source.tab],
        lastKnownCwd: source.tab.cwd,
      };
      const before = side === "left" || side === "top";
      const horizontal = side === "left" || side === "right";
      const split: SplitNode = {
        type: "split",
        id: id(),
        direction: horizontal ? "horizontal" : "vertical",
        ratio: 0.5,
        first: before ? fresh : targetPane,
        second: before ? targetPane : fresh,
      };
      targetWorkspace.root = replaceNode(
        targetWorkspace.root || targetPane,
        targetPane.id,
        split,
      );
      targetWorkspace.focusedPaneId = fresh.id;
      this.state.activeWorkspaceId = targetWorkspace.id;
      this.commit();
      if (replacement) this.startTab(replacement);
    });
  }

  private moveTabToWorkspace(tabId: string, workspaceId: string) {
    this.enqueue(async () => {
      const source = this.locateTab(tabId);
      const targetWorkspace = this.state.workspaces.find(
        (workspace) => workspace.id === workspaceId,
      );
      if (!source || !targetWorkspace || source.workspace === targetWorkspace)
        return;

      const targetPane =
        findPane(targetWorkspace.root, targetWorkspace.focusedPaneId) ||
        getPanes(targetWorkspace.root)[0];
      if (targetPane && targetPane.tabs.length >= MAX_TABS_PER_PANE) {
        if (!canSplitPane(targetWorkspace.root, targetPane.id)) return;
        const fresh: PaneNode = {
          type: "pane",
          id: id(),
          activeTabId: source.tab.id,
          tabs: [source.tab],
          lastKnownCwd: source.tab.cwd,
        };
        const split: SplitNode = {
          type: "split",
          id: id(),
          direction: "horizontal",
          ratio: 0.5,
          first: targetPane,
          second: fresh,
        };
        targetWorkspace.root = replaceNode(
          targetWorkspace.root!,
          targetPane.id,
          split,
        );
        this.removeMovedTab(source);
        targetWorkspace.focusedPaneId = fresh.id;
      } else {
        this.removeMovedTab(source);
        if (!targetPane) {
          const fresh: PaneNode = {
            type: "pane",
            id: id(),
            activeTabId: source.tab.id,
            tabs: [source.tab],
            lastKnownCwd: source.tab.cwd,
          };
          targetWorkspace.root = fresh;
          targetWorkspace.focusedPaneId = fresh.id;
        } else {
          targetPane.tabs.push(source.tab);
          targetPane.activeTabId = source.tab.id;
          targetPane.lastKnownCwd = source.tab.cwd;
          targetWorkspace.focusedPaneId = targetPane.id;
        }
      }
      this.state.activeWorkspaceId = targetWorkspace.id;
      this.commit();
    });
  }

  private moveTabToNewWorkspace(tabId: string, targetIndex?: number) {
    this.enqueue(async () => {
      const source = this.locateTab(tabId);
      if (!source) return;
      const sourceWorkspaceIndex = this.state.workspaces.indexOf(
        source.workspace,
      );
      const removesSourceWorkspace =
        source.pane.tabs.length === 1 &&
        getPanes(source.workspace.root).length === 1;
      if (
        this.state.workspaces.length >= MAX_WORKSPACES &&
        !removesSourceWorkspace
      )
        return;

      this.removeMovedTab(source);
      const pane: PaneNode = {
        type: "pane",
        id: id(),
        activeTabId: source.tab.id,
        tabs: [source.tab],
        lastKnownCwd: source.tab.cwd,
      };
      const workspace: Workspace = {
        id: id(),
        name: `^${this.state.workspaces.length + 1}`,
        root: pane,
        focusedPaneId: pane.id,
      };
      let insertionIndex = targetIndex ?? this.state.workspaces.length;
      if (removesSourceWorkspace && sourceWorkspaceIndex < insertionIndex)
        insertionIndex--;
      insertionIndex = Math.max(
        0,
        Math.min(insertionIndex, this.state.workspaces.length),
      );
      this.state.workspaces.splice(insertionIndex, 0, workspace);
      this.state.activeWorkspaceId = workspace.id;
      this.renumberWorkspaces();
      this.commit();
    });
  }

  private locateTab(tabId: string): TabLocation | undefined {
    for (const workspace of this.state.workspaces) {
      for (const pane of getPanes(workspace.root)) {
        const tab = pane.tabs.find((item) => item.id === tabId);
        if (tab) return { workspace, pane, tab };
      }
    }
    return undefined;
  }

  private removeMovedTab(source: TabLocation, preservePane = false) {
    const { workspace, pane, tab } = source;
    const index = pane.tabs.indexOf(tab);
    if (index < 0) return;
    pane.tabs.splice(index, 1);
    if (pane.tabs.length) {
      if (pane.activeTabId === tab.id) {
        pane.activeTabId = pane.tabs[Math.min(index, pane.tabs.length - 1)].id;
        pane.lastKnownCwd =
          pane.tabs.find((item) => item.id === pane.activeTabId)?.cwd ||
          pane.lastKnownCwd;
      }
      return;
    }
    pane.activeTabId = null;
    if (preservePane) return;

    const target = findPaneAfterRemoval(workspace.root, pane.id);
    workspace.root = removePane(workspace.root, pane.id);
    const remaining = getPanes(workspace.root);
    if (remaining.length) {
      if (workspace.focusedPaneId === pane.id)
        workspace.focusedPaneId = target?.id;
      return;
    }

    const workspaceIndex = this.state.workspaces.indexOf(workspace);
    this.state.workspaces.splice(workspaceIndex, 1);
    this.renumberWorkspaces();
    if (this.state.activeWorkspaceId === workspace.id)
      this.state.activeWorkspaceId = this.state.workspaces[0]?.id || "";
  }

  private splitPane(paneId: string, side: DropSide) {
    const workspace = this.workspace();
    this.enqueue(async () => {
      const pane = findPane(workspace?.root || null, paneId);
      if (
        !workspace?.root ||
        !pane ||
        !this.state.workspaces.includes(workspace) ||
        !canSplitPane(workspace.root, paneId)
      )
        return;
      const fresh = makePane(await this.resolveDirectory(pane));
      const before = side === "left" || side === "top";
      const split: SplitNode = {
        type: "split",
        id: id(),
        direction:
          side === "left" || side === "right" ? "horizontal" : "vertical",
        ratio: 0.5,
        first: before ? fresh : pane,
        second: before ? pane : fresh,
      };
      workspace.root = replaceNode(workspace.root, pane.id, split);
      workspace.focusedPaneId = fresh.id;
      this.commit();
      this.startTab(fresh.tabs[0]);
    });
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
    const previousBackend = tab.backend;
    const previousTransport = tab.transport;
    if (
      tab.backend === "direct" &&
      this.preferences.defaultProtected &&
      this.capabilities.tmux.available &&
      this.capabilities.tmux.supported !== false
    )
      tab.backend = "tmux";
    if (tab.backend === "tmux") tab.transport = this.preferences.transport;
    if (
      tab.backend !== previousBackend ||
      tab.transport !== previousTransport
    ) {
      this.bridge.persist(this.state);
      this.view.update(this.state);
    }
    this.bridge.send({
      type: "start",
      sessionId: tab.sessionId,
      cwd: tab.cwd,
      profile: tab.profile,
      backend: tab.backend,
      backendSessionId: tab.backendSessionId,
      transport: tab.transport,
    });
  }

  private async resolveDirectory(pane?: PaneNode, explicitCwd?: string) {
    const active = pane?.tabs.find((tab) => tab.id === pane.activeTabId);
    return (await this.bridge.request({
      kind: "resolveCwd",
      explicitCwd,
      sessionId: active?.sessionId,
      lastKnownCwd: pane?.lastKnownCwd || active?.cwd,
    })) as string;
  }

  private async requestClose(
    tabs: TerminalTab[],
    scope: CloseScope,
    title?: string,
  ) {
    const result = await this.bridge.request({
      kind: "close",
      scope,
      title,
      terminals: tabs.map((tab) => ({
        sessionId: tab.sessionId,
        title: tab.title,
      })),
    });
    if (!result) {
      const pane = this.focusedPane();
      if (pane?.activeTabId) this.terminals.focus(pane.activeTabId);
    }
    return result === true;
  }
}
