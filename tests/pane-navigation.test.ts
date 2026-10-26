import { test } from "node:test";
import assert from "node:assert/strict";
import type { LayoutNode, PaneNode, SplitNode } from "../src/model";
import { findAdjacentPane, type PaneDirection } from "../src/webview/layout";
import { resolveShortcut } from "../src/webview/shortcuts";

function pane(id: string): PaneNode {
  return { type: "pane", id, tabs: [], activeTabId: null };
}
function split(
  direction: SplitNode["direction"],
  first: LayoutNode,
  second: LayoutNode,
  ratio = 0.5,
): SplitNode {
  return {
    type: "split",
    id: `${first.id}-${second.id}`,
    direction,
    first,
    second,
    ratio,
  };
}

const layout = split(
  "horizontal",
  split("vertical", pane("a"), pane("b"), 0.2),
  split("vertical", pane("c"), pane("d"), 0.6),
  0.35,
);

test("pane navigation follows direction and center alignment through unequal nested splits", () => {
  const before = structuredClone(layout);
  for (const [source, direction, expected] of [
    ["a", "right", "c"],
    ["b", "right", "d"],
    ["c", "left", "a"],
    ["d", "left", "b"],
    ["a", "down", "b"],
    ["b", "up", "a"],
    ["c", "down", "d"],
    ["d", "up", "c"],
  ] as const)
    assert.equal(findAdjacentPane(layout, source, direction)?.id, expected);
  assert.deepEqual(layout, before);
});

test("pane navigation stops at every outer edge without wrapping", () => {
  for (const [source, directions] of [
    ["a", ["up", "left"]],
    ["b", ["down", "left"]],
    ["c", ["up", "right"]],
    ["d", ["down", "right"]],
  ] as const)
    for (const direction of directions)
      assert.equal(findAdjacentPane(layout, source, direction), undefined);
});

test("pane navigation selects the closest column and handles empty or single-pane layouts", () => {
  const columns = split(
    "horizontal",
    pane("a"),
    split("horizontal", pane("b"), pane("c")),
  );
  assert.equal(findAdjacentPane(columns, "a", "right")?.id, "b");
  assert.equal(findAdjacentPane(columns, "c", "left")?.id, "b");
  assert.equal(findAdjacentPane(columns, "b", "down"), undefined);
  for (const direction of ["up", "down", "left", "right"] as PaneDirection[]) {
    assert.equal(findAdjacentPane(pane("a"), "a", direction), undefined);
    assert.equal(findAdjacentPane(null, "a", direction), undefined);
    assert.equal(findAdjacentPane(columns, "missing", direction), undefined);
  }
});

test("only unshifted Alt+Ctrl arrows focus panes and IME events are ignored", () => {
  const event = {
    altKey: true,
    ctrlKey: true,
    metaKey: false,
    shiftKey: false,
  };
  for (const [key, action] of [
    ["ArrowUp", "focusPaneUp"],
    ["ArrowDown", "focusPaneDown"],
    ["ArrowLeft", "focusPaneLeft"],
    ["ArrowRight", "focusPaneRight"],
  ]) {
    assert.equal(resolveShortcut({ ...event, key })?.action, action);
    for (const override of [
      { shiftKey: true },
      { metaKey: true },
      { altKey: false },
      { ctrlKey: false },
      { isComposing: true },
      { keyCode: 229 },
    ])
      assert.equal(resolveShortcut({ ...event, key, ...override }), undefined);
  }
  assert.equal(resolveShortcut({ ...event, key: "," }), undefined);
});
