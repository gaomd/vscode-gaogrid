import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { Terminal as HeadlessTerminal } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import { TerminalHistory } from "../src/terminal-history";
import type { Terminal } from "@xterm/xterm";
import type { TerminalTab } from "../src/model";

const rightPrompt = "via 🐍 v3.15.0 is 📦 v0.1.0";

// zsh counts each of these Emoji as two columns and leaves one column unused
// at the right margin, then moves back to the end of the left prompt.
function prompt(cols: number) {
  const width = Array.from(rightPrompt).length + 2;
  const padding = cols - 2 - width - 1;
  return `% \x1b[${padding}C${rightPrompt}\x1b[${padding + width}D`;
}

function frontend(t: TestContext, cols = 80, rows = 6) {
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
    require("../src/webview/terminal-frontend") as typeof import("../src/webview/terminal-frontend");
  const view = new TerminalFrontend(() => {});
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
    write: (data: string) => view.write(tab.sessionId, data),
  };
}

function history(t: TestContext, cols = 80, rows = 6) {
  const output = new TerminalHistory(cols, rows);
  t.after(() => output.dispose());
  return {
    terminal: (output as unknown as { terminal: HeadlessTerminal }).terminal,
    write: (data: string) => output.write(data),
    output,
  };
}

function parsed(terminal: Terminal | HeadlessTerminal) {
  return new Promise<void>((resolve) => terminal.write("", resolve));
}

for (const [name, create] of [
  ["frontend", frontend],
  ["headless history", history],
] as const) {
  test(`${name} enables Unicode 11 before output and uses two columns for Emoji`, async (t) => {
    const h = create(t);
    assert.equal(h.terminal.unicode.activeVersion, "11");
    h.write("A🐍📦B");
    await parsed(h.terminal);
    const line = h.terminal.buffer.active.getLine(0)!;
    assert.equal(line.translateToString(true), "A🐍📦B");
    assert.equal(line.getCell(1)!.getWidth(), 2);
    assert.equal(line.getCell(2)!.getWidth(), 0);
    assert.equal(line.getCell(3)!.getWidth(), 2);
    assert.equal(line.getCell(4)!.getWidth(), 0);
    assert.equal(h.terminal.buffer.active.cursorX, 6);

    // Erase B with Backspace, then remove the two-column box and replace it.
    h.write("\b \b\x1b[2D\x1b[2Px");
    await parsed(h.terminal);
    assert.equal(line.translateToString(true), "A🐍x");
    assert.equal(h.terminal.buffer.active.cursorX, 4);
  });

  test(`${name} returns to column two after drawing zsh's Emoji right prompt`, async (t) => {
    const h = create(t);
    h.write(prompt(80));
    await parsed(h.terminal);
    assert.equal(h.terminal.buffer.active.cursorX, 2);
    h.write("x");
    await parsed(h.terminal);
    const line = h.terminal.buffer.active.getLine(0)!.translateToString(true);
    assert.ok(line.startsWith("% x"), line);
    assert.ok(line.endsWith(rightPrompt), line);
    assert.equal(h.terminal.buffer.active.cursorX, 3);
  });

  test(`${name} wraps Emoji at cell boundaries and retains output through resize`, async (t) => {
    const h = create(t, 8);
    h.write("123456🐍📦ab");
    await parsed(h.terminal);
    const buffer = h.terminal.buffer.active;
    assert.equal(buffer.getLine(0)!.translateToString(true), "123456🐍");
    assert.equal(buffer.getLine(1)!.translateToString(true), "📦ab");
    assert.equal(buffer.getLine(1)!.isWrapped, true);
    assert.equal(buffer.cursorX, 4);
    assert.equal(buffer.cursorY, 1);
    // A later prompt leaves the wrapped line available for xterm's reflow.
    h.write("\r\n% ");
    await parsed(h.terminal);
    for (const cols of [5, 20]) {
      h.terminal.resize(cols, 6);
      const text = Array.from({ length: buffer.length }, (_, index) =>
        buffer.getLine(index)!.translateToString(true),
      ).join("");
      assert.ok(text.includes("123456🐍📦ab"), text);
      assert.equal(buffer.cursorX, 2);
    }
  });
}

test("live history replay, reset, and tab remount retain Emoji widths and the prompt cursor", async (t) => {
  const h = history(t);
  h.write("SAVED 🐍📦\r\n" + prompt(80));
  const snapshot = await h.output.snapshot(undefined, true);
  const f = frontend(t);
  f.view.replay(f.tab.sessionId, snapshot.data, snapshot.cols, snapshot.rows);
  await parsed(f.terminal);
  assert.equal(f.terminal.unicode.activeVersion, "11");
  assert.equal(f.terminal.buffer.active.cursorX, 2);
  f.mount(); // Selecting the tab again must keep its existing terminal.
  assert.equal(f.terminal.buffer.active.getLine(0)!.getCell(6)!.getWidth(), 2);
  f.write("x");
  await parsed(f.terminal);
  assert.ok(
    f.terminal.buffer.active
      .getLine(1)!
      .translateToString(true)
      .startsWith("% x"),
  );
});

test("Unicode 6 disk snapshots keep saved output and leave a fresh prompt usable under Unicode 11", async (t) => {
  const legacy = new HeadlessTerminal({
    cols: 80,
    rows: 6,
    allowProposedApi: true,
  });
  t.after(() => legacy.dispose());
  const serializer = new SerializeAddon();
  legacy.loadAddon(serializer);
  assert.equal(legacy.unicode.activeVersion, "6");
  legacy.write("LEGACY 🐍📦\r\n" + prompt(80));
  await parsed(legacy);
  assert.equal(
    legacy.buffer.active.cursorX,
    0,
    "reproduce the old cursor error",
  );
  const data = serializer.serialize({
    excludeModes: true,
    excludeAltBuffer: true,
  });

  const h = history(t);
  // PtyManager places the ended-session notice and a fresh shell after saved
  // output, rather than continuing an old process at its serialized cursor.
  h.write(
    data + "\x1b[0m\r\n[GaoGrid] Previous Direct Session ended.\r\n\r\n% ",
  );
  const snapshot = await h.output.snapshot();
  const f = frontend(t);
  // Exercise output queued before the tab is mounted as well as normal replay.
  const second = {
    ...f.tab,
    id: "restored-tab",
    sessionId: "restored-session",
  };
  f.view.replay(second.sessionId, snapshot.data, snapshot.cols, snapshot.rows);
  f.view.mount(second, new EventTarget() as unknown as HTMLElement);
  const terminal = (
    f.view as unknown as { surfaces: Map<string, { terminal: Terminal }> }
  ).surfaces.get(second.id)!.terminal;
  t.after(() => f.view.disposeTab(second));
  f.view.write(second.sessionId, "x");
  await parsed(terminal);
  const buffer = terminal.buffer.active;
  assert.equal(terminal.unicode.activeVersion, "11");
  assert.equal(buffer.getLine(0)!.getCell(7)!.getWidth(), 2);
  assert.match(buffer.getLine(0)!.translateToString(true), /LEGACY 🐍📦/);
  assert.equal(buffer.getLine(buffer.cursorY)!.translateToString(true), "% x");
  assert.equal(buffer.cursorX, 3);
});
