import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { Terminal as HeadlessTerminal } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import { TerminalHistory } from "../src/terminal-history";
import type { Terminal } from "@xterm/xterm";
import { frontend } from "./fixtures/terminal-frontend";

const rightPrompt = "via 🐍 v3.15.0 is 📦 v0.1.0";

// zsh counts each of these Emoji as two columns and leaves one column unused
// at the right margin, then moves back to the end of the left prompt.
function prompt(cols: number) {
  const width = Array.from(rightPrompt).length + 2;
  const padding = cols - 2 - width - 1;
  return `% \x1b[${padding}C${rightPrompt}\x1b[${padding + width}D`;
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

test("frontend forwards binary mouse reports separately from UTF-8 input", (t) => {
  const f = frontend(t);
  const legacyMouse = "\x1b[M\x20\x80\xff";
  // Exercise xterm's binary event source; production uses only onBinary.
  (f.terminal as any)._core.coreService.triggerBinaryEvent(legacyMouse);
  f.terminal.input("中文\x1b[<0;3;4M");
  const input = f.sent.filter((message) => message.type === "input");
  assert.deepEqual(input, [
    {
      type: "input",
      sessionId: f.tab.sessionId,
      data: legacyMouse,
      binary: true,
    },
    { type: "input", sessionId: f.tab.sessionId, data: "中文\x1b[<0;3;4M" },
  ]);
});

test("frontend ACKs only parsed output and ignores packets from a replaced stream", async (t) => {
  const f = frontend(t);
  const streamId = f.sent.find(
    (message) => message.type === "subscribeOutput",
  ).streamId;
  const packet = {
    sessionId: f.tab.sessionId,
    streamId,
    sequence: 2,
    type: "replay" as const,
    data: "% ",
    cols: 80,
    rows: 6,
  };
  f.view.receiveOutput(packet);
  assert.equal(
    f.sent.some((message) => message.type === "outputParsed"),
    false,
  );
  await parsed(f.terminal);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    f.sent.find((message) => message.type === "outputParsed").sequence,
    2,
  );
  f.view.receiveOutput({ ...packet, type: "data", data: "🐍", sequence: 4 });
  await parsed(f.terminal);
  assert.equal(f.terminal.buffer.active.cursorX, 4);
  f.view.reset(f.tab.sessionId);
  const newId = f.sent
    .filter((message) => message.type === "subscribeOutput")
    .at(-1).streamId;
  assert.notEqual(newId, streamId);
  f.view.receiveOutput({ ...packet, type: "data", data: "STALE", sequence: 9 });
  f.view.receiveOutput({
    ...packet,
    streamId: newId,
    data: "CURRENT",
    sequence: 7,
  });
  await parsed(f.terminal);
  assert.equal(
    f.terminal.buffer.active.getLine(0)!.translateToString(true),
    "CURRENT",
  );
});

test("a reset between parsing and sending an ACK cannot starve the new stream", async (t) => {
  const f = frontend(t);
  const queued: (() => void)[] = [];
  const original = globalThis.queueMicrotask;
  globalThis.queueMicrotask = (callback) => queued.push(callback);
  t.after(() => {
    globalThis.queueMicrotask = original;
  });
  const packet = (streamId: string, data: string) => ({
    type: "replay" as const,
    sessionId: f.tab.sessionId,
    streamId,
    sequence: data.length,
    data,
    cols: 80,
    rows: 6,
  });
  const oldId = f.sent.at(-1).streamId;
  f.view.receiveOutput(packet(oldId, "OLD"));
  await parsed(f.terminal);
  assert.equal(queued.length, 1);
  f.view.reset(f.tab.sessionId);
  const newId = f.sent.at(-1).streamId;
  f.view.receiveOutput(packet(newId, "NEW"));
  await parsed(f.terminal);
  assert.equal(queued.length, 2);
  for (const send of queued) send();
  assert.deepEqual(
    f.sent.filter((message) => message.type === "outputParsed"),
    [
      {
        type: "outputParsed",
        sessionId: f.tab.sessionId,
        streamId: newId,
        sequence: 3,
      },
    ],
  );
});

