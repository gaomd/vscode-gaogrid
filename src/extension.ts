import * as vscode from "vscode";
import * as path from "path";
import * as os from "os";
import { randomUUID } from "crypto";
import { TerminalOutputStore } from "./terminal-output-store";
import { TerminalOutputStream } from "./terminal-output-stream";
import { PtyManager } from "./pty-manager";
import { PersistedState } from "./model";
import { getPanes, getTabs, removeTabFromState } from "./webview/layout";
import { resolveCwd, validDirectory } from "./cwd-resolver";
import { TerminalLifecycle } from "./terminal-lifecycle";
import { nativeDroppedPaths } from "./native-drop";
import type {
  LifecycleRequest,
  NewTerminalOptions,
  TerminalMetadata,
  LifecycleResult,
  TerminalPreferences,
  WindowPresentation,
} from "./terminal-protocol";
import { STATE_KEY, LEGACY_STATE_KEY, restoreState } from "./persistence-store";

interface NativeDropCandidate {
  names: string[];
  startedAt: number;
  paths: Promise<string[]>;
}

type GaoGridSurface = Pick<vscode.WebviewView, "webview" | "onDidDispose">;
const MOVE_TO_WINDOW = "workbench.action.moveEditorToNewWindow";
const TOGGLE_SIDEBAR_SIZE = "workbench.action.toggleMaximizedAuxiliaryBar";

