import type { TestContext } from "node:test";
import type { Terminal } from "@xterm/xterm";
import type { TerminalTab } from "../../src/model";

export function frontend(
  t: TestContext,
  cols = 80,
  rows = 6,
  onMessage?: (message: any) => void,
) {
  // Mount the real browser xterm without opening a renderer. Layout and font
  // callbacks stay deferred; parsing, addons, replay, and reset are real.
  const globals = {
    self: globalThis,
    document: {
      body: {},
      fonts: { ready: new Promise(() => {}), addEventListener() {} },
    },
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    ResizeObserver: class {
      observe() {}
      unobserve() {}
    },
    MutationObserver: class {
      observe() {}
    },
    requestAnimationFrame: () => 1,
  };
  const previous = new Map(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  t.after(() => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  const { TerminalFrontend } =
    require("../../src/webview/terminal-frontend") as typeof import("../../src/webview/terminal-frontend");
  const sent: any[] = [];
  const view = new TerminalFrontend((message) => {
    sent.push(message);
    onMessage?.(message);
  });
  const tab: TerminalTab = {
    id: "emoji-tab",
    sessionId: "emoji-session",
    title: "shell",
    cwd: "/",
    backend: "direct",
  };
  const host = new EventTarget() as unknown as HTMLElement;
  view.replay(tab.sessionId, "", cols, rows);
  const mount = () => view.mount(tab, host);
  mount();
  const terminal = (
    view as unknown as { surfaces: Map<string, { terminal: Terminal }> }
  ).surfaces.get(tab.id)!.terminal;
  t.after(() => view.disposeTab(tab));
  return {
    terminal,
    view,
    mount,
    tab,
    sent,
    write: (data: string) => view.write(tab.sessionId, data),
  };
}
