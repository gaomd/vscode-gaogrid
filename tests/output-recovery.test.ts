import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  writeFile,
  readFile,
  readdir,
  stat,
  realpath,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { Terminal } from "@xterm/headless";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { TerminalHistory } from "../src/terminal-history";
import { TerminalOutputStore } from "../src/terminal-output-store";
import { PtyManager } from "../src/pty-manager";

async function until(check: () => boolean | Promise<boolean>, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for output recovery.");
}
async function render(data: string, cols = 80, rows = 24) {
  const terminal = new Terminal({
    cols,
    rows,
    allowProposedApi: true,
    scrollback: 10000,
  });
  terminal.loadAddon(new Unicode11Addon());
  terminal.unicode.activeVersion = "11";
  await new Promise<void>((resolve) => terminal.write(data, resolve));
  const buffer = terminal.buffer.active;
  const text = Array.from(
    { length: buffer.length },
    (_, index) => buffer.getLine(index)?.translateToString(true) || "",
  ).join("\n");
  return { terminal, text };
}

test("output snapshots retain rendered scrollback, Unicode and colors without replaying queries or modes", async () => {
  const history = new TerminalHistory(90, 30);
  history.write(
    "old progress\r\x1b[2K\x1b[38;2;12;34;56mFINAL 中文\x1b[0m\r\n",
  );
  history.write("\x1b[6n\x1b[c\x1b]52;c;PRIVATE\x07\x1b[?2004h\x1b[?1000h");
  const snapshot = await history.snapshot();
  const { terminal, text } = await render(
    snapshot.data,
    snapshot.cols,
    snapshot.rows,
  );
  assert.match(text, /FINAL 中文/);
  assert.ok(!text.includes("old progress"));
  assert.equal(
    terminal.buffer.active.getLine(0)?.getCell(0)?.getFgColor(),
    0x0c2238,
  );
  assert.equal(terminal.modes.bracketedPasteMode, false);
  assert.equal(terminal.modes.mouseTrackingMode, "none");
  assert.ok(!snapshot.data.includes("PRIVATE"));
  assert.ok(!snapshot.data.includes("\x1b[6n"));
  terminal.dispose();
  history.dispose();
});

test("a stopped application's alternate screen is flattened into history for the new shell", async () => {
  const history = new TerminalHistory(80, 24);
  history.write("PREVIOUS_SHELL\r\n\x1b[?1049h\x1b[HALTERNATE_APP\x1b[?1000h");
  const snapshot = await history.snapshot();
  const { terminal, text } = await render(snapshot.data);
  assert.match(text, /PREVIOUS_SHELL/);
  assert.match(text, /ALTERNATE_APP/);
  assert.equal(terminal.buffer.active.type, "normal");
  assert.equal(terminal.modes.mouseTrackingMode, "none");
  terminal.dispose();
  history.dispose();
});

test("snapshots use atomic, private storage and explicit deletion waits for pending saves", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gaogrid-output-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new TerminalOutputStore(join(root, "storage"));
  assert.equal(await store.read("tab"), undefined);
  const value = { version: 1 as const, cols: 80, rows: 24, data: "FIRST" };
  await Promise.all([
    store.save("../tab", value),
    store.save("../tab", { ...value, data: "LATEST" }),
  ]);
  assert.equal((await store.read("../tab"))?.data, "LATEST");
  const files = await readdir(join(root, "storage"));
  assert.equal(files.length, 1);
  assert.match(files[0], /^[a-f0-9]{64}\.json$/);
  if (process.platform !== "win32")
    assert.equal(
      (await stat(join(root, "storage", files[0]))).mode & 0o777,
      0o600,
    );
  await writeFile(join(root, "storage", files[0]), "{corrupt");
  assert.equal(await store.read("../tab"), undefined);
  await Promise.all([store.save("../tab", value), store.remove("../tab")]);
  assert.equal(await store.read("../tab"), undefined);
});

