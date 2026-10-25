import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, chmod } from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CwdResolver,
  localOscDirectory,
  resolveCwd,
  validDirectory,
} from "../src/cwd-resolver";
import { OscCwdParser } from "../src/osc-cwd-parser";
import {
  parseProcessList,
  terminalChildren,
  remainingProcesses,
} from "../src/process-inspector";
import { hasActiveTask } from "../src/task-detector";
import { TerminalLifecycle } from "../src/terminal-lifecycle";

test("OSC 7 survives arbitrary chunk boundaries and ignores ordinary output", () => {
  const stream =
    "prompt /fake/path\x1b]0;terminal title\x07\x1b]7;file://localhost/tmp/a%20b\x1b\\output";
  const expected = ["file://localhost/tmp/a%20b"];
  for (let split = 0; split <= stream.length; split++) {
    const reports: string[] = [];
    const reader = new OscCwdParser((uri) => reports.push(uri));
    reader.write(stream.slice(0, split));
    reader.write(stream.slice(split));
    assert.deepEqual(reports, expected);
  }
  const reports: string[] = [];
  const reader = new OscCwdParser((uri) => reports.push(uri));
  reader.write(`\x1b]7;${"a".repeat(20_000)}\x07\x1b]7;file:///tmp\x07`);
  assert.deepEqual(reports, ["file:///tmp"]);
});

test("OSC 7 accepts only normalized local file URLs", () => {
  assert.equal(
    localOscDirectory("file://localhost/tmp/a%20b%23c"),
    "/tmp/a b#c",
  );
  assert.equal(localOscDirectory(`file://${hostname()}/tmp/../repo`), "/repo");
  for (const value of [
    "file://remote.invalid/repo",
    "https://localhost/repo",
    "file:///repo?bad",
    "file:///repo#bad",
    "file:///tmp/%zz",
  ])
    assert.equal(localOscDirectory(value), undefined);
});

test("cwd resolution validates candidates and skips unavailable directories", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gaogrid-cwd-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const explicit = join(root, "explicit");
  const active = join(root, "active #中文");
  const pane = join(root, "pane");
  await Promise.all([mkdir(explicit), mkdir(active), mkdir(pane)]);
  assert.equal(await resolveCwd([explicit, active, pane, root]), explicit);
  await rm(explicit, { recursive: true });
  assert.equal(await resolveCwd([explicit, active, pane, root]), active);
  const tracker = new CwdResolver(root);
  tracker.report(pathToFileURL(active).href);
  assert.equal(await tracker.refresh(), active);
  tracker.report("file://remote.invalid/wrong");
  assert.equal(await tracker.refresh(), active);
  await rm(active, { recursive: true });
  assert.equal(await resolveCwd([await tracker.refresh(), pane, root]), pane);
  await rm(pane, { recursive: true });
  assert.equal(
    await resolveCwd(["relative", "/invalid\0path", active, pane, root]),
    root,
  );
});

test("startup cwd only needs traversal permission, not directory listing permission", async (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) {
    t.skip("POSIX directory permissions require an unprivileged user");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "gaogrid-permissions-"));
  t.after(async () => {
    await chmod(root, 0o700);
    await rm(root, { recursive: true });
  });
  await chmod(root, 0o111);
  assert.equal(await validDirectory(root), root);
  await chmod(root, 0o600);
  assert.equal(await validDirectory(root), undefined);
});

const processes = parseProcessList(`
  100 1 100 101 ttys001 S Sun Oct 25 10:00:00 2026 /bin/zsh
  101 100 101 101 ttys001 S Sun Oct 25 10:00:01 2026 /bin/sleep
  102 101 101 101 ttys001 S Sun Oct 25 10:00:02 2026 node
  103 100 103 -1 ?? S Sun Oct 25 10:00:03 2026 daemon
  104 100 104 101 ttys001 Z Sun Oct 25 10:00:04 2026 defunct
  200 1 200 200 ttys002 S Sun Oct 25 10:00:05 2026 /bin/zsh
`);

