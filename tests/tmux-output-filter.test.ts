import { test } from "node:test";
import assert from "node:assert/strict";
import { Terminal } from "@xterm/headless";
import { TmuxOutputFilter } from "../src/tmux-output-filter";

const esc = "\x1b";

test("filters only direct tmux-answered CSI and OSC queries across chunk splits", () => {
  const input =
    "before" +
    `${esc}[5n` +
    `${esc}[6n` +
    "middle" +
    `${esc}[c` +
    `${esc}[0c` +
    `${esc}[>c` +
    `${esc}[>0c` +
    `${esc}]10;?\x07` +
    `${esc}]11;?${esc}\\` +
    "after";

  for (let split = 0; split <= input.length; split++) {
    const filter = new TmuxOutputFilter();
    const output =
      filter.write(input.slice(0, split)) +
      filter.write(input.slice(split)) +
      filter.flush();
    assert.equal(output, "beforemiddleafter", `split at ${split}`);
  }

  const oneCharacterChunks = new TmuxOutputFilter();
  const oneCharacterOutput =
    Array.from(input)
      .map((character) => oneCharacterChunks.write(character))
      .join("") + oneCharacterChunks.flush();
  assert.equal(oneCharacterOutput, "beforemiddleafter");
});

test("xterm replies to a tmux-wrapped query because DCS contents stay opaque", async (t) => {
  const filter = new TmuxOutputFilter();
  const terminal = new Terminal({ allowProposedApi: true });
  t.after(() => terminal.dispose());
  const replies: string[] = [];
  terminal.onData((data) => replies.push(data));

  // tmux doubles embedded ESC bytes inside DCS passthrough. The first escaped
  // ST must not end the outer wrapper or expose the following query to filter.
  const wrapped = `${esc}Ptmux;${esc}${esc}\\${esc}${esc}[6n${esc}\\`;
  const filtered = filter.write(wrapped);
  assert.equal(filtered, wrapped);
  const splitFilter = new TmuxOutputFilter();
  const splitWrapped =
    Array.from(wrapped)
      .map((character) => splitFilter.write(character))
      .join("") + splitFilter.flush();
  assert.equal(splitWrapped, wrapped);
  await new Promise<void>((resolve) => terminal.write(splitWrapped, resolve));
  assert.deepEqual(replies, [`${esc}[1;1R`]);
});

test("direct queries do not trigger duplicate xterm replies, while other output stays intact", async (t) => {
  const filter = new TmuxOutputFilter();
  const terminal = new Terminal({ allowProposedApi: true });
  t.after(() => terminal.dispose());
  const replies: string[] = [];
  terminal.onData((data) => replies.push(data));

  const ordinary =
    "中文🐍" +
    `${esc}[31mred${esc}[0m` +
    `${esc}[?2004h` +
    `${esc}]10;rgb:12/34/56\x07` +
    `${esc}]11;rgb:ab/cd/ef${esc}\\`;
  const input =
    ordinary +
    `${esc}[5n${esc}[6n${esc}[c${esc}[0c${esc}[>c${esc}[>0c${esc}]10;?\x07${esc}]11;?\x07`;
  const output = filter.write(input) + filter.flush();
  assert.equal(output, ordinary);
  await new Promise<void>((resolve) => terminal.write(output, resolve));
  assert.deepEqual(replies, []);

  const interrupted = `${esc}[123${esc}[31m`;
  assert.equal(filter.write(interrupted), interrupted);
});

test("unknown long OSC and image strings stream without unbounded buffering", () => {
  const filter = new TmuxOutputFilter();
  const prefix = `${esc}]1337;File=name=opaque:`;
  const payload = "x".repeat(1024 * 1024);
  assert.equal(filter.write(prefix), prefix);
  assert.equal(filter.write(payload), payload);
  assert.equal(filter.write(`${esc}\\tail`), `${esc}\\tail`);
  assert.equal(filter.flush(), "");
});

test("flush preserves incomplete query prefixes and split UTF-16 characters", () => {
  const filter = new TmuxOutputFilter();
  assert.equal(filter.write("start" + `${esc}[6`), "start");
  assert.equal(filter.flush(), `${esc}[6`);

  const unicode = new TmuxOutputFilter();
  const text = "🐍";
  assert.equal(unicode.write(text.slice(0, 1)), "");
  assert.equal(unicode.write(text.slice(1)), text);
  assert.equal(unicode.flush(), "");
});
