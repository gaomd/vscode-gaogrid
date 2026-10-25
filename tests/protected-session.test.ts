import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  realpath,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { PtyManager } from "../src/pty-manager";
import { TerminalLifecycle } from "../src/terminal-lifecycle";
import { TmuxBackend } from "../src/tmux-backend";

const exec = promisify(execFile);
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
const config = resolve("media/tmux.conf");
async function until(check: () => boolean | Promise<boolean>, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error("Timed out waiting for protected terminal state.");
}
function running(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function setup(t: TestContext, shell = "/bin/bash") {
  if (process.platform === "win32") {
    t.skip("POSIX tmux");
    return;
  }
  try {
    await access(shell);
    await exec("tmux", ["-V"]);
  } catch {
    t.skip("tmux or shell unavailable");
    return;
  }
  const root = await realpath(await mkdtemp(join(tmpdir(), "gaogrid-tmux-")));
  await writeFile(
    join(root, shell.endsWith("zsh") ? ".zshrc" : ".bashrc"),
    "PS1='TMUX_READY> '\n",
  );
  const errors: string[] = [];
  const managers: PtyManager[] = [];
  const ids = new Set<string>();
  function manager() {
    const value = new PtyManager(
      (message) => {
        const event = message as {
          type: string;
          message: string;
          backendSessionId?: string;
        };
        if (event.type === "error") errors.push(event.message);
        if (event.type === "metadata" && event.backendSessionId)
          ids.add(event.backendSessionId);
      },
      {
        defaultShell: () => shell,
        defaultDirectories: () => [root],
        tmuxConfigPath: config,
        environment: { ...process.env, HOME: root, ZDOTDIR: undefined },
      },
    );
    managers.push(value);
    return value;
  }
  t.after(async () => {
    for (const value of managers) await value.closeAll();
    const backend = new TmuxBackend(config);
    for (const id of ids) await backend.destroy(id);
    await rm(root, { recursive: true, force: true });
  });
  return { root, errors, manager, ids };
}

for (const shell of ["/bin/bash", "/bin/zsh"]) {
  test(`${shell}: idle promotion, history, resize, task survival, reattach and explicit destruction`, async (t) => {
    const h = await setup(t, shell);
    if (!h) return;
    const manager = h.manager();
    const nested = join(h.root, "nested ' 中文");
    await mkdir(nested);
    await manager.start("tab", h.root);
    await until(() => manager.output("tab")?.includes("TMUX_READY>") || false);
    manager.input("tab", `cd ${quote(nested)}\r`);
    await until(async () => (await manager.cwd("tab")) === nested);
    manager.input("tab", "printf 'BEFORE_%s\\n' 'PROTECTION'\r");
    await until(
      () => manager.output("tab")?.includes("BEFORE_PROTECTION") || false,
    );
    const protectedTab = await manager.promote("tab");
    assert.equal(protectedTab?.backend, "tmux", h.errors.join("\n"));
    assert.equal(protectedTab?.cwd, nested);
    assert.equal(protectedTab?.profile, shell);
    const id = protectedTab!.backendSessionId!;
    const pane = await manager.tmux.inspect(id);
    assert.ok(pane);
    assert.match(manager.output("tab")!, /BEFORE_PROTECTION/);
    manager.input(
      "tab",
      `for ((i=0;i<100;i++)); do printf 'HISTORY_%s\\n' "$i"; done\r`,
    );
    await until(() => manager.output("tab")?.includes("HISTORY_99") || false);
    const history = await manager.tmux.history(id, 24);
    assert.match(history, /HISTORY_0/);
    assert.equal(history.split("HISTORY_0").length, 2);
    const pidFile = join(h.root, "job.pid");
    manager.input(
      "tab",
      `printf 'AFTER_%s\\n' 'PROTECTION'; sleep 300 & echo $! > ${quote(pidFile)}; wait\r`,
    );
    let taskPid = 0;
    await until(async () => {
      try {
        taskPid = +(await readFile(pidFile, "utf8"));
        return taskPid > 0;
      } catch {
        return false;
      }
    });
    assert.equal((await manager.activeTasks(["tab"])).has("tab"), true);
    for (const [cols, rows] of [
      [120, 40],
      [41, 12],
      [95, 27],
    ]) {
      manager.resize("tab", cols, rows);
      await until(
        async () =>
          (
            await exec("tmux", [
              "-L",
              "gaogrid",
              "display-message",
              "-p",
              "-t",
              `=${id}:0.0`,
              "#{pane_width}x#{pane_height}",
            ])
          ).stdout.trim() === `${cols}x${rows}`,
      );
    }
    const before = manager.output("tab");
    await manager.start("tab", nested, shell, true, protectedTab!);
    assert.ok(manager.output("tab")?.startsWith(before!)); // Webview recreation keeps its client.
    await manager.shutdown();
    assert.equal(running(taskPid), true);
    assert.equal((await manager.tmux.inspect(id))?.pid, pane.pid);
    const reconnected = h.manager();
    await reconnected.start("tab", nested, shell, true, protectedTab!);
    assert.equal(reconnected.metadata("tab")?.backendSessionId, id);
    assert.equal(
      reconnected.metadata("tab")?.connectionState,
      "connected",
      h.errors.join("\n"),
    );
    assert.equal((await reconnected.tmux.inspect(id))?.pid, pane.pid);
    assert.equal(running(taskPid), true);
    assert.match(reconnected.output("tab")!, /HISTORY_0/);
    await until(
      () => reconnected.output("tab")?.includes("AFTER_PROTECTION") || false,
    );
    assert.ok(
      !reconnected.output("tab")?.includes("BEFORE_PROTECTION"),
      "tmux recovery must not replay GaoGrid's old direct snapshot",
    );
    let approve = false;
    let prompts = 0;
    const lifecycle = new TerminalLifecycle(reconnected, async () => {
      prompts++;
      return approve;
    });
    const close = {
      scope: "workspace" as const,
      title: "work",
      terminals: [{ sessionId: "tab", title: "Codex" }],
    };
    assert.equal(await lifecycle.requestClose(close), false);
    assert.equal(running(taskPid), true);
    assert.ok(await reconnected.tmux.inspect(id));
    approve = true;
    assert.equal(await lifecycle.requestClose(close), true);
    assert.equal(prompts, 2);
    await until(() => !running(taskPid));
    assert.equal(await reconnected.tmux.inspect(id), undefined);
    assert.equal(reconnected.metadata("tab"), undefined);
    assert.deepEqual(h.errors, []);
  });
}

test("busy promotion leaves foreground/background tasks intact and supports direct protected creation", async (t) => {
  const h = await setup(t);
  if (!h) return;
  const manager = h.manager();
  await manager.start("busy", h.root);
  await until(() => manager.output("busy")?.includes("TMUX_READY>") || false);
  const pidFile = join(h.root, "busy.pid");
  manager.input("busy", `sleep 300 & echo $! > ${quote(pidFile)}; wait\r`);
  let pid = 0;
  await until(async () => {
    try {
      pid = +(await readFile(pidFile, "utf8"));
      return pid > 0;
    } catch {
      return false;
    }
  });
  assert.equal(await manager.promote("busy"), undefined);
  assert.equal(manager.metadata("busy")?.backend, "direct");
  assert.ok(running(pid));
  await manager.start("new", await manager.cwd("busy"), undefined, false, {
    backend: "tmux",
  });
  assert.equal(manager.metadata("new")?.backend, "tmux");
  assert.equal(
    manager.metadata("new")?.connectionState,
    "connected",
    h.errors.join("\n"),
  );
  assert.ok(running(pid));
  await until(async () => !(await manager.activeTasks(["new"])).has("new"));
  const close = new TerminalLifecycle(manager, async () => {
    throw new Error("Idle close must not prompt");
  });
  assert.equal(
    await close.requestClose({
      scope: "terminal",
      terminals: [{ sessionId: "new", title: "shell" }],
    }),
    true,
  );
  assert.ok(running(pid));
});

test("missing tmux session gets a fresh protected shell without relaunching an application", async (t) => {
  const h = await setup(t);
  if (!h) return;
  const manager = h.manager();
  await manager.start("lost", h.root, undefined, false, { backend: "tmux" });
  const saved = manager.metadata("lost")!;
  assert.equal(saved.connectionState, "connected", h.errors.join("\n"));
  await manager.shutdown();
  await manager.tmux.destroy(saved.backendSessionId!);
  const restored = h.manager();
  await restored.start("lost", h.root, undefined, true, saved);
  const metadata = restored.metadata("lost")!;
  assert.equal(metadata.backend, "tmux");
  assert.notEqual(metadata.backendSessionId, saved.backendSessionId);
  assert.equal(metadata.cwd, h.root);
  assert.match(
    restored.output("lost")!,
    /Protected session is no longer available/,
  );
  assert.equal((await restored.activeTasks(["lost"])).has("lost"), false);
});

test("failed promotion preserves the original direct PTY; failed reconnect retains live backend metadata", async (t) => {
  const h = await setup(t);
  if (!h) return;
  const manager = h.manager();
  await manager.start("source", h.root);
  await until(() => manager.output("source")?.includes("TMUX_READY>") || false);
  const create = manager.tmux.create.bind(manager.tmux);
  manager.tmux.create = async () => {
    throw new Error("injected create failure");
  };
  await assert.rejects(manager.promote("source"), /injected create failure/);
  assert.equal(manager.metadata("source")?.backend, "direct");
  manager.input("source", "printf 'STILL_%s\\n' 'USABLE'\r");
  await until(
    () => manager.output("source")?.includes("STILL_USABLE") || false,
  );
  manager.tmux.create = create;
  const attached = manager.tmux.attached.bind(manager.tmux);
  manager.tmux.attached = async () => {
    throw new Error("injected attach failure");
  };
  const beforeOrphans = await manager.tmux.orphans([]);
  await assert.rejects(manager.promote("source"), /injected attach failure/);
  assert.equal(manager.metadata("source")?.backend, "direct");
  assert.deepEqual(
    await manager.tmux.orphans([]),
    beforeOrphans,
    "failed promotion must not leak its prepared session",
  );
  manager.tmux.attached = attached;
  const saved = await manager.promote("source");
  assert.ok(saved);
  await manager.shutdown();
  const restored = h.manager();
  restored.tmux.attached = async () => {
    throw new Error("retry me");
  };
  await restored.start("source", h.root, undefined, true, saved);
  assert.equal(
    restored.metadata("source")?.backendSessionId,
    saved.backendSessionId,
  );
  assert.equal(restored.metadata("source")?.connectionState, "disconnected");
  assert.ok(await restored.tmux.inspect(saved.backendSessionId!));
  restored.tmux.attached = attached;
  await restored.start("source", h.root, undefined, false, saved);
  assert.equal(restored.metadata("source")?.connectionState, "connected");
});

test("capability detection is environment-local and absence leaves direct PTYs usable", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX shell");
  const manager = new PtyManager(() => {}, {
    defaultShell: () => "/bin/bash",
    defaultDirectories: () => [tmpdir()],
    tmuxConfigPath: config,
    environment: { ...process.env, PATH: "/nonexistent" },
  });
  t.after(() => manager.closeAll());
  assert.deepEqual(await manager.tmux.capabilities(), {
    tmux: { available: false },
  });
  await manager.start("direct", tmpdir());
  manager.input("direct", "printf 'DIRECT_%s' 'WORKS'\r");
  await until(
    () => manager.output("direct")?.includes("DIRECT_WORKS") || false,
  );
  assert.equal(manager.metadata("direct")?.backend, "direct");
});