let shutdown: (() => Promise<void>) | undefined;
export function activate(context: vscode.ExtensionContext) {
  let view: GaoGridSurface | undefined;
  let sidebarView: vscode.WebviewView | undefined;
  let windowPanel: vscode.WebviewPanel | undefined;
  let viewClientId: string | undefined;
  let switchingWindow = false;
  let canDetach = false;
  let canMaximize = false;
  const detectWindowSupport = vscode.commands
    .getCommands(true)
    .then((commands) => {
      canDetach = commands.includes(MOVE_TO_WINDOW);
      canMaximize = commands.includes(TOGGLE_SIDEBAR_SIZE);
    });
  const readyWaiters = new Set<{
    surface: GaoGridSurface;
    previousClientId?: string;
    resolve(): void;
    reject(error: Error): void;
  }>();
  let preparation:
    | {
        surface: GaoGridSurface;
        requestId: string;
        resolve(): void;
        reject(error: Error): void;
      }
    | undefined;
  let viewReady = false;
  let viewGeneration = 0;
  const endedSessions = new Set<string>();
  let state = restoreState(
    context.workspaceState.get(STATE_KEY) ??
      context.workspaceState.get(LEGACY_STATE_KEY),
  );
  const nativeDropCandidates = new Map<string, NativeDropCandidate>();
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let stopping = false;
  const log = vscode.window.createOutputChannel("GaoGrid");
  context.subscriptions.push(log);
  const defaultDirectories = () => [workspaceDirectory(), os.homedir()];
  const manager = new PtyManager(
    (message) => {
      const event = message as TerminalMetadata & {
        type: string;
        sessionId: string;
      };
      if (event.type === "metadata") {
        for (const workspace of state.workspaces)
          for (const tab of getTabs(workspace.root))
            if (tab.sessionId === event.sessionId)
              Object.assign(tab, manager.metadata(event.sessionId));
        if (!stopping) {
          if (saveTimer) clearTimeout(saveTimer);
          saveTimer = setTimeout(() => {
            saveTimer = undefined;
            void persist();
          }, 300);
        }
      }
      if (event.type === "sessionEnded") {
        outputStreams.unsubscribe(event.sessionId);
        endedSessions.add(event.sessionId);
        if (removeTabFromState(state, event.sessionId)) void persist();
        if (viewReady) void view?.webview.postMessage(message);
        return;
      }
      if (event.type === "data") {
        outputStreams.write(
          event.sessionId,
          (message as { data: string }).data,
        );
        return;
      }
      if (event.type === "reset") outputStreams.unsubscribe(event.sessionId);
      if (event.type === "notice")
        void vscode.window.showInformationMessage(
          `GaoGrid: ${(message as { message: string }).message}`,
        );
      if (viewReady) void view?.webview.postMessage(message);
    },
    {
      defaultDirectories,
      outputStore: new TerminalOutputStore(
        path.join(
          (context.storageUri || context.globalStorageUri).fsPath,
          "terminal-output",
        ),
      ),
      log: (message) => log.appendLine(message),
      tmuxConfigPath: path.join(
        context.extensionPath,
        "resources",
        "tmux.conf",
      ),
      defaultShell: () =>
        vscode.workspace
          .getConfiguration("gaogrid")
          .get<string>("defaultShell", "") ||
        (process.platform === "win32"
          ? "powershell.exe"
          : process.env.SHELL || "/bin/bash"),
    },
  );
  const outputStreams = new TerminalOutputStream(
    manager,
    (message) => view?.webview.postMessage(message) || false,
  );
  const lifecycle = new TerminalLifecycle(
    manager,
    async ({ message, detail, action }) => {
      const selection = await vscode.window.showWarningMessage(
        message,
        { modal: true, detail },
        action,
      );
      return selection === action;
    },
  );
  const persist = async () => {
    for (const workspace of state.workspaces)
      for (const pane of getPanes(workspace.root)) {
        for (const tab of pane.tabs) {
          const metadata = manager.metadata(tab.sessionId);
          if (metadata) Object.assign(tab, metadata);
        }
        pane.lastKnownCwd =
          pane.tabs.find((tab) => tab.id === pane.activeTabId)?.cwd ||
          pane.lastKnownCwd;
      }
    await context.workspaceState.update(STATE_KEY, state);
  };

  function acceptState(next: PersistedState) {
    state = next;
    for (const id of endedSessions) removeTabFromState(state, id);
  }

  function presentation(): WindowPresentation {
    return {
      mode: windowPanel ? "window" : "sidebar",
      canDetach,
      canMaximize,
      transitioning: switchingWindow || !viewReady,
    };
  }

  function updatePresentation() {
    void vscode.commands.executeCommand(
      "setContext",
      "gaogridDetached",
      !!windowPanel,
    );
    void vscode.commands.executeCommand(
      "setContext",
      "gaogridCanToggleWindow",
      (canDetach || !!windowPanel) &&
        viewReady &&
        !switchingWindow &&
        !stopping,
    );
    void vscode.commands.executeCommand(
      "setContext",
      "gaogridCanResizeSidebar",
      !windowPanel && canMaximize && viewReady && !switchingWindow && !stopping,
    );
    post({ type: "presentation", presentation: presentation() });
  }

  function loadSurface(surface: GaoGridSurface) {
    view = surface;
    viewReady = false;
    viewClientId = undefined;
    viewGeneration++;
    outputStreams.clear();
    nativeDropCandidates.clear();
    void vscode.commands.executeCommand("setContext", "gaogridFocus", false);
    surface.webview.html = getHtml(surface.webview, context);
  }

  function waitForReady(
    surface: GaoGridSurface,
    previousClientId?: string,
  ): Promise<void> {
    if (
      view === surface &&
      viewReady &&
      (!previousClientId || viewClientId !== previousClientId)
    )
      return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        readyWaiters.delete(waiter);
        reject(new Error("GaoGrid did not finish opening. Please try again."));
      }, 15000);
      const waiter = {
        surface,
        previousClientId,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      readyWaiters.add(waiter);
    });
  }

  async function preparePresentation() {
    if (!view || !viewReady)
      throw new Error("GaoGrid is still loading. Please try again.");
    const surface = view;
    const requestId = randomUUID();
    let timer: ReturnType<typeof setTimeout>;
    try {
      await new Promise<void>((resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                "GaoGrid is busy. Finish the current operation and try again.",
              ),
            ),
          15000,
        );
        preparation = { surface, requestId, resolve, reject };
        post({ type: "preparePresentation", requestId });
      });
      await manager.settle();
      await persist();
    } finally {
      clearTimeout(timer!);
      if (preparation?.requestId === requestId) preparation = undefined;
    }
  }

  async function revealSidebar() {
    if (!sidebarView)
      await vscode.commands.executeCommand("gaogrid.view.focus");
    if (!sidebarView) throw new Error("Could not open the GaoGrid sidebar.");
    if (view !== sidebarView) loadSurface(sidebarView);
    sidebarView.show(false);
    await waitForReady(sidebarView);
  }

  async function toggleSidebarSize() {
    if (
      windowPanel ||
      !canMaximize ||
      switchingWindow ||
      stopping ||
      !viewReady ||
      !sidebarView ||
      view !== sidebarView
    )
      return;
    const surface = sidebarView;
    const clientId = viewClientId;
    const current = () =>
      view === surface &&
      viewClientId === clientId &&
      viewReady &&
      !windowPanel &&
      !switchingWindow &&
      !stopping;
    await vscode.commands.executeCommand(TOGGLE_SIDEBAR_SIZE);
    if (!current()) return;
    await vscode.commands.executeCommand("gaogrid.view.focus");
    if (current()) post({ type: "action", action: "focusTerminal" });
  }

  async function changePresentation(mode: WindowPresentation["mode"]) {
    if (switchingWindow || stopping) return;
    switchingWindow = true;
    updatePresentation();
    let created: vscode.WebviewPanel | undefined;
    try {
      if (mode === "window") {
        if (windowPanel) {
          windowPanel.reveal(undefined, false);
          return;
        }
        await detectWindowSupport;
        if (!canDetach)
          throw new Error("This editor does not support floating windows.");
        await revealSidebar();
        await preparePresentation();
        created = vscode.window.createWebviewPanel(
          "gaogrid.window",
          "GaoGrid",
          vscode.ViewColumn.Active,
          {
            enableScripts: true,
            retainContextWhenHidden: true,
          },
        );
        created.iconPath = vscode.Uri.joinPath(
          context.extensionUri,
          "media",
          "icon.svg",
        );
        windowPanel = created;
        bindSurface(created);
        loadSurface(created);
        if (sidebarView) sidebarView.webview.html = detachedHtml();
        await waitForReady(created);
        const previousClientId = viewClientId;
        created.reveal(undefined, false);
        await vscode.commands.executeCommand(MOVE_TO_WINDOW);
        await waitForReady(created, previousClientId);
      } else {
        const previous = windowPanel;
        if (previous && view === previous && viewReady)
          await preparePresentation();
        windowPanel = undefined;
        try {
          await revealSidebar();
        } finally {
          previous?.dispose();
        }
      }
    } catch (error) {
      const closedDuringMove = created && windowPanel !== created;
      if (created && windowPanel === created) {
        windowPanel = undefined;
        await revealSidebar().catch((failure) =>
          log.appendLine(String(failure)),
        );
        created.dispose();
      }
      if (!stopping && !closedDuringMove)
        void vscode.window.showErrorMessage(`GaoGrid: ${String(error)}`);
    } finally {
      switchingWindow = false;
      updatePresentation();
    }
  }

  function detachedHtml() {
    const nonce = randomUUID().replace(/-/g, "");
    return `<!doctype html><html lang="en"><head><meta charset="UTF-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
      <style>body{font:var(--vscode-font-size) var(--vscode-font-family);color:var(--vscode-foreground);padding:12px}button{font:inherit;color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;padding:6px 10px;cursor:pointer}button:focus-visible{outline:1px solid var(--vscode-focusBorder)}</style>
      </head><body><p>GaoGrid is open in a separate window.</p>
      <button id="reveal">Show Window</button> <button id="attach">Attach to Sidebar</button>
      <script nonce="${nonce}">const api=acquireVsCodeApi();document.getElementById('reveal').onclick=()=>api.postMessage({type:'revealWindow'});document.getElementById('attach').onclick=()=>api.postMessage({type:'attachWindow'});</script>
      </body></html>`;
  }

  function bindSurface(webviewView: GaoGridSurface) {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.file(path.join(context.extensionPath, "dist")),
        vscode.Uri.file(path.join(context.extensionPath, "node_modules")),
      ],
    };
    webviewView.onDidDispose(() => {
      if (sidebarView === webviewView) sidebarView = undefined;
      preparation?.surface === webviewView &&
        preparation.reject(new Error("GaoGrid view was closed."));
      for (const waiter of readyWaiters)
        if (waiter.surface === webviewView) {
          readyWaiters.delete(waiter);
          waiter.reject(new Error("GaoGrid view was closed."));
        }
      if (view === webviewView) {
        outputStreams.clear();
        view = undefined;
        viewReady = false;
        void vscode.commands.executeCommand(
          "setContext",
          "gaogridFocus",
          false,
        );
      }
      if (windowPanel === webviewView) {
        windowPanel = undefined;
        if (!stopping)
          void revealSidebar().catch((error) => log.appendLine(String(error)));
      }
    });
    webviewView.webview.onDidReceiveMessage(async (message) => {
      if (stopping) return;
      if (webviewView === sidebarView && windowPanel) {
        if (message.type === "revealWindow")
          windowPanel.reveal(undefined, false);
        else if (message.type === "attachWindow")
          await changePresentation("sidebar");
      }
      if (view !== webviewView) return;
      if (message.type === "ready") viewClientId = message.clientId;
      else if (message.clientId !== viewClientId) return;
      const clientId = message.clientId;
      const current = () => view === webviewView && viewClientId === clientId;
      const reply = (value: unknown) => {
        if (current()) void webviewView.webview.postMessage(value);
      };
      switch (message.type) {
        case "ready":
          const generation = ++viewGeneration;
          viewReady = false;
          outputStreams.clear();
          await Promise.all(
            state.workspaces
              .flatMap((workspace) => getTabs(workspace.root))
              .map((tab) =>
                manager.start(tab.sessionId, tab.cwd, tab.profile, true, tab),
              ),
          );
          await persist();
          const capabilities = await manager.tmux.capabilities();
          await detectWindowSupport;
          if (view !== webviewView || generation !== viewGeneration) break;
          webviewView.webview.postMessage({
            type: "init",
            state,
            capabilities,
            preferences: terminalPreferences(),
            presentation: presentation(),
          });
          webviewView.webview.postMessage({
            type: "settings",
            settings: terminalSettings(),
          });
          viewReady = true;
          updatePresentation();
          for (const waiter of readyWaiters)
            if (
              waiter.surface === webviewView &&
              (!waiter.previousClientId ||
                waiter.previousClientId !== viewClientId)
            ) {
              readyWaiters.delete(waiter);
              waiter.resolve();
            }
          if (capabilities.tmux.available) {
            const known = state.workspaces
              .flatMap((workspace) => getTabs(workspace.root))
              .flatMap((tab) =>
                tab.backendSessionId ? [tab.backendSessionId] : [],
              );
            void manager.tmux
              .orphans(known)
              .then((ids) => {
                for (const id of ids)
                  log.appendLine(
                    `Orphaned protected session left running: ${id}`,
                  );
              })
              .catch((error) => log.appendLine(String(error)));
          }
          break;
        case "subscribeOutput":
          if (
            typeof message.sessionId === "string" &&
            typeof message.streamId === "string"
          )
            await outputStreams.subscribe(message.sessionId, message.streamId);
          break;
        case "unsubscribeOutput":
          outputStreams.unsubscribe(message.sessionId, message.streamId);
          break;
        case "outputParsed":
          outputStreams.acknowledge(
            message.sessionId,
            message.streamId,
            message.sequence,
          );
          break;
        case "activeTerminal":
          manager.setForeground(
            typeof message.sessionId === "string"
              ? message.sessionId
              : undefined,
          );
          break;
        case "preferences":
          await updateTerminalPreferences(message.preferences);
          break;
        case "persist":
          acceptState(message.state);
          await persist();
          break;
        case "presentationReady":
          if (
            preparation?.surface === webviewView &&
            preparation.requestId === message.requestId
          ) {
            acceptState(message.state);
            preparation.resolve();
          }
          break;
        case "toggleWindow":
          await changePresentation(windowPanel ? "sidebar" : "window");
          break;
        case "toggleSidebarSize":
          await toggleSidebarSize();
          break;
        case "start":
          await manager.start(
            message.sessionId,
            message.cwd,
            message.profile,
            false,
            message,
          );
          await persist();
          break;
        case "lifecycle": {
          try {
            const request = message.request as LifecycleRequest;
            let value: LifecycleResult;
            if (request.kind === "resolveCwd") {
              value =
                (await validDirectory(request.explicitCwd)) ||
                (await resolveCwd([
                  request.sessionId
                    ? await manager.cwd(request.sessionId)
                    : undefined,
                  request.lastKnownCwd,
                  ...defaultDirectories(),
                ]));
            } else if (request.kind === "protect") {
              const metadata = await manager.promote(
                request.sessionId,
                request.transport,
              );
              if (metadata) {
                await persist();
                value = metadata;
              } else {
                const action = "Open Protected Tab";
                const selected = await vscode.window.showWarningMessage(
                  "Cannot protect this terminal while a task is running.",
                  {
                    modal: true,
                    detail:
                      "Wait until the terminal returns to the shell prompt, or open a new protected tab." +
                      (request.canOpenTab
                        ? ""
                        : "\nThis pane has reached its tab limit (9)."),
                  },
                  ...(request.canOpenTab ? [action] : []),
                );
                value = selected === action ? "openProtectedTab" : false;
              }
            } else if (request.kind === "reconnect") {
              const tab = state.workspaces
                .flatMap((workspace) => getTabs(workspace.root))
                .find((item) => item.sessionId === request.sessionId);
              if (!tab || tab.backend !== "tmux")
                throw new Error("Protected tab is no longer available.");
              await manager.start(
                tab.sessionId,
                tab.cwd,
                tab.profile,
                false,
                tab,
              );
              await persist();
              value = manager.metadata(tab.sessionId) || false;
            } else if (request.kind === "reconnectDisplay") {
              value =
                (await manager.reconnectDisplay(request.sessionId)) || false;
              await persist();
            } else if (request.kind === "unprotect") {
              const tab = state.workspaces
                .flatMap((workspace) => getTabs(workspace.root))
                .find((item) => item.sessionId === request.sessionId);
              if (!tab || tab.backend !== "tmux")
                throw new Error("Protected tab is no longer available.");
              if (
                (await manager.activeTasks([tab.sessionId])).has(tab.sessionId)
              ) {
                await vscode.window.showWarningMessage(
                  "Cannot remove protection while a task is running. Wait until the terminal returns to the shell prompt.",
                );
                value = false;
              } else {
                const action = "Remove Protection";
                const selected = await vscode.window.showWarningMessage(
                  "Remove protection from this terminal?",
                  {
                    modal: true,
                    detail:
                      "This destroys its tmux session and replaces it with a fresh direct shell in the current directory. Captured output is restored as history, but live screen and application state are not preserved.",
                  },
                  action,
                );
                if (selected === action) {
                  value = (await manager.unprotect(tab.sessionId)) || false;
                  await persist();
                } else value = false;
              }
            } else if (request.kind === "close") {
              value = await lifecycle.requestClose(request);
              if (value) {
                for (const terminal of request.terminals) {
                  endedSessions.add(terminal.sessionId);
                  removeTabFromState(state, terminal.sessionId);
                  if (!current())
                    post({
                      type: "sessionEnded",
                      sessionId: terminal.sessionId,
                    });
                }
                await persist();
              }
            } else throw new Error("Unknown terminal lifecycle operation.");
            reply({
              type: "lifecycleResult",
              requestId: message.requestId,
              value,
            });
          } catch (error) {
            reply({
              type: "lifecycleResult",
              requestId: message.requestId,
              error: String(error),
            });
          }
          break;
        }
        case "lifecycleError":
          void vscode.window.showErrorMessage(`GaoGrid: ${message.message}`);
          break;
        case "input":
          manager.input(
            message.sessionId,
            message.data,
            message.binary === true,
          );
          break;
        case "nativeDropCandidate": {
          if (typeof message.sessionId === "string") {
            const names: string[] = Array.isArray(message.names)
              ? message.names.filter(
                  (name: unknown): name is string => typeof name === "string",
                )
              : [];
            if (names.length)
              nativeDropCandidates.set(message.sessionId, {
                names,
                startedAt: Date.now(),
                paths: nativeDroppedPaths(names),
              });
          }
          break;
        }
        case "dropPaths": {
          const resources: unknown[] = Array.isArray(message.resources)
            ? message.resources
            : [];
          const paths = resources
            .map(droppedPath)
            .filter((value): value is string => !!value);
          const names: string[] = Array.isArray(message.names)
            ? message.names.filter(
                (name: unknown): name is string => typeof name === "string",
              )
            : [];
          const candidate = nativeDropCandidates.get(message.sessionId);
          nativeDropCandidates.delete(message.sessionId);
          if (
            !paths.length &&
            names.length &&
            candidate &&
            Date.now() - candidate.startedAt < 5000 &&
            sameDropNames(candidate.names, names)
          )
            paths.push(...(await candidate.paths));
          else if (!paths.length && names.length)
            paths.push(...(await nativeDroppedPaths(names)));
          if (!paths.length && names.length) {
            // Sandboxed webviews may receive file names without absolute paths.
            const selected = await vscode.window.showOpenDialog({
              title: "Select dropped files or folders to insert their paths",
              openLabel: "Insert Paths",
              canSelectFiles: true,
              canSelectFolders: true,
              canSelectMany: true,
            });
            if (!selected) break;
            paths.push(...selected.map((uri) => uri.fsPath));
          }
          if (!paths.length) break;
          const text = manager.quotePaths(message.sessionId, [
            ...new Set(paths),
          ]);
          if (text)
            reply({
              type: "paste",
              sessionId: message.sessionId,
              text,
            });
          break;
        }
        case "resize":
          manager.resize(message.sessionId, message.cols, message.rows);
          break;
        case "focus":
          vscode.commands.executeCommand(
            "setContext",
            "gaogridFocus",
            !!message.focused,
          );
          break;
        case "newWorkspace":
          vscode.commands.executeCommand("gaogrid.newWorkspace");
          break;
        case "newTab":
          vscode.commands.executeCommand("gaogrid.newTab");
          break;
        case "closeTab":
          vscode.commands.executeCommand("gaogrid.closeTab");
          break;
        case "openUrl":
          if (/^https?:\/\//i.test(message.uri))
            void vscode.env.openExternal(vscode.Uri.parse(message.uri));
          break;
        case "copyText":
          if (typeof message.text === "string")
            void vscode.env.clipboard.writeText(message.text);
          break;
        case "copyCwd": {
          const cwd = await manager.cwd(message.sessionId);
          if (cwd) void vscode.env.clipboard.writeText(cwd);
          break;
        }
      }
    });
  }
  const provider: vscode.WebviewViewProvider = {
    resolveWebviewView(webviewView) {
      sidebarView = webviewView;
      bindSurface(webviewView);
      webviewView.onDidChangeVisibility(() => {
        if (view !== webviewView || windowPanel || switchingWindow || stopping)
          return;
        if (!webviewView.visible) {
          void vscode.commands.executeCommand(
            "setContext",
            "gaogridFocus",
            false,
          );
          return;
        }
        webviewView.show(false);
        if (viewReady) post({ type: "action", action: "focusTerminal" });
      });
      if (windowPanel) webviewView.webview.html = detachedHtml();
      else loadSurface(webviewView);
    },
  };
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("gaogrid.view", provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewPanelSerializer("gaogrid.window", {
      async deserializeWebviewPanel(panel) {
        if (windowPanel) {
          panel.dispose();
          windowPanel.reveal(undefined, false);
          return;
        }
        windowPanel = panel;
        bindSurface(panel);
        loadSurface(panel);
        if (sidebarView) sidebarView.webview.html = detachedHtml();
      },
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("gaogrid.detachWindow", () =>
      changePresentation("window"),
    ),
    vscode.commands.registerCommand("gaogrid.attachWindow", () =>
      changePresentation("sidebar"),
    ),
    vscode.commands.registerCommand("gaogrid.toggleWindow", () =>
      changePresentation(windowPanel ? "sidebar" : "window"),
    ),
    vscode.commands.registerCommand(
      "gaogrid.toggleSidebarSize",
      toggleSidebarSize,
    ),
    vscode.commands.registerCommand("gaogrid.newWorkspace", () =>
      post({ type: "action", action: "newWorkspace" }),
    ),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "gaogrid.newTab",
      (options?: NewTerminalOptions) =>
        post({ type: "action", action: "newTab", options }),
    ),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("gaogrid.closeTab", () =>
      post({ type: "action", action: "closeTab" }),
    ),
    vscode.commands.registerCommand("gaogrid.closePane", () =>
      post({ type: "action", action: "closePane" }),
    ),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "gaogrid.switchWorkspace",
      (index: number) =>
        post({ type: "action", action: "switchWorkspace", index }),
    ),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("gaogrid.switchTab", (index: number) =>
      post({ type: "action", action: "switchTab", index }),
    ),
  );
  for (const action of [
    "splitUp",
    "splitDown",
    "splitLeft",
    "splitRight",
    "focusPaneUp",
    "focusPaneDown",
    "focusPaneLeft",
    "focusPaneRight",
    "distributePanes",
    "distributeWorkspacePanes",
    "previousTab",
    "nextTab",
    "increaseFontSize",
    "decreaseFontSize",
    "resetFontSize",
  ]) {
    context.subscriptions.push(
      vscode.commands.registerCommand(`gaogrid.${action}`, () =>
        post({ type: "action", action }),
      ),
    );
  }
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration("workbench.colorTheme") ||
        e.affectsConfiguration("workbench.colorCustomizations") ||
        e.affectsConfiguration("terminal.integrated") ||
        e.affectsConfiguration("editor.fontFamily")
      )
        post({ type: "theme", settings: terminalSettings() });
      if (e.affectsConfiguration("gaogrid")) {
        post({ type: "preferences", preferences: terminalPreferences() });
      }
    }),
  );
  shutdown = async () => {
    stopping = true;
    outputStreams.clear();
    preparation?.reject(new Error("GaoGrid is shutting down."));
    for (const waiter of readyWaiters) {
      readyWaiters.delete(waiter);
      waiter.reject(new Error("GaoGrid is shutting down."));
    }
    if (saveTimer) clearTimeout(saveTimer);
    await manager.settle();
    await Promise.allSettled(
      state.workspaces
        .flatMap((workspace) => getTabs(workspace.root))
        .map((tab) => manager.cwd(tab.sessionId)),
    );
    try {
      await persist();
    } finally {
      await manager.shutdown();
    }
  };
  function post(message: unknown) {
    if (switchingWindow && (message as { type?: string }).type === "action")
      return;
    view?.webview.postMessage(message);
  }
}
export async function deactivate() {
  await shutdown?.();
  shutdown = undefined;
}

