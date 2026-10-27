import { test } from "node:test";
import assert from "node:assert/strict";
import { TerminalHistory } from "../src/terminal-history";
import {
  TerminalOutputFlow,
  OUTPUT_HIGH_WATERMARK,
  OUTPUT_LOW_WATERMARK,
} from "../src/terminal-output-flow";
import { TerminalOutputStream } from "../src/terminal-output-stream";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("flow control bounds both parsers with high/low hysteresis and releases the PTY on disposal", () => {
  const transitions: string[] = [];
  const flow = new TerminalOutputFlow(
    () => transitions.push("pause"),
    () => transitions.push("resume"),
  );
  flow.queued(OUTPUT_HIGH_WATERMARK);
  flow.queued(10);
  assert.deepEqual(transitions, ["pause"]);
  flow.setViewPending(OUTPUT_HIGH_WATERMARK);
  flow.parsed(OUTPUT_HIGH_WATERMARK + 10);
  assert.deepEqual(
    transitions,
    ["pause"],
    "headless completion cannot outrun the frontend",
  );
  flow.setViewPending(OUTPUT_LOW_WATERMARK + 1);
  assert.deepEqual(transitions, ["pause"]);
  flow.setViewPending(OUTPUT_LOW_WATERMARK);
  assert.deepEqual(transitions, ["pause", "resume"]);
  flow.queued(OUTPUT_HIGH_WATERMARK);
  flow.dispose();
  flow.parsed(OUTPUT_HIGH_WATERMARK);
  flow.queued(OUTPUT_HIGH_WATERMARK);
  assert.deepEqual(transitions, ["pause", "resume", "pause", "resume"]);
});

test("a promotion hold blocks reads until history is replaced and both parser credits are low", () => {
  const transitions: string[] = [];
  const flow = new TerminalOutputFlow(
    () => transitions.push("pause"),
    () => transitions.push("resume"),
  );
  const release = flow.hold();
  flow.queued(OUTPUT_HIGH_WATERMARK);
  flow.parsed(OUTPUT_HIGH_WATERMARK);
  assert.deepEqual(transitions, ["pause"]);
  flow.queued(OUTPUT_HIGH_WATERMARK);
  release();
  release();
  assert.deepEqual(transitions, ["pause"]);
  flow.parsed(OUTPUT_HIGH_WATERMARK);
  assert.deepEqual(transitions, ["pause", "resume"]);
  flow.dispose();
});

test("unmounted output stays in parsed history; subscription sends one snapshot and then ordered live data", async (t) => {
  const history = new TerminalHistory(80, 24);
  t.after(() => history.dispose());
  const messages: any[] = [];
  const pending: number[] = [];
  const streams = new TerminalOutputStream(
    {
      replay: (_id, consume) => history.snapshot(consume, true),
      setOutputPending: (_id, length) => pending.push(length),
    },
    (message) => {
      messages.push(message);
      return true;
    },
  );
  t.after(() => streams.clear());
  history.write(
    "\x1b[31m" + "x".repeat(2_000_001) + "\x1b[0m\r\nSAVED 🐍📦\r\n",
  );
  streams.write("tab", "unmounted data is never queued for a view");
  assert.deepEqual(messages, []);
  const subscribing = streams.subscribe("tab", "generation-1");
  history.write("AFTER\r\n", () => streams.write("tab", "AFTER\r\n"));
  await subscribing;
  await history.snapshot();
  await tick();
  assert.equal(messages[0].type, "replay");
  assert.match(messages[0].data, /SAVED 🐍📦/);
  assert.ok(!messages[0].data.includes("AFTER"));
  assert.deepEqual(
    messages.slice(1).map((message) => message.data),
    ["AFTER\r\n"],
  );
  assert.equal(messages[1].sequence, messages[0].sequence + "AFTER\r\n".length);
  streams.acknowledge("tab", "generation-1", messages[1].sequence);
  assert.equal(pending.at(-1), 0);
});