test("ownership checks reject lookalikes and leave independent tmux servers untouched", async (t) => {
  const h = await setup(t);
  if (!h) return;
  const manager = h.manager();
  await manager.start("owned", h.root, undefined, false, { backend: "tmux" });
  const otherServer = `gaogrid-test-${randomUUID()}`;
  const lookalike = `gaogrid-${randomUUID()}`;
  await exec("tmux", [
    "-L",
    otherServer,
    "-f",
    config,
    "new-session",
    "-d",
    "-s",
    "unrelated",
    "-c",
    h.root,
  ]);
  await exec("tmux", [
    "-L",
    "gaogrid",
    "new-session",
    "-d",
    "-s",
    lookalike,
    "-c",
    h.root,
  ]);
  t.after(async () => {
    await exec("tmux", ["-L", otherServer, "kill-session", "-t", "=unrelated"]);
    await exec("tmux", [
      "-L",
      "gaogrid",
      "kill-session",
      "-t",
      `=${lookalike}`,
    ]);
  });
  await assert.rejects(manager.tmux.destroy(lookalike), /ownership/);
  await assert.rejects(manager.tmux.destroy("unrelated"), /identifier/);
  await manager.closeSessions(["owned"]);
  await exec("tmux", ["-L", otherServer, "has-session", "-t", "=unrelated"]);
  await exec("tmux", ["-L", "gaogrid", "has-session", "-t", `=${lookalike}`]);
});

