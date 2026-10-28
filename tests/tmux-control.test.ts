import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { TmuxControlProcess } from "../src/tmux-control";

async function fakeTmux() {
  const dir = await mkdtemp(join(tmpdir(), "gaogrid-control-"));
  const log = join(dir, "stdin.log");
  const executable = join(dir, "tmux");
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const info = '%1|5|2|0|0|0|1|0|0|0|0|0|0|0|0|0|1|0|0|1|0|0';
const pending = String.fromCharCode(92) + '033[?';
const blocks = [[], [], [info], ['saved'], [pending], ['hello', 'CAPTURE_GAP_MARKER', '%begin 9 9 9', '%end 7 7 7']];
let wire = '';
for (let i = 0; i < blocks.length; i++) {
  if (i === 5) wire += '%output %1 CAPTURE_GAP_MARKER' + String.fromCharCode(92) + '012\\n';
  wire += '%begin 10 ' + (i + 1) + ' 0\\n' + blocks[i].join('\\n') + '\\n%end 10 ' + (i + 1) + ' 0\\n';
}
// Deliberately split protocol tokens and UTF-8/octal bytes across writes.
for (let i = 0; i < wire.length; i += 7) process.stdout.write(wire.slice(i, i + 7));
setTimeout(() => {
  const slash = String.fromCharCode(92);
  process.stdout.write('%output %1 25h\\n');
  process.stdout.write('%output %1 ' + slash + '303\\n');
  process.stdout.write('%output %1 ' + slash + '251' + slash + '012%begin 9 9 9' + slash + '012' + slash + '303' + slash + '251\\n');
  process.stdout.write('%begin 37 0 0\\nSECRET_COMMAND_OUTPUT\\n%error 37 0 0\\n');
}, 200);
process.stdin.on('data', data => fs.appendFileSync(${JSON.stringify(log)}, data));
`;
  await writeFile(executable, script);
  await chmod(executable, 0o755);
  return { dir, log, executable };
}

test("tmux control mode frames snapshots, decodes live bytes, pauses reads, and hex-encodes input", async (t) => {
  const fake = await fakeTmux();
  t.after(() => rm(fake.dir, { recursive: true, force: true }));
  const processAdapter = new TmuxControlProcess({
    args: ["-L", "isolated", "-C", "attach-session", "-t", "=gaogrid-test:0.0"],
    target: "=gaogrid-test:0.0",
    cwd: fake.dir,
    env: { ...process.env, PATH: `${fake.dir}:${process.env.PATH}` },
    cols: 80,
    rows: 24,
  });
  t.after(() => processAdapter.kill());
  const received: string[] = [];
  processAdapter.onData((data) => received.push(data));
  await processAdapter.ready;
  processAdapter.pause();
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(
    received.length,
    1,
    "an incomplete pending CSI is held until its continuation arrives",
  );
  processAdapter.resume();
  await new Promise((resolve) => setTimeout(resolve, 20));
  processAdapter.write(Buffer.from([0x41, 0x0a, 0x00, 0xff]));
  processAdapter.resize(123, 45);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(received.length > 0);
  assert.ok(received[0].includes("hello"), "snapshot contains captured rows");
  assert.ok(
    received.join("").includes("%end 7 7 7"),
    "capture rows resembling mismatched control markers remain pane text",
  );
  assert.equal(
    received.join("").split("CAPTURE_GAP_MARKER").length - 1,
    1,
    "final capture closes the output boundary without a gap or duplicate",
  );
  assert.equal(
    received[1],
    "\x1b[?25h",
    "pending CSI and its first continuation arrive as one frontend chunk",
  );
  assert.ok(
    !received.join("").includes("%begin 10"),
    "block markers stay hidden",
  );
  assert.ok(
    !received.join("").includes("saved"),
    "inactive saved screen is not live output",
  );
  const input = await readFile(fake.log, "utf8");
  assert.match(input, /send-keys -H -t '=gaogrid-test:0\.0' 41 0a 00 ff/);
  assert.match(input, /refresh-client -C 123x45/);
  assert.ok(received.join("").includes("é"), "octal encoded UTF-8 is restored");
  assert.ok(
    received.join("").includes("%begin 9 9 9"),
    "pane text resembling framing is preserved",
  );
  assert.ok(
    !received.join("").includes("SECRET_COMMAND_OUTPUT"),
    "control errors never leak command output",
  );

  const exited = new Promise<{ exitCode: number; signal?: number }>((resolve) =>
    processAdapter.onExit(resolve),
  );
  processAdapter.kill("SIGTERM");
  const result = await exited;
  assert.equal(result.signal, 15);
});

test("initial control errors reject ready safely and close the client", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "gaogrid-control-error-"));
  const executable = join(dir, "tmux");
  await writeFile(
    executable,
    `#!/usr/bin/env node
process.stdout.write('%begin 1 0 0\\n%end 1 0 0\\n%begin 2 0 0\\nSECRET_CAPTURE_DATA\\n%error 2 0 0\\n');
process.stdin.resume();
`,
  );
  await chmod(executable, 0o755);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const adapter = new TmuxControlProcess({
    args: ["-L", "isolated", "-C", "attach-session", "-t", "=gaogrid-test:0.0"],
    target: "=gaogrid-test:0.0",
    cwd: dir,
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    cols: 80,
    rows: 24,
  });
  await assert.rejects(adapter.ready, (error: Error) => {
    assert.doesNotMatch(error.message, /SECRET_CAPTURE_DATA/);
    return /initial snapshot was ready/.test(error.message);
  });
});

test("invalid snapshot metadata rejects ready without escaping the pipe callback", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "gaogrid-control-invalid-"));
  const executable = join(dir, "tmux");
  const wire = [
    ["1", ""], // command-line attach handshake
    ["2", ""], // initial refresh
    ["3", "not pane metadata"],
    ["4", "saved"],
    ["5", ""], // pending parser bytes
    ["6", "active"],
  ]
    .map(([id, value]) => `%begin ${id} 0 0\n${value}\n%end ${id} 0 0\n`)
    .join("");
  await writeFile(
    executable,
    `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(wire)});\nprocess.stdin.resume();\n`,
  );
  await chmod(executable, 0o755);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const adapter = new TmuxControlProcess({
    args: ["-L", "isolated", "-C", "attach-session", "-t", "=gaogrid-test:0.0"],
    target: "=gaogrid-test:0.0",
    cwd: dir,
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    cols: 80,
    rows: 24,
  });
  await assert.rejects(adapter.ready, /initial snapshot was ready/);
});

test("an isolated real tmux control client attaches, snapshots, and streams a live command", async (t) => {
  const dir = await mkdtemp("/tmp/gc-");
  const server = `g${randomUUID().slice(0, 7)}`;
  const session = `g${randomUUID().slice(0, 7)}`;
  const env = {
    ...process.env,
    TMUX_TMPDIR: dir,
    TMUX: undefined,
    TMUX_PANE: undefined,
  };
  let adapter: TmuxControlProcess | undefined;
  const tmux = (args: string[]) =>
    execFileSync("tmux", ["-L", server, "-f", "/dev/null", ...args], {
      env,
      stdio: "ignore",
    });
  t.after(async () => {
    adapter?.kill();
    try {
      tmux(["kill-server"]);
    } catch {}
    await rm(dir, { recursive: true, force: true });
  });
  try {
    execFileSync("tmux", ["-V"], { env, stdio: "ignore" });
    tmux(["new-session", "-d", "-s", session, "-x", "80", "-y", "24"]);
  } catch {
    t.skip("tmux is unavailable");
    return;
  }
  const received: string[] = [];
  adapter = new TmuxControlProcess({
    args: [
      "-L",
      server,
      "-f",
      "/dev/null",
      "-C",
      "attach-session",
      "-t",
      `=${session}:0.0`,
    ],
    target: `=${session}:0.0`,
    cwd: dir,
    env,
    cols: 80,
    rows: 24,
  });
  adapter.onData((data) => received.push(data));
  await adapter.ready;
  assert.ok(
    received.length > 0,
    "attach handshake is followed by a terminal snapshot",
  );
  adapter.write("printf 'CONTROL_LIVE_MARKER\\n'\r");
  const deadline = Date.now() + 5000;
  while (
    !received.join("").includes("CONTROL_LIVE_MARKER") &&
    Date.now() < deadline
  )
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(
    received.join("").includes("CONTROL_LIVE_MARKER"),
    "live pane output follows the snapshot",
  );
});

test(
  "a new tmux control client retains UTF-8 split across attachment",
  {
    todo: "tmux capture cannot expose a code point started before this client attached",
  },
  async (t) => {
    const dir = await mkdtemp("/tmp/gc-");
    const server = `g${randomUUID().slice(0, 7)}`;
    const session = `g${randomUUID().slice(0, 7)}`;
    const firstByte = join(dir, "first-byte");
    const continueGate = join(dir, "continue-gate");
    const continued = join(dir, "continued");
    const app = join(dir, "partial-utf8.sh");
    await writeFile(
      app,
      `#!/bin/sh\nprintf '\\303'\ntouch '${firstByte}'\nwhile [ ! -e '${continueGate}' ]; do sleep 0.02; done\nprintf '\\251UTF8_CONTINUED'\ntouch '${continued}'\nsleep 8\n`,
    );
    await chmod(app, 0o755);
    const env = {
      ...process.env,
      TMUX_TMPDIR: dir,
      TMUX: undefined,
      TMUX_PANE: undefined,
    };
    const tmux = (args: string[]) =>
      execFileSync("tmux", ["-L", server, "-f", "/dev/null", ...args], {
        env,
        stdio: "ignore",
      });
    let adapter: TmuxControlProcess | undefined;
    t.after(async () => {
      adapter?.kill();
      try {
        tmux(["kill-server"]);
      } catch {}
      await rm(dir, { recursive: true, force: true });
    });
    try {
      execFileSync("tmux", ["-V"], { env, stdio: "ignore" });
      tmux(["new-session", "-d", "-s", session, "-x", "80", "-y", "24", app]);
    } catch {
      t.skip("tmux is unavailable");
      return;
    }
    const markerDeadline = Date.now() + 5000;
    while (!existsSync(firstByte) && Date.now() < markerDeadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(
      existsSync(firstByte),
      "pane emitted the leading UTF-8 byte before attach",
    );
    const received: string[] = [];
    adapter = new TmuxControlProcess({
      args: [
        "-L",
        server,
        "-f",
        "/dev/null",
        "-C",
        "attach-session",
        "-t",
        `=${session}:0.0`,
      ],
      target: `=${session}:0.0`,
      cwd: dir,
      env,
      cols: 80,
      rows: 24,
    });
    adapter.onData((data) => received.push(data));
    await adapter.ready;
    assert.ok(
      received.length > 0,
      "snapshot completed while the code point was incomplete",
    );
    assert.ok(
      !existsSync(continued),
      "producer remains paused until after ready",
    );
    await writeFile(continueGate, "continue");
    const deadline = Date.now() + 5000;
    while (!existsSync(continued) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(
      existsSync(continued),
      "pane emitted the UTF-8 continuation after attach",
    );
    const outputDeadline = Date.now() + 2000;
    while (
      !received.join("").includes("UTF8_CONTINUED") &&
      Date.now() < outputDeadline
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    const output = received.join("");
    assert.ok(
      output.includes("éUTF8_CONTINUED"),
      "control output retains both UTF-8 bytes",
    );
    assert.ok(
      !output.includes("�"),
      "control output has no replacement character",
    );
  },
);