test("hidden live replay preserves modes, resizes, and never replies to stale terminal queries", async (t) => {
  const h = history(t, 35, 8);
  h.write(
    "NORMAL 🐍\r\n\x1b[?1049h\x1b[HLIVE 中文📦\x1b[?25l\x1b[?2004h\x1b[?1000h\x1b[?1006h\x1b[6n\x1b[c",
  );
  const snapshot = await h.output.snapshot(undefined, true);
  const f = frontend(t);
  const streamId = f.sent.at(-1).streamId;
  f.view.receiveOutput({
    type: "replay",
    sessionId: f.tab.sessionId,
    streamId,
    sequence: snapshot.data.length,
    ...snapshot,
  });
  await parsed(f.terminal);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    f.terminal.element,
    undefined,
    "hidden terminals parse without opening a renderer",
  );
  assert.equal(f.terminal.cols, 35);
  assert.equal(f.terminal.rows, 8);
  assert.equal(f.terminal.buffer.active.type, "alternate");
  assert.equal(f.terminal.modes.bracketedPasteMode, true);
  assert.equal(f.terminal.modes.mouseTrackingMode, "vt200");
  assert.ok(snapshot.data.includes("\x1b[?25l"));
  assert.ok(snapshot.data.includes("\x1b[?1006h"));
  assert.equal(f.sent.filter((message) => message.type === "input").length, 0);
  assert.equal(
    f.sent.filter((message) => message.type === "outputParsed").length,
    1,
  );
  f.terminal.resize(20, 10);
  f.mount();
  assert.equal(f.terminal.cols, 20);
  const exit = "\x1b[?1049lX";
  f.view.receiveOutput({
    type: "data",
    sessionId: f.tab.sessionId,
    streamId,
    sequence: snapshot.data.length + exit.length,
    data: exit,
  });
  await parsed(f.terminal);
  assert.equal(f.terminal.buffer.active.type, "normal");
  assert.match(
    f.terminal.buffer.active.getLine(0)!.translateToString(true),
    /NORMAL 🐍/,
  );
});

for (const [name, create] of [
  ["frontend", frontend],
  ["headless history", history],
] as const) {
  test(`${name} retains complex Unicode sequences without claiming grapheme-width parity`, async (t) => {
    const h = create(t);
    const text = "中文 e\u0301 🇨🇳 👍🏽 👩‍💻";
    h.write(text);
    await parsed(h.terminal);
    const line = h.terminal.buffer.active.getLine(0)!;
    assert.equal(line.translateToString(true), text);
    assert.equal(line.getCell(0)!.getWidth(), 2);
    assert.equal(line.getCell(5)!.getChars(), "e\u0301");
    assert.equal(h.terminal.buffer.active.cursorX, 19);
  });
}

test("unmounted terminals discard raw tails and request a fresh snapshot when mounted", async (t) => {
  const f = frontend(t);
  const tab = {
    ...f.tab,
    id: "background-tab",
    sessionId: "background-session",
  };
  f.view.write(tab.sessionId, "\x1b[31m" + "x".repeat(2_000_001) + "🐍");
  assert.equal((f.view as any).pendingSnapshots.has(tab.sessionId), false);
  f.view.mount(tab, new EventTarget() as unknown as HTMLElement);
  t.after(() => f.view.disposeTab(tab));
  const subscription = f.sent.find(
    (message) => message.sessionId === tab.sessionId,
  );
  assert.equal(subscription.type, "subscribeOutput");
  const data = "\x1b[31mLATEST 🐍📦\x1b[0m\r\n% ";
  f.view.receiveOutput({
    ...subscription,
    type: "replay",
    sequence: data.length,
    data,
    cols: 80,
    rows: 6,
  });
  const terminal = (f.view as any).surfaces.get(tab.id).terminal as Terminal;
  await parsed(terminal);
  assert.equal(
    terminal.buffer.active.getLine(0)!.translateToString(true),
    "LATEST 🐍📦",
  );
  assert.equal(terminal.buffer.active.cursorX, 2);
  assert.equal(terminal.buffer.active.getLine(0)!.getCell(7)!.getWidth(), 2);
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