test("a killed Extension Host leaves the protected task alive for a new host", async (t) => {
  const h = await setup(t);
  if (!h) return;
  const child = spawn(
    process.execPath,
    [resolve("dist/tests/fixtures/protected-host.js"), h.root],
    { stdio: "ignore" },
  );
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  });
  let pid = 0;
  await until(async () => {
    try {
      pid = +(await readFile(join(h.root, "crash-task.pid"), "utf8"));
      return pid > 0;
    } catch {
      return false;
    }
  });
  const saved = JSON.parse(
    await readFile(join(h.root, "backend.json"), "utf8"),
  );
  h.ids.add(saved.backendSessionId);
  const manager = h.manager();
  const pane = await manager.tmux.inspect(saved.backendSessionId);
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  child.kill("SIGKILL");
  await exited;
  assert.ok(running(pid));
  await manager.start("crash", h.root, undefined, true, saved);
  assert.equal(manager.metadata("crash")?.connectionState, "connected");
  assert.equal(
    (await manager.tmux.inspect(saved.backendSessionId))?.pid,
    pane?.pid,
  );
  assert.ok(running(pid));
  await manager.closeSessions(["crash"]);
  await until(() => !running(pid));
});

test("protected terminal carries colors, Unicode, bracketed paste, mouse and modified Enter", async (t) => {
  const h = await setup(t);
  if (!h) return;
  const manager = h.manager();
  const input = join(h.root, "input.bin");
  const script = join(h.root, "protocol.js");
  await writeFile(
    script,
    String.raw`
    const fs = require('node:fs');
    process.stdin.setRawMode(true);
    process.stdin.on('data', data => fs.appendFileSync(${JSON.stringify(input)}, data));
    process.stdout.write('\x1b[38;2;12;34;56mRGB\x1b[0m \x1b[38;5;202mPALETTE\x1b[0m 中文 \uf120 🚀\r\n');
    process.stdout.write('\x1b[>4;2m\x1b[?2004h\x1b[?1000h\x1b[?1006hPROTOCOL_READY');
  `,
  );
  await manager.start("protocol", h.root, undefined, false, {
    backend: "tmux",
  });
  manager.input(
    "protocol",
    `exec ${quote(process.execPath)} ${quote(script)}\r`,
  );
  await until(
    () => manager.output("protocol")?.includes("PROTOCOL_READY") || false,
  );
  const id = manager.metadata("protocol")!.backendSessionId!;
  const capture = (
    await exec("tmux", [
      "-L",
      "gaogrid",
      "capture-pane",
      "-p",
      "-e",
      "-t",
      `=${id}:0.0`,
    ])
  ).stdout;
  assert.match(capture, /38;2;12;34;56mRGB/);
  assert.match(capture, /38;5;202mPALETTE/);
  assert.match(capture, /中文 \uf120 🚀/);
  const paste = "\x1b[200~中文 paste\x1b[201~";
  const mouse = "\x1b[<0;3;4M";
  manager.input("protocol", paste + mouse + "\x1b[13;2u");
  let captured = "";
  await until(async () => {
    try {
      captured = await readFile(input, "utf8");
      return (
        captured.includes("中文 paste") &&
        (captured.includes("\x1b[13;2u") || captured.includes("\x1b[27;2;13~"))
      );
    } catch {
      return false;
    }
  });
  assert.ok(captured.includes(paste), "bracketed paste delimiters survive");
  assert.ok(captured.includes(mouse), "application mouse event survives");
});

