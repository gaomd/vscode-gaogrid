import * as vscode from "vscode";
import * as path from "path";
import { randomUUID } from "crypto";
import { PtyManager } from "./pty-manager";
import { PersistedState, TerminalTab, Workspace } from "./model";

const STATE_KEY = "gaogrid.state.v1";
export function activate(context: vscode.ExtensionContext) {
  let view: vscode.WebviewView | undefined;
  let state = context.workspaceState.get<PersistedState>(STATE_KEY) || {
    workspaces: [],
    activeWorkspaceId: "",
  };
  const manager = new PtyManager((message) =>
    view?.webview.postMessage(message),
  );
  const persist = async () => {
    const cwdUpdates = new Map<string, string>();
    for (const ws of state.workspaces)
      walkTabs(ws.root, (tab) => {
        const cwd = manager.cwd(tab.sessionId);
        if (cwd) cwdUpdates.set(tab.id, cwd);
      });
    state = {
      ...state,
      workspaces: state.workspaces.map((ws) => ({
        ...ws,
        root: updateCwds(ws.root, cwdUpdates),
      })),
    };
    await context.workspaceState.update(STATE_KEY, state);
  };
  const provider: vscode.WebviewViewProvider = {
    resolveWebviewView(webviewView) {
      view = webviewView;
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
          void vscode.commands.executeCommand(
            "setContext",
            "gaogridFocus",
            false,
          );
        }
      });
      webviewView.webview.onDidReceiveMessage(async (message) => {
        switch (message.type) {
          case "ready":
            for (const ws of state.workspaces)
              walkTabs(ws.root, (tab) =>
                manager.start(tab.sessionId, tab.cwd, tab.profile),
              );
            webviewView.webview.postMessage({ type: "init", state });
            webviewView.webview.postMessage({
              type: "settings",
              settings: terminalSettings(),
            });
            for (const ws of state.workspaces)
              walkTabs(ws.root, (tab) => {
                const output = manager.output(tab.sessionId);
                if (output)
                  webviewView.webview.postMessage({
                    type: "replay",
                    sessionId: tab.sessionId,
                    data: output,
                  });
              });
            break;
          case "persist":
            state = message.state;
            await persist();
            break;
          case "start":
            manager.start(message.sessionId, message.cwd, message.profile);
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
          case "close":
            manager.close(message.sessionId);
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
            const cwd = manager.cwd(message.sessionId);
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
    vscode.commands.registerCommand("gaogrid.newTab", () =>
      post({ type: "action", action: "newTab" }),
    ),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("gaogrid.closeTab", () =>
      post({ type: "action", action: "closeTab" }),
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
  context.subscriptions.push({
    dispose: () => {
      void persist();
      manager.closeAll();
    },
  });
  function post(message: unknown) {
    view?.webview.postMessage(message);
  }
}
export function deactivate() {}

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
function walkTabs(
  node: Workspace["root"],
  cb: (tab: TerminalTab) => void,
): void {
  if (!node) return;
  if (node.type === "pane") node.tabs.forEach(cb);
  else {
    walkTabs(node.first, cb);
    walkTabs(node.second, cb);
  }
}
function updateCwds(
  node: Workspace["root"],
  updates: Map<string, string>,
): Workspace["root"] {
  if (!node) return null;
  if (node.type === "pane")
    return {
      ...node,
      tabs: node.tabs.map((t) => ({ ...t, cwd: updates.get(t.id) || t.cwd })),
    };
  return {
    ...node,
    first: updateCwds(node.first, updates)!,
    second: updateCwds(node.second, updates)!,
  };
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
