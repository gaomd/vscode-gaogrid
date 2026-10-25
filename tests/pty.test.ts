import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  rm,
  access,
  readFile,
  writeFile,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { PtyManager } from "../src/pty-manager";
import { inspectProcesses } from "../src/process-inspector";
import { TerminalLifecycle } from "../src/terminal-lifecycle";

function running(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(check: () => boolean | Promise<boolean>, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for terminal state.");
}

for (const shell of ["/bin/zsh", "/bin/bash"]) {
  test(`${shell}: cwd inheritance, task protection, exit and shutdown`, async (t) => {
    if (process.platform === "win32") {
      t.skip("POSIX PTY test");
      return;
    }
    try {
      await access(shell);
    } catch {
      t.skip(`${shell} unavailable`);
      return;
    }
    const root = await realpath(await mkdtemp(join(tmpdir(), "gaogrid-pty-")));
    const nested = join(root, "nested #中文");
    await mkdir(nested);
    await writeFile(
      join(root, shell.endsWith("zsh") ? ".zshrc" : ".bashrc"),
      "PS1='PTY_READY> '\n",
    );
    const errors: string[] = [];
    const children: number[] = [];
    const manager = new PtyManager(
      (message) => {
        const event = message as { type: string; message: string };
        if (event.type === "error") errors.push(event.message);
      },
      {
        defaultShell: () => shell,
        defaultDirectories: () => [root],
        environment: {
          ...process.env,
          HOME: root,
          ZDOTDIR: undefined,
        },
      },
    );
    t.after(async () => {
      await manager.closeAll();
      for (const pid of children)
        if (running(pid)) process.kill(pid, "SIGKILL");
      await rm(root, { recursive: true, force: true });
    });
    await manager.start("one", root);
    assert.deepEqual(errors, [], "native PTY must start");
    await until(() => manager.output("one")?.includes("PTY_READY> ") || false);
    assert.ok(
      await inspectProcesses(),
      "PTY task tests require process inspection",
    );
    assert.equal((await manager.activeTasks(["one"])).has("one"), false);
    manager.input("one", `cd '${nested}'\r`);
    await until(async () => (await manager.cwd("one")) === nested);
    await manager.start("two", await manager.cwd("one"));
    assert.equal(await manager.cwd("two"), nested);
    // A stale OSC 7 must not permanently override a newer shell cwd.
    manager.input("one", `printf '\\033]7;file://localhost${root}\\007'\r`);
    await until(
      () =>
        manager.output("one")?.includes(`\x1b]7;file://localhost${root}\x07`) ||
        false,
    );
    assert.equal(await manager.cwd("one"), root);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(await manager.cwd("one"), nested);
    manager.input("one", "sleep 300\r");
    await until(async () => (await manager.activeTasks(["one"])).has("one"));
    manager.input("one", "\x03");
    await until(async () => !(await manager.activeTasks(["one"])).has("one"));
    const jobFile = join(root, "job.pid");
    manager.input("one", `sleep 300 & echo $! > '${jobFile}'\r`);
    await until(() => (manager.output("one") || "").includes("sleep 300 &"));
    await until(async () => {
      try {
        return +(await readFile(jobFile, "utf8")) > 0;
      } catch {
        return false;
      }
    });
    const jobPid = +(await readFile(jobFile, "utf8"));
    children.push(jobPid);
    await until(async () => (await manager.activeTasks(["one"])).has("one"));
    await manager.closeSessions(["one"]);
    assert.equal(manager.lastCwd("one"), undefined);
    await until(() => !running(jobPid));
    manager.input("two", "exit\r");
    await until(
      () => manager.output("two")?.includes("[process exited:") || false,
    );
    assert.equal(await manager.cwd("two"), nested);
    // Reopening the view must not restart an exited terminal or lose its cwd.
    await manager.start("two", root);
    assert.equal(await manager.cwd("two"), nested);

    await manager.start("protected", root);
    await until(
      () => manager.output("protected")?.includes("PTY_READY> ") || false,
    );
    const protectedPid = join(root, "protected.pid");
    manager.input(
      "protected",
      `sleep 300 & echo $! > '${protectedPid}'; wait\r`,
    );
    await until(async () => {
      try {
        return +(await readFile(protectedPid, "utf8")) > 0;
      } catch {
        return false;
      }
    });
    const taskPid = +(await readFile(protectedPid, "utf8"));
    children.push(taskPid);
    let approve = false;
    let prompts = 0;
    const lifecycle = new TerminalLifecycle(manager, async () => {
      prompts++;
      return approve;
    });
    const close = {
      scope: "terminal" as const,
      terminals: [{ sessionId: "protected", title: "shell" }],
    };
    const output = manager.output("protected");
    assert.equal(await lifecycle.requestClose(close), false);
    assert.equal(prompts, 1);
    assert.equal(running(taskPid), true);
    assert.ok(manager.output("protected")?.startsWith(output!));
    approve = true;
    assert.equal(await lifecycle.requestClose(close), true);
    await until(() => !running(taskPid));
    assert.equal(manager.lastCwd("protected"), undefined);
  });
}

test("hangup precedes cleanup of stubborn descendants and leaves unrelated processes alive", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX signals");
    return;
  }
  assert.ok(
    await inspectProcesses(),
    "residual cleanup requires process inspection",
  );
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "gaogrid-cleanup-")),
  );
  const pidFile = join(root, "child.pid");
  const events = join(root, "signals.log");
  const script = join(root, "stubborn.js");
  await writeFile(
    script,
    `
    const fs = require('node:fs');
    process.on('SIGHUP', () => fs.appendFileSync(${JSON.stringify(events)}, 'H'));
    process.on('SIGTERM', () => fs.appendFileSync(${JSON.stringify(events)}, 'T'));
    fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
    setInterval(() => {}, 1000);
  `,
  );
  const unrelated = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    { stdio: "ignore" },
  );
  let childPid: number | undefined;
  const manager = new PtyManager(() => {}, {
    defaultShell: () => "/bin/bash",
    defaultDirectories: () => [root],
    environment: { ...process.env, HOME: root },
  });
  t.after(async () => {
    await manager.closeAll();
    if (childPid && running(childPid)) process.kill(childPid, "SIGKILL");
    unrelated.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  });
  await manager.start("stubborn", root);
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  manager.input(
    "stubborn",
    `${quote(process.execPath)} ${quote(script)} & wait\r`,
  );
  await until(async () => {
    try {
      childPid = +(await readFile(pidFile, "utf8"));
      return childPid > 0;
    } catch {
      return false;
    }
  });
  assert.equal((await manager.activeTasks(["stubborn"])).has("stubborn"), true);
  await manager.closeSessions(["stubborn"]);
  await until(() => !running(childPid!));
  assert.equal(running(unrelated.pid!), true);
  assert.match(await readFile(events, "utf8"), /^H+T/);
});