function workspaceDirectory() {
  const uri = vscode.window.activeTextEditor?.document.uri;
  const folder = uri && vscode.workspace.getWorkspaceFolder(uri);
  return (folder || vscode.workspace.workspaceFolders?.[0])?.uri.fsPath;
}

function droppedPath(resource: unknown): string | undefined {
  if (typeof resource === "string") {
    if (resource.includes("\0")) return;
    if (path.isAbsolute(resource)) return resource;
    try {
      const uri = vscode.Uri.parse(resource);
      return uri.scheme === "file" ? uri.fsPath : undefined;
    } catch {
      return;
    }
  }
  if (resource && typeof resource === "object") {
    const entry = resource as {
      resource?: unknown;
      scheme?: unknown;
      path?: unknown;
      authority?: unknown;
    };
    if (entry.resource) return droppedPath(entry.resource);
    if (
      entry.scheme === "file" &&
      typeof entry.path === "string" &&
      !entry.path.includes("\0")
    )
      return vscode.Uri.from({
        scheme: "file",
        path: entry.path,
        authority:
          typeof entry.authority === "string" ? entry.authority : undefined,
      }).fsPath;
  }
  return undefined;
}

function sameDropNames(first: string[], second: string[]) {
  if (first.length !== second.length) return false;
  const counts = new Map<string, number>();
  for (const name of first) {
    const normalized = name.normalize("NFC");
    counts.set(normalized, (counts.get(normalized) || 0) + 1);
  }
  for (const name of second) {
    const normalized = name.normalize("NFC");
    const count = counts.get(normalized);
    if (!count) return false;
    if (count === 1) counts.delete(normalized);
    else counts.set(normalized, count - 1);
  }
  return counts.size === 0;
}

