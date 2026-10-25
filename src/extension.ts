import * as vscode from "vscode";
import * as path from "path";
import * as os from "os";
import { randomUUID } from "crypto";
import { TerminalOutputStore } from "./terminal-output-store";
import { PtyManager } from "./pty-manager";
import { PersistedState } from "./model";
import { getPanes, getTabs } from "./webview/layout";
import { resolveCwd, validDirectory } from "./cwd-resolver";
import { TerminalLifecycle } from "./terminal-lifecycle";
import type {
  LifecycleRequest,
  NewTerminalOptions,
  TerminalMetadata,
  LifecycleResult,
} from "./terminal-protocol";
import { STATE_KEY, LEGACY_STATE_KEY, restoreState } from "./persistence-store";

let shutdown: (() => Promise<void>) | undefined;
export function activate(context: vscode.ExtensionContext) {
  let view: vscode.WebviewView | undefined;
  let viewReady = false;
  let viewGeneration = 0;
  const replayed = new Set<string>();
  let state = restoreState(
    context.workspaceState.get(STATE_KEY) ??
      context.workspaceState.get(LEGACY_STATE_KEY),
  );
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
      if (event.type === "notice")
        void vscode.window.showInformationMessage(
          `GaoGrid: ${(message as { message: string }).message}`,
        );
      if (viewReady || (event.type === "data" && replayed.has(event.sessionId)))
        void view?.webview.postMessage(message);
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
      tmuxConfigPath: path.join(context.extensionPath, "media", "tmux.conf"),
      defaultShell: () =>
        vscode.workspace
          .getConfiguration("gaogrid")
          .get<string>("defaultShell", "") ||
        (process.platform === "win32"
          ? "powershell.exe"
          : process.env.SHELL || "/bin/bash"),
    },
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
  const provider: vscode.WebviewViewProvider = {
    resolveWebviewView(webviewView) {
      view = webviewView;
      viewReady = false;
      viewGeneration++;
      replayed.clear();
      webviewView.webview.options = {
        enableScripts: true,
        localResourceRoots: [
          vscode.Uri.file(path.join(context.extensionPath, "dist")),
          vscode.Uri.file(path.join(context.extensionPath, "node_modules")),
        ],
      };
      webviewView.webview.html = getHtml(webviewView.webview, context);
      webviewView.onDidDispose(() => {
        if (view === webviewView) {
          view = undefined;
          viewReady = false;
          void vscode.commands.executeCommand(
            "setContext",
            "gaogridFocus",
            false,
          );
        }
      });
      webviewView.webview.onDidReceiveMessage(async (message) => {
        if (stopping) return;
        switch (message.type) {
          case "ready":
            const generation = ++viewGeneration;
            viewReady = false;
            replayed.clear();
            await Promise.all(
              state.workspaces
                .flatMap((workspace) => getTabs(workspace.root))
                .map((tab) =>
                  manager.start(tab.sessionId, tab.cwd, tab.profile, true, tab),
                ),
            );
            await persist();
            const capabilities = await manager.tmux.capabilities();
            if (view !== webviewView || generation !== viewGeneration) break;
            webviewView.webview.postMessage({
              type: "init",
              state,
              capabilities,
            });
            webviewView.webview.postMessage({
              type: "settings",
              settings: terminalSettings(),
            });
            await Promise.all(
              state.workspaces
                .flatMap((workspace) => getTabs(workspace.root))
                .map(async (tab) => {
                  const snapshot = await manager.replay(
                    tab.sessionId,
                    (snapshot) => {
                      if (view !== webviewView || generation !== viewGeneration)
                        return;
                      webviewView.webview.postMessage({
                        type: "replay",
                        sessionId: tab.sessionId,
                        ...snapshot,
                      });
                      replayed.add(tab.sessionId);
                    },
                  );
                  if (
                    !snapshot &&
                    view === webviewView &&
                    generation === viewGeneration
                  ) {
                    const output = manager.output(tab.sessionId);
                    if (output)
                      webviewView.webview.postMessage({
                        type: "replay",
                        sessionId: tab.sessionId,
                        data: output,
                      });
                    replayed.add(tab.sessionId);
                  }
                }),
            );
            if (view !== webviewView || generation !== viewGeneration) break;
            viewReady = true;
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
          case "persist":
            state = message.state;
            await persist();
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
                const metadata = await manager.promote(request.sessionId);
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
              } else if (request.kind === "unprotect") {
                const tab = state.workspaces
                  .flatMap((workspace) => getTabs(workspace.root))
                  .find((item) => item.sessionId === request.sessionId);
                if (!tab || tab.backend !== "tmux")
                  throw new Error("Protected tab is no longer available.");
                if (
                  (await manager.activeTasks([tab.sessionId])).has(
                    tab.sessionId,
                  )
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
              } else throw new Error("Unknown terminal lifecycle operation.");
              webviewView.webview.postMessage({
                type: "lifecycleResult",
                requestId: message.requestId,
                value,
              });
            } catch (error) {
              webviewView.webview.postMessage({
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
            manager.input(message.sessionId, message.data);
            break;
          case "dropPaths": {
            const resources: unknown[] = Array.isArray(message.resources)
              ? message.resources
              : [];
            const paths = resources
              .map(droppedPath)
              .filter((value): value is string => !!value);
            if (
              !paths.length &&
              Array.isArray(message.names) &&
              message.names.length
            ) {
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
              webviewView.webview.postMessage({
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
    },
  };
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("gaogrid.view", provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );
  context.subscriptions.push(
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
    }),
  );
  shutdown = async () => {
    stopping = true;
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