test("ACKs are cumulative, generation-scoped, and cannot grant credit for future output", async () => {
  const messages: any[] = [];
  const pending: number[] = [];
  const snapshot = { version: 1 as const, cols: 80, rows: 24, data: "FIRST" };
  const streams = new TerminalOutputStream(
    {
      replay: async (_id, consume) => {
        consume(snapshot);
        return snapshot;
      },
      setOutputPending: (_id, length) => pending.push(length),
    },
    (message) => {
      messages.push(message);
      return true;
    },
  );
  await streams.subscribe("tab", "old");
  streams.write("tab", "SECOND");
  await tick();
  streams.acknowledge("tab", "old", 5);
  assert.equal(pending.at(-1), 6);
  const count = pending.length;
  for (const sequence of [0, -1, 12, NaN, 2.5, 5])
    streams.acknowledge("tab", "old", sequence);
  streams.acknowledge("tab", "other", 11);
  assert.equal(pending.length, count);
  await streams.subscribe("tab", "new");
  streams.acknowledge("tab", "old", 11);
  assert.equal(pending.at(-1), 5);
  streams.unsubscribe("tab", "old");
  streams.write("tab", "LIVE");
  await tick();
  assert.equal(messages.at(-1).streamId, "new");
  streams.clear();
  assert.equal(pending.at(-1), 0);
  const length = messages.length;
  streams.write("tab", "background output");
  await tick();
  assert.equal(messages.length, length);
});

test("a delayed snapshot from an old view cannot overwrite a newer subscription", async () => {
  const history = new TerminalHistory(80, 24);
  const messages: any[] = [];
  const streams = new TerminalOutputStream(
    {
      replay: (_id, consume) => history.snapshot(consume, true),
      setOutputPending() {},
    },
    (message) => {
      messages.push(message);
      return true;
    },
  );
  try {
    history.write("OLD\r\n");
    const old = streams.subscribe("tab", "old");
    history.write("NEW\r\n");
    const current = streams.subscribe("tab", "new");
    await Promise.all([old, current]);
    await tick();
    assert.equal(messages.length, 1);
    assert.equal(messages[0].streamId, "new");
    assert.match(messages[0].data, /OLD\r\nNEW/);
  } finally {
    streams.clear();
    history.dispose();
  }
});

test("a closed view or failed snapshot releases output pressure and keeps errors local to its tab", async () => {
  const pending = new Map<string, number>();
  const messages: any[] = [];
  const streams = new TerminalOutputStream(
    {
      replay: async (id, consume) => {
        if (id === "bad") throw new Error("snapshot failed");
        const snapshot = {
          version: 1 as const,
          cols: 80,
          rows: 24,
          data: "VIEW",
        };
        consume(snapshot);
        return snapshot;
      },
      setOutputPending: (id, size) => pending.set(id, size),
    },
    (message) => {
      messages.push(message);
      return message.sessionId !== "closed";
    },
  );
  await streams.subscribe("good", "good");
  await streams.subscribe("closed", "closed");
  await streams.subscribe("bad", "bad");
  await tick();
  assert.equal(pending.get("closed"), 0);
  assert.equal(pending.get("bad"), 0);
  assert.equal(pending.get("good"), 4);
  assert.equal(
    messages.find((message) => message.type === "streamError").sessionId,
    "bad",
  );
  streams.clear();
});

test("missing histories produce an empty snapshot and rejected error delivery cannot leak credit", async () => {
  const messages: any[] = [];
  const pending: number[] = [];
  const streams = new TerminalOutputStream(
    {
      replay: async (id) => {
        if (id === "failed") throw new Error("closed history");
        return undefined;
      },
      setOutputPending: (_id, size) => pending.push(size),
    },
    async (message) => {
      messages.push(message);
      if (message.type === "streamError") throw new Error("disposed webview");
      return true;
    },
  );
  await streams.subscribe("missing", "empty");
  await tick();
  assert.equal(messages[0].data, "");
  assert.equal(messages[0].sequence, 1);
  streams.acknowledge("missing", "empty", 1);
  assert.equal(pending.at(-1), 0);
  await streams.subscribe("failed", "error");
  assert.equal(pending.at(-1), 0);
  streams.clear();
});