function terminalSettings() {
  const c = vscode.workspace.getConfiguration("terminal.integrated");
  const editor = vscode.workspace.getConfiguration("editor");
  return {
    fontFamily:
      c.get<string>("fontFamily") || editor.get("fontFamily", "monospace"),
    fontSize: c.get("fontSize", 12),
    fontWeight: c.get("fontWeight", "normal"),
    fontWeightBold: c.get("fontWeightBold", "bold"),
    lineHeight: c.get("lineHeight", 1),
    letterSpacing: c.get("letterSpacing", 0),
    minimumContrastRatio: c.get("minimumContrastRatio", 1),
    gpuAcceleration: c.get("gpuAcceleration", "auto"),
  };
}

function terminalPreferences(): TerminalPreferences {
  const configuration = vscode.workspace.getConfiguration("gaogrid");
  const transport = configuration.get<string>("transportMode", "control");
  const mousePolicy = configuration.get<string>("mousePolicy", "application");
  return {
    defaultProtected: configuration.get<boolean>("defaultProtected", false),
    transport: transport === "attach" ? "attach" : "control",
    mousePolicy:
      mousePolicy === "terminal" || mousePolicy === "exclusive"
        ? mousePolicy
        : "application",
  };
}

async function updateTerminalPreferences(value: unknown) {
  if (!value || typeof value !== "object") return;
  const preferences = value as Partial<TerminalPreferences>;
  const configuration = vscode.workspace.getConfiguration("gaogrid");
  const updates: [string, unknown][] = [];
  if (typeof preferences.defaultProtected === "boolean")
    updates.push(["defaultProtected", preferences.defaultProtected]);
  if (preferences.transport === "control" || preferences.transport === "attach")
    updates.push(["transportMode", preferences.transport]);
  if (
    preferences.mousePolicy === "application" ||
    preferences.mousePolicy === "terminal" ||
    preferences.mousePolicy === "exclusive"
  )
    updates.push(["mousePolicy", preferences.mousePolicy]);
  for (const [key, next] of updates)
    await configuration.update(key, next, vscode.ConfigurationTarget.Global);
}
function getHtml(webview: vscode.Webview, context: vscode.ExtensionContext) {
  const script = webview.asWebviewUri(
    vscode.Uri.file(path.join(context.extensionPath, "dist", "webview.js")),
  );
  const xtermCss = webview.asWebviewUri(
    vscode.Uri.file(
      path.join(
        context.extensionPath,
        "node_modules",
        "@xterm",
        "xterm",
        "css",
        "xterm.css",
      ),
    ),
  );
  const styles = webview.asWebviewUri(
    vscode.Uri.file(path.join(context.extensionPath, "dist", "webview.css")),
  );
  const nonce = randomUUID().replace(/-/g, "");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}';">
    <link rel="stylesheet" href="${xtermCss}">
    <link rel="stylesheet" href="${styles}">
  </head>
  <body>
    <div id="root"></div>
    <script nonce="${nonce}" src="${script}"></script>
  </body>
</html>`;
}