test("a new direct session recovers saved output after shutdown, without rerunning old commands", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX shell");
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "gaogrid-output-recovery-")),
  );
  const store = new TerminalOutputStore(join(root, "storage"));
  await writeFile(join(root, ".bashrc"), "PS1='RECOVERY_READY> '\n");
  const managers: PtyManager[] = [];
  const make = () => {
    const manager = new PtyManager(() => {}, {
      defaultShell: () => "/bin/bash",
      defaultDirectories: () => [root],
      environment: { ...process.env, HOME: root },
      outputStore: store,
    });
    managers.push(manager);
    return manager;
  };
  t.after(async () => {
    for (const manager of managers) await manager.closeAll();
    await rm(root, { recursive: true, force: true });
  });
  const first = make();
  await first.start("tab", root);
  first.resize("tab", 110, 35);
  first.input(
    "tab",
    "for ((i=0;i<150;i++)); do printf 'SAVED_%s\\n' \"$i\"; done; printf '\\033[31mSAVED_COLOR_中文\\033[0m\\n'\r",
  );
  await until(() => first.output("tab")?.includes("SAVED_COLOR_中文") || false);
  await first.shutdown();
  const saved = await store.read("tab");
  assert.ok(saved);
  assert.match(saved.data, /SAVED_0/);
  assert.equal(saved.cols, 110);
  assert.equal(saved.rows, 35);
  const second = make();
  await second.start("tab", root, undefined, true);
  const replay = await second.replay("tab");
  assert.ok(replay);
  const { terminal, text } = await render(
    replay.data,
    replay.cols,
    replay.rows,
  );
  assert.match(text, /SAVED_0/);
  assert.match(text, /SAVED_149/);
  assert.match(text, /SAVED_COLOR_中文/);
  assert.match(text, /Previous Direct Session ended/);
  terminal.dispose();
  second.input("tab", "printf 'NEW_%s\\n' 'SHELL_WORKS'\r");
  await until(() => second.output("tab")?.includes("NEW_SHELL_WORKS") || false);
  await second.closeSessions(["tab"]);
  assert.equal(
    await store.read("tab"),
    undefined,
    "explicit close must delete recovery output",
  );
});

test("periodic output checkpoints survive a force-killed Extension Host", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX shell");
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "gaogrid-output-crash-")),
  );
  await writeFile(join(root, ".bashrc"), "PS1='RECOVERY_READY> '\n");
  const store = new TerminalOutputStore(join(root, "storage"));
  const child = spawn(
    process.execPath,
    [resolve("dist/tests/fixtures/direct-host.js"), root],
    { stdio: "ignore" },
  );
  const manager = new PtyManager(() => {}, {
    defaultShell: () => "/bin/bash",
    defaultDirectories: () => [root],
    environment: { ...process.env, HOME: root },
    outputStore: store,
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await manager.closeAll();
    await rm(root, { recursive: true, force: true });
  });
  await until(
    async () =>
      !!(await store.read("crash"))?.data.includes("OUTPUT_BEFORE_CRASH"),
  );
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  child.kill("SIGKILL");
  await exited;
  await manager.start("crash", root, undefined, true);
  const snapshot = await manager.replay("crash");
  assert.ok(snapshot);
  const { terminal, text } = await render(
    snapshot.data,
    snapshot.cols,
    snapshot.rows,
  );
  assert.match(text, /OUTPUT_BEFORE_CRASH/);
  assert.match(text, /Previous Direct Session ended/);
  terminal.dispose();
});

test("the replay barrier includes earlier output and forwards later output exactly once", async () => {
  const history = new TerminalHistory(80, 24);
  let ready = false;
  let live = "";
  history.write("BEFORE\r\n", () => {
    if (ready) live += "BEFORE\r\n";
  });
  const replay = history.snapshot(() => {
    ready = true;
  });
  history.write("AFTER\r\n", () => {
    if (ready) live += "AFTER\r\n";
  });
  const snapshot = await replay;
  await history.snapshot();
  assert.match(snapshot.data, /BEFORE/);
  assert.ok(!snapshot.data.includes("AFTER"));
  assert.equal(live, "AFTER\r\n");
  const rendered = await render(snapshot.data + live);
  assert.equal(rendered.text.split("BEFORE").length, 2);
  assert.equal(rendered.text.split("AFTER").length, 2);
  rendered.terminal.dispose();
  history.dispose();
});

test("live webview recreation retains the active application screen and input modes", async () => {
  const history = new TerminalHistory(80, 24);
  history.write(
    "NORMAL_HISTORY\r\n\x1b[?1049h\x1b[HLIVE_APP\x1b[?2004h\x1b[?1000h\x1b[?1006h",
  );
  const live = await history.snapshot(undefined, true);
  const rendered = await render(live.data);
  assert.equal(rendered.terminal.buffer.active.type, "alternate");
  assert.match(rendered.text, /LIVE_APP/);
  assert.equal(rendered.terminal.modes.bracketedPasteMode, true);
  assert.equal(rendered.terminal.modes.mouseTrackingMode, "vt200");
  assert.ok(
    live.data.includes("\x1b[?1006h"),
    "keep SGR mouse encoding for the live process",
  );
  rendered.terminal.dispose();
  history.dispose();
});