test("a close-time snapshot distinguishes shells, exec, foreground apps, and background jobs", () => {
  assert.equal(processes.length, 6);
  assert.deepEqual(
    terminalChildren(processes, 100).map((entry) => entry.pid),
    [101, 102],
  );
  assert.equal(hasActiveTask([], 100, "/bin/zsh"), false);
  assert.equal(hasActiveTask(processes.slice(0, 1), 100, "/bin/zsh"), false);
  assert.equal(hasActiveTask(processes, 100, "/bin/zsh"), true);
  assert.equal(hasActiveTask(processes, 200, "/bin/zsh"), false);
  assert.equal(
    hasActiveTask([{ ...processes[0], command: "/bin/vim" }], 100, "/bin/zsh"),
    true,
  );
  assert.equal(
    hasActiveTask(
      [processes[0], { ...processes[1], ppid: 1 }],
      100,
      "/bin/zsh",
    ),
    true,
    "a reparented foreground group still owns the terminal",
  );
  const background = processes.map((entry) => ({ ...entry, tpgid: 100 }));
  assert.equal(
    hasActiveTask(background, 100, "/bin/zsh"),
    true,
    "returning foreground control to the shell does not hide background jobs",
  );
  assert.equal(
    hasActiveTask([processes[0], ...processes.slice(3, 5)], 100, "/bin/zsh"),
    false,
  );
});

test("residual cleanup rejects reused PIDs, detached jobs, other terminals, and zombies", () => {
  const known = terminalChildren(processes, 100);
  assert.deepEqual(
    remainingProcesses(known, [
      { ...processes[1], ppid: 1, tty: "??" },
      { ...processes[2], ppid: 1, tty: "??" },
      processes[5],
    ]).map((entry) => entry.pid),
    [101, 102],
  );
  for (const change of [
    { started: "Sun Oct 25 11:00:00 2026" },
    { pgid: 999 },
    { tty: "ttys999" },
    { state: "Z" },
  ])
    assert.deepEqual(
      remainingProcesses(known, [{ ...processes[1], ...change }]),
      [],
    );
});

test("one close pipeline protects busy work, aggregates prompts, and never terminates on cancel", async () => {
  const closed: string[][] = [];
  const confirmations: unknown[] = [];
  let approve = false;
  let active = new Set(["codex", "server"]);
  const lifecycle = new TerminalLifecycle(
    {
      activeTasks: async () => active,
      closeSessions: async (ids) => {
        closed.push(ids);
      },
    },
    async (confirmation) => {
      confirmations.push(confirmation);
      return approve;
    },
  );
  assert.equal(
    await lifecycle.requestClose({
      scope: "terminal",
      terminals: [{ sessionId: "shell", title: "shell" }],
    }),
    true,
  );
  assert.equal(confirmations.length, 0);
  const terminals = [
    { sessionId: "shell", title: "shell" },
    { sessionId: "codex", title: "Codex" },
    { sessionId: "server", title: "dev" },
  ];
  for (const scope of ["terminal", "pane", "workspace"] as const) {
    const prior = closed.length;
    assert.equal(
      await lifecycle.requestClose({ scope, terminals, title: "Backend" }),
      false,
    );
    assert.equal(closed.length, prior);
  }
  assert.equal(confirmations.length, 3);
  assert.match((confirmations[2] as { detail: string }).detail, /2 terminals/);
  approve = true;
  assert.equal(
    await lifecycle.requestClose({
      scope: "workspace",
      terminals,
      title: "Backend",
    }),
    true,
  );
  assert.deepEqual(closed.at(-1), ["shell", "codex", "server"]);
  active = new Set();
  const previous = confirmations.length;
  assert.equal(
    await lifecycle.requestClose({
      scope: "terminal",
      terminals: [{ sessionId: "new-shell", title: "shell" }],
    }),
    true,
  );
  assert.equal(confirmations.length, previous);
});
