import { test } from "node:test";
import assert from "node:assert/strict";
import type { Terminal } from "@xterm/xterm";
import { installTerminalInput } from "../src/webview/terminal-input";

function harness(useNativeText = true, beforeinput = true) {
  const host = Object.assign(new EventTarget(), { value: "" });
  if (beforeinput) Object.assign(host, { onbeforeinput: null });
  const sent: string[] = [];
  let handler: (event: KeyboardEvent) => boolean = () => true;
  const terminal = {
    textarea: host,
    input: (data: string) => sent.push(data),
    attachCustomKeyEventHandler: (callback: typeof handler) => {
      handler = callback;
    },
  } as unknown as Terminal;
  const dispose = installTerminalInput(
    terminal,
    host as unknown as HTMLElement,
    useNativeText,
  );
  const key = (type: string, overrides: Partial<KeyboardEvent> = {}) => {
    const event = Object.assign(new Event(type, { cancelable: true }), {
      key: ",",
      code: "Comma",
      keyCode: 188,
      altKey: false,
      ctrlKey: false,
      shiftKey: false,
      metaKey: false,
      isComposing: false,
      ...overrides,
    }) as KeyboardEvent;
    return { event, handledByXterm: handler(event) };
  };
  const input = (
    data: string,
    overrides: {
      type?: string;
      cancelable?: boolean;
      inputType?: string;
      isComposing?: boolean;
    } = {},
  ) => {
    const { type = "beforeinput", cancelable = true, ...values } = overrides;
    const event = Object.assign(new Event(type, { cancelable }), {
      data,
      inputType: "insertText",
      isComposing: false,
      ...values,
    });
    host.dispatchEvent(event);
    return event;
  };
  return { host, sent, dispose, key, input };
}

test("macOS punctuation is sent from the IME commit rather than ASCII keydown, exactly once", (t) => {
  const h = harness();
  t.after(h.dispose);
  for (const [key, code, text] of [
    [",", "Comma", "，"],
    [".", "Period", "。"],
    ["!", "Digit1", "！"],
  ]) {
    const down = h.key("keydown", { key, code });
    assert.equal(down.handledByXterm, false);
    assert.equal(
      down.event.defaultPrevented,
      false,
      "allow the IME to transform the key",
    );
    assert.equal(h.key("keypress", { key, code }).handledByXterm, false);
    assert.equal(h.input(text).defaultPrevented, true);
    assert.equal(
      h.input(text, { type: "input", cancelable: false }).defaultPrevented,
      false,
    );
    assert.equal(h.key("keyup", { key, code }).handledByXterm, false);
  }
  assert.deepEqual(h.sent, ["，", "。", "！"]);
});

test("ASCII punctuation and repeated punctuation retain the browser's text", (t) => {
  const h = harness();
  t.after(h.dispose);
  for (const key of [",", ".", "!", "?", "_", ",", ","]) {
    h.key("keydown", { key, code: "KeyX" });
    h.input(key);
    h.key("keyup", { key, code: "KeyX" });
  }
  assert.equal(h.sent.join(""), ",.!?_,,");
});

test("non-cancelable IME insertions use input once and clear the helper textarea", (t) => {
  const h = harness();
  t.after(h.dispose);
  h.key("keydown");
  h.input("，", { cancelable: false });
  assert.deepEqual(h.sent, []);
  h.host.value = "，";
  h.input("，", { type: "input", cancelable: false });
  h.input("，", { type: "input", cancelable: false });
  assert.deepEqual(h.sent, ["，"]);
  assert.equal(h.host.value, "");
});

test("Chinese composition and candidate commits remain owned by xterm", (t) => {
  const h = harness();
  t.after(h.dispose);
  assert.equal(h.key("keydown", { isComposing: true }).handledByXterm, true);
  assert.equal(h.key("keydown", { keyCode: 229 }).handledByXterm, true);
  h.key("keydown");
  h.host.dispatchEvent(new Event("compositionstart"));
  assert.equal(h.key("keydown").handledByXterm, true);
  assert.equal(
    h.input("中文", { isComposing: true, inputType: "insertCompositionText" })
      .defaultPrevented,
    false,
  );
  assert.equal(h.input("中文").defaultPrevented, false);
  assert.deepEqual(h.sent, []);
});

test("control keys, modifier chords, paste, and unmatched key releases keep their original paths", (t) => {
  const h = harness();
  t.after(h.dispose);
  for (const override of [
    { ctrlKey: true },
    { altKey: true },
    { metaKey: true },
    { key: "Enter" },
    { key: "Backspace" },
    { key: "ArrowLeft" },
    { key: "a" },
    { key: "A" },
    { key: " " },
  ])
    assert.equal(h.key("keydown", override).handledByXterm, true);
  h.key("keydown");
  assert.equal(
    h.input("PASTE", { inputType: "insertFromPaste" }).defaultPrevented,
    false,
  );
  assert.equal(
    h.key("keyup", { code: "ShiftLeft", key: "Shift" }).handledByXterm,
    true,
  );
  assert.equal(h.key("keyup").handledByXterm, false);
  assert.deepEqual(h.sent, []);
});

test("dead keys and their completion stay entirely on xterm's native path", (t) => {
  const h = harness();
  t.after(h.dispose);
  assert.equal(h.key("keydown", { key: "Dead" }).handledByXterm, true);
  assert.equal(h.key("keydown", { key: "é" }).handledByXterm, true);
  assert.equal(h.input("é").defaultPrevented, false);
  assert.deepEqual(h.sent, []);
  assert.equal(h.key("keydown").handledByXterm, false);
});

test("Shift+Enter retains CSI-u and never submits an IME candidate as terminal input", (t) => {
  const h = harness();
  t.after(h.dispose);
  const down = h.key("keydown", {
    key: "Enter",
    code: "Enter",
    shiftKey: true,
  });
  assert.equal(down.handledByXterm, false);
  assert.equal(down.event.defaultPrevented, true);
  assert.deepEqual(h.sent, ["\x1b[13;2u"]);
  h.key("keydown", {
    key: "Enter",
    code: "Enter",
    shiftKey: true,
    isComposing: true,
  });
  h.key("keydown", {
    key: "Enter",
    code: "Enter",
    shiftKey: true,
    keyCode: 229,
  });
  assert.equal(h.sent.length, 1);
});

test("blur and disposal clear ownership and unsupported platforms retain xterm's normal behavior", () => {
  const h = harness();
  h.key("keydown");
  h.host.dispatchEvent(new Event("blur"));
  assert.equal(h.input("，").defaultPrevented, false);
  h.key("keydown");
  h.dispose();
  assert.equal(h.input("，").defaultPrevented, false);
  assert.equal(h.key("keydown").handledByXterm, true);
  assert.deepEqual(h.sent, []);
  for (const other of [harness(false), harness(true, false)]) {
    assert.equal(other.key("keydown").handledByXterm, true);
    assert.equal(other.input("，").defaultPrevented, false);
    assert.deepEqual(other.sent, []);
    other.dispose();
  }
});