test("vim alternate screen survives resizing and returns to the protected shell", async (t) => {
  const h = await setup(t);
  if (!h) return;
  try {
    await exec("vim", ["--version"]);
  } catch {
    return t.skip("vim unavailable");
  }
  const manager = h.manager();
  await manager.start("vim", h.root, undefined, false, { backend: "tmux" });
  const outputFile = join(h.root, "vim.txt");
  manager.input("vim", `vim -Nu NONE -n ${quote(outputFile)}\r`);
  await until(async () => (await manager.activeTasks(["vim"])).has("vim"));
  for (const [cols, rows] of [
    [120, 40],
    [40, 10],
    [90, 30],
  ])
    manager.resize("vim", cols, rows);
  await until(() => manager.output("vim")?.includes("vim.txt") || false);
  manager.input("vim", "iPROTECTED_VIM");
  manager.input("vim", "\x1b");
  const id = manager.metadata("vim")!.backendSessionId!;
  await until(async () => {
    const screen = (
      await exec("tmux", [
        "-L",
        "gaogrid",
        "capture-pane",
        "-p",
        "-t",
        `=${id}:0.0`,
      ])
    ).stdout;
    return screen.includes("PROTECTED_VIM") && !screen.includes("-- INSERT --");
  });
  manager.input("vim", ":wq\r");
  await until(async () => {
    try {
      return (await readFile(outputFile, "utf8")).includes("PROTECTED_VIM");
    } catch {
      return false;
    }
  }).catch(async () => {
    const id = manager.metadata("vim")!.backendSessionId!;
    const screen = (
      await exec("tmux", [
        "-L",
        "gaogrid",
        "capture-pane",
        "-p",
        "-t",
        `=${id}:0.0`,
      ])
    ).stdout;
    throw new Error(`vim did not save its buffer: ${screen}`);
  });
  await until(async () => !(await manager.activeTasks(["vim"])).has("vim"));
  assert.equal(manager.metadata("vim")?.connectionState, "connected");
});

