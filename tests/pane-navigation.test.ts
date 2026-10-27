import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  LayoutNode,
  PaneNode,
  PersistedState,
  SplitNode,
} from "../src/model";
import {
  findAdjacentPane,
  findPaneAfterRemoval,
  removeTabFromState,
  type PaneDirection,
} from "../src/webview/layout";
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

test("pane navigation follows shared horizontal edges and vertical center alignment through unequal splits", () => {
  const before = structuredClone(layout);
  for (const [source, direction, expected] of [
    ["a", "right", "c"],
    ["b", "right", "d"],
    ["c", "left", "b"],
    ["d", "left", "b"],
    ["a", "down", "b"],
    ["b", "up", "a"],
    ["c", "down", "d"],
    ["d", "up", "c"],
  ] as const)
    assert.equal(findAdjacentPane(layout, source, direction)?.id, expected);
  assert.deepEqual(layout, before);
});

test("left/right navigation prefers the immediate large neighbor over a shallow middle pane", () => {
  // Reproduce a full-height lower-left pane beside two upper columns and two
  // short full-width rows. Their centers must not pull focus into the middle.
  const screenshot = split(
    "vertical",
    pane("top"),
    split(
      "horizontal",
      pane("lower-left"),
      split(
        "vertical",
        split("horizontal", pane("upper-near"), pane("upper-far")),
        split("vertical", pane("middle"), pane("bottom")),
      ),
    ),
  );
  assert.equal(
    findAdjacentPane(screenshot, "lower-left", "right")?.id,
    "upper-near",
  );
  assert.equal(
    findAdjacentPane(screenshot, "upper-far", "left")?.id,
    "upper-near",
  );
  assert.equal(
    findAdjacentPane(screenshot, "upper-near", "left")?.id,
    "lower-left",
  );
  assert.equal(
    findAdjacentPane(screenshot, "middle", "left")?.id,
    "lower-left",
  );
  assert.equal(
    findAdjacentPane(screenshot, "bottom", "left")?.id,
    "lower-left",
  );
  assert.equal(
    findAdjacentPane(screenshot, "upper-near", "down")?.id,
    "middle",
  );
  assert.equal(findAdjacentPane(screenshot, "middle", "down")?.id, "bottom");
  assert.equal(findAdjacentPane(screenshot, "lower-left", "down"), undefined);
});

test("pane removal focuses the surviving sibling branch rather than a later global pane", () => {
  const root = split(
    "horizontal",
    split("horizontal", pane("a"), pane("b")),
    pane("unrelated"),
  );
  assert.equal(findPaneAfterRemoval(root, "b")?.id, "a");
  assert.equal(findPaneAfterRemoval(root, "a")?.id, "b");
  const nested = split(
    "horizontal",
    split(
      "vertical",
      split("horizontal", pane("a"), pane("b")),
      pane("removed"),
    ),
    pane("unrelated"),
  );
  assert.equal(findPaneAfterRemoval(nested, "removed")?.id, "a");
  assert.equal(findPaneAfterRemoval(pane("only"), "only"), undefined);
  assert.equal(findPaneAfterRemoval(null, "missing"), undefined);
});

test("host-side last-tab removal keeps focus in the collapsed split and preserves unrelated focus", () => {
  for (const focusedPaneId of ["b", "unrelated"]) {
    const root = split(
      "horizontal",
      split("horizontal", pane("a"), pane("b")),
      pane("unrelated"),
    );
    const b = (root.first as SplitNode).second as PaneNode;
    b.tabs = [
      {
        id: "tab-b",
        sessionId: "session-b",
        title: "shell",
        cwd: "/",
        backend: "direct",
      },
    ];
    b.activeTabId = "tab-b";
    const state: PersistedState = {
      activeWorkspaceId: "workspace",
      workspaces: [{ id: "workspace", name: "^1", focusedPaneId, root }],
    };
    assert.equal(removeTabFromState(state, "session-b")?.id, "tab-b");
    assert.equal(
      state.workspaces[0].focusedPaneId,
      focusedPaneId === "b" ? "a" : "unrelated",
    );
    assert.equal((state.workspaces[0].root as SplitNode).first.id, "a");
  }
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
