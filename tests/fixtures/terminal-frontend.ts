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
  const animationFrames: FrameRequestCallback[] = [];
  const globals = {
    self: globalThis,
    document: {
      body: {},
      documentElement: { style: { setProperty() {} } },
      hidden: false,
      fonts: { ready: new Promise(() => {}), addEventListener() {} },
      addEventListener() {},
    },
    window: { addEventListener() {} },
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    ResizeObserver: class {
      observe() {}
      unobserve() {}
    },
    MutationObserver: class {
      observe() {}
    },
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    },
  };
  const previous = new Map(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  const restoreGlobals = () => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
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
  t.after(async () => {
    view.disposeTab(tab);
    await new Promise((resolve) => setImmediate(resolve));
    restoreGlobals();
  });
  return {
    terminal,
    host,
    view,
    mount,
    tab,
    sent,
    runAnimationFrames() {
      for (let pass = 0; pass < 16 && animationFrames.length; pass++)
        for (const callback of animationFrames.splice(0))
          callback(performance.now());
    },
    write: (data: string) => view.write(tab.sessionId, data),
  };
}