test("input arriving during promotion aborts the switch and leaves the new task running directly", async (t) => {
  const h = await setup(t);
  if (!h) return;
  const manager = h.manager();
  await manager.start("racing", h.root);
  await until(() => manager.output("racing")?.includes("TMUX_READY>") || false);
  const create = manager.tmux.create.bind(manager.tmux);
  manager.tmux.create = async (...args) => {
    const id = await create(...args);
    manager.input("racing", "sleep 300\r");
    await until(async () =>
      (await manager.activeTasks(["racing"])).has("racing"),
    );
    return id;
  };
  assert.equal(await manager.promote("racing"), undefined);
  assert.equal(manager.metadata("racing")?.backend, "direct");
  assert.equal((await manager.activeTasks(["racing"])).has("racing"), true);
});

test("explicit protected close cleans up a process that ignores hangup and termination", async (t) => {
  const h = await setup(t);
  if (!h) return;
  const manager = h.manager();
  const file = join(h.root, "stubborn.pid");
  const script = join(h.root, "stubborn.js");
  await writeFile(
    script,
    `
    require('node:fs').writeFileSync(${JSON.stringify(file)}, String(process.pid));
    process.on('SIGHUP', () => {});
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
  `,
  );
  await manager.start("stubborn", h.root, undefined, false, {
    backend: "tmux",
  });
  manager.input(
    "stubborn",
    `exec ${quote(process.execPath)} ${quote(script)}\r`,
  );
  let pid = 0;
  await until(async () => {
    try {
      pid = +(await readFile(file, "utf8"));
      return pid > 0;
    } catch {
      return false;
    }
  });
  assert.equal((await manager.activeTasks(["stubborn"])).has("stubborn"), true);
  await manager.closeSessions(["stubborn"]);
  await until(() => !running(pid));
});
