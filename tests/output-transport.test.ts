import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { PtyManager } from "../src/pty-manager";
import { TerminalOutputStream } from "../src/terminal-output-stream";
import { frontend } from "./fixtures/terminal-frontend";

async function until(check: () => boolean, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error("Timed out waiting for terminal transport.");
}
const quote = (value: string) => `'${value.replace(/'/g, `'\''`)}'`;

for (const backend of ["direct", "tmux"] as const)
  test(`${backend} output remains bounded, ordered and lossless while frontend parsing is delayed`, async (t) => {
    if (process.platform === "win32") return t.skip("POSIX shell");
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "gaogrid-output-flow-")),
    );
    // tmux has a fixed GaoGrid socket name, so give it a private, short socket
    // directory instead of ever touching the user's default server.
    const socketDir =
      backend === "tmux" ? await mkdtemp("/tmp/gc-") : undefined;
    const environment = {
      ...process.env,
      HOME: root,
      TMUX: undefined,
      TMUX_PANE: undefined,
      ...(socketDir ? { TMUX_TMPDIR: socketDir } : {}),
    };
    await writeFile(join(root, ".bashrc"), "PS1='FLOW_READY> '\nstty -echo\n");
    const line = "中文 🐍📦 " + "0123456789".repeat(9) + "\n";
    const lines = 120000;
    assert.ok(Buffer.byteLength(line) * lines > 12 * 1024 * 1024);
    await writeFile(
      join(root, "producer.js"),
      `
    process.stdout.write('TRANSPORT_START');
    let left = ${lines};
    function produce() {
      while (left > 0) {
        left--;
        if (!process.stdout.write(${JSON.stringify(line)})) {
          process.stdout.once('drain', produce);
          return;
        }
      }
      process.stdout.write('TRANSPORT_DONE');
    }
    produce();
  `,
    );
    const errors: string[] = [];
    const outputHighWatermark = 256 * 1024;
    let streams: TerminalOutputStream;
    const manager = new PtyManager(
      (message: any) => {
        if (message.type === "data")
          streams.write(message.sessionId, message.data);
        if (message.type === "error") errors.push(message.message);
      },
      {
        defaultShell: () => "/bin/bash",
        defaultDirectories: () => [root],
        environment,
        outputHighWatermark,
        outputLowWatermark: 64 * 1024,
        ...(backend === "tmux"
          ? { tmuxConfigPath: resolve("resources/tmux.conf") }
          : {}),
      },
    );
    let pending = 0;
    let peak = 0;
    let hold = true;
    let latestAck: any;
    let collecting = false;
    let started = false;
    let data = "";
    const digest = createHash("sha256");
    let received = 0;
    const expected = createHash("sha256");
    for (let i = 0; i < lines; i++)
      expected.update(line.replace(/\n/g, "\r\n"), "utf16le");
    const f = frontend(t, 80, 24, (message) => {
      if (message.type !== "outputParsed") return;
      latestAck = message;
      if (!hold)
        streams.acknowledge(
          message.sessionId,
          message.streamId,
          message.sequence,
        );
    });
    streams = new TerminalOutputStream(
      {
        replay: (id, consume) => manager.replay(id, consume),
        setOutputPending: (id, length) => {
          pending = length;
          peak = Math.max(peak, length);
          manager.setOutputPending(id, length);
        },
      },
      (message) => {
        assert.notEqual(message.type, "streamError");
        if (message.type === "streamError") return false;
        if (collecting && message.type === "data") {
          data += message.data;
          if (!started) {
            const start = data.indexOf("TRANSPORT_START");
            if (start < 0) {
              data = data.slice(-32);
              f.view.receiveOutput(message);
              return true;
            }
            data = data.slice(start + "TRANSPORT_START".length);
            started = true;
          }
          const marker = data.indexOf("TRANSPORT_DONE");
          if (marker < 0) {
            // Keep enough tail for a marker split between PTY chunks.
            const consumed = Math.max(0, data.length - 32);
            // Hash code units so a test chunk boundary inside an Emoji does not
            // introduce a replacement character through separate UTF-8 encodings.
            digest.update(data.slice(0, consumed), "utf16le");
            received += consumed;
            data = data.slice(consumed);
          } else {
            digest.update(data.slice(0, marker), "utf16le");
            received += marker;
            collecting = false;
          }
        }
        f.view.receiveOutput(message);
        return true;
      },
    );
    t.after(async () => {
      streams.clear();
      await manager.closeAll();
      if (socketDir) {
        try {
          execFileSync(
            "tmux",
            [
              "-L",
              "gaogrid",
              "-f",
              resolve("resources/tmux.conf"),
              "kill-server",
            ],
            { env: environment, stdio: "ignore" },
          );
        } catch {
          // The isolated server may already have exited after its last session.
        }
      }
      await rm(root, { recursive: true, force: true });
      if (socketDir) await rm(socketDir, { recursive: true, force: true });
    });
    if (
      backend === "tmux" &&
      !(await manager.tmux.capabilities()).tmux.available
    ) {
      t.skip("tmux unavailable");
      return;
    }
    await manager.start(
      f.tab.sessionId,
      root,
      undefined,
      false,
      backend === "tmux" ? { backend: "tmux" } : {},
    );
    await until(
      () => manager.output(f.tab.sessionId)?.includes("FLOW_READY>") || false,
    );
    const streamId = f.sent.find(
      (message) => message.type === "subscribeOutput",
    ).streamId;
    await streams.subscribe(f.tab.sessionId, streamId);
    await until(() => !!latestAck);
    // Acknowledge the initial shell snapshot; only producer output enters the hash.
    streams.acknowledge(
      latestAck.sessionId,
      latestAck.streamId,
      latestAck.sequence,
    );
    collecting = true;
    manager.input(
      f.tab.sessionId,
      `${quote(process.execPath)} ${quote(join(root, "producer.js"))}\r`,
    );
    if (outputHighWatermark < Buffer.byteLength(line) * lines) {
      await until(() => pending >= outputHighWatermark / 2);
      await new Promise((resolve) => setTimeout(resolve, 150));
      const pausedAt = pending;
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(
        pending,
        pausedAt,
        "the real PTY must stop producing without ACK credit",
      );
    } else await until(() => !collecting);
    assert.ok(peak < outputHighWatermark * 2, `pending output was ${peak}`);
    hold = false;
    streams.acknowledge(
      latestAck.sessionId,
      latestAck.streamId,
      latestAck.sequence,
    );
    await until(() => !collecting, 30000);
    await until(() => pending === 0);
    assert.equal(received, line.replace(/\n/g, "\r\n").length * lines);
    assert.equal(digest.digest("hex"), expected.digest("hex"));
    assert.ok(peak < outputHighWatermark * 2, `pending output was ${peak}`);
    assert.deepEqual(errors, []);
    assert.equal(f.terminal.unicode.activeVersion, "11");
    assert.ok(
      f.terminal.buffer.active.cursorX >= 0 &&
        f.terminal.buffer.active.cursorX < 80,
    );

    // Closing a view releases its credit; a new view starts from parsed cells.
    hold = true;
    manager.input(
      f.tab.sessionId,
      `${quote(process.execPath)} ${quote(join(root, "producer.js"))}\r`,
    );
    await until(() => pending >= outputHighWatermark / 2);
    streams.clear();
    assert.equal(pending, 0);
    await until(
      () => manager.output(f.tab.sessionId)?.endsWith("FLOW_READY> ") || false,
      30000,
    );
    f.view.reset(f.tab.sessionId);
    const currentId = f.sent
      .filter((message) => message.type === "subscribeOutput")
      .at(-1).streamId;
    hold = false;
    await streams.subscribe(f.tab.sessionId, currentId);
    await until(() => pending === 0);
    const buffer = f.terminal.buffer.active;
    assert.match(
      Array.from({ length: buffer.length }, (_, i) =>
        buffer.getLine(i)?.translateToString(true),
      ).join("\n"),
      /TRANSPORT_DONE/,
    );
  });

