import type { PersistedState } from "../model";
import { TerminalFrontend } from "./terminal-frontend";
import { WorkspaceController } from "./workspace-controller";
import { resolveShortcut } from "./shortcuts";
import "./style.css";
import type { LifecycleRequest, LifecycleResult } from "../terminal-protocol";

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();
const root = document.getElementById("root")!;
const send = (message: unknown) => vscode.postMessage(message);
const terminals = new TerminalFrontend(send);
const pending = new Map<
  string,
  { resolve(value: LifecycleResult): void; reject(error: Error): void }
>();
const workspaces = new WorkspaceController(root, terminals, {
  send,
  request(request: LifecycleRequest) {
    return new Promise<LifecycleResult>((resolve, reject) => {
      const requestId = crypto.randomUUID();
      pending.set(requestId, { resolve, reject });
      send({ type: "lifecycle", requestId, request });
    });
  },
  persist(state) {
    vscode.setState(state);
    send({ type: "persist", state });
  },
});

window.addEventListener("message", ({ data: message }) => {
  switch (message.type) {
    case "lifecycleResult": {
      const request = pending.get(message.requestId);
      pending.delete(message.requestId);
      if (message.error) request?.reject(new Error(message.error));
      else request?.resolve(message.value);
      break;
    }
    case "metadata":
      workspaces.updateTerminal(message.sessionId, message);
      break;
    case "init":
      workspaces.restore(message.state);
      workspaces.setCapabilities(message.capabilities);
      break;
    case "action":
      workspaces.performAction(message.action, message.index, message.options);
      break;
    case "reset":
      terminals.reset(message.sessionId);
      break;
    case "data":
    case "replay":
      terminals.write(message.sessionId, message.data);
      break;
    case "paste":
      if (typeof message.text === "string")
        terminals.paste(message.sessionId, message.text);
      break;
    case "exit":
      terminals.write(
        message.sessionId,
        `\r\n[process exited: ${message.exitCode}]\r\n`,
      );
      break;
    case "error":
      terminals.write(message.sessionId, `\r\n${message.message}\r\n`);
      break;
    case "settings":
    case "theme":
      terminals.applySettings(message.settings);
      break;
  }
});

// This listener only receives keystrokes while the webview owns focus. Native
// view commands use the same controller actions through VS Code messages.
document.addEventListener(
  "keydown",
  (event) => {
    const shortcut = resolveShortcut(event);
    if (!shortcut) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    workspaces.performAction(shortcut.action, shortcut.index);
  },
  true,
);

document.addEventListener("focusin", () =>
  send({ type: "focus", focused: true }),
);
window.addEventListener("blur", () => send({ type: "focus", focused: false }));
document.addEventListener("focusout", () => {
  queueMicrotask(() => {
    if (!document.hasFocus()) send({ type: "focus", focused: false });
  });
});
send({ type: "ready" });