test("real PTY receives legacy mouse bytes without UTF-8 expansion and preserves SGR input", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX shell");
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "gaogrid-binary-input-")),
  );
  await writeFile(join(root, ".bashrc"), "PS1='BINARY_READY> '\nstty -echo\n");
  const legacy = "\x1b[M\x20\x80\xff";
  const modern = "\x1b[<0;3;4M中文";
  const expected = Buffer.concat([
    Buffer.from(legacy, "latin1"),
    Buffer.from(modern),
  ]);
  await writeFile(
    join(root, "reader.js"),
    `
    process.stdin.setRawMode(true);
    let input = Buffer.alloc(0);
    process.stdin.on('data', (data) => {
      input = Buffer.concat([input, data]);
      if (input.length >= ${expected.length}) {
        process.stdout.write('RECEIVED=' + input.toString('hex'));
        process.exit(0);
      }
    });
    process.stdout.write('RAW_READER_READY');
  `,
  );
  const manager = new PtyManager(() => {}, {
    defaultShell: () => "/bin/bash",
    defaultDirectories: () => [root],
    environment: { ...process.env, HOME: root },
  });
  t.after(async () => {
    await manager.closeAll();
    await rm(root, { recursive: true, force: true });
  });
  await manager.start("binary", root);
  manager.input(
    "binary",
    `${quote(process.execPath)} ${quote(join(root, "reader.js"))}\r`,
  );
  await until(
    () => manager.output("binary")?.includes("RAW_READER_READY") || false,
  );
  manager.input("binary", legacy, true);
  manager.input("binary", modern);
  await until(() => manager.output("binary")?.includes("RECEIVED=") || false);
  assert.match(
    manager.output("binary")!,
    new RegExp(`RECEIVED=${expected.toString("hex")}`),
  );
});
