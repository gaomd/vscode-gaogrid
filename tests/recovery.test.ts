import { test } from "node:test";
import assert from "node:assert/strict";
import { restoreState } from "../src/persistence-store";
import { getPaneDepth, getTabs } from "../src/webview/layout";
import type { LayoutNode } from "../src/model";

const tab = {
  id: "tab",
  sessionId: "pty",
  title: "Codex",
  cwd: "/saved",
  profile: "/bin/zsh",
  backend: "direct",
  backendSessionId: undefined,
  createdAt: undefined,
  updatedAt: undefined,
};
const pane = {
  type: "pane",
  id: "pane",
  activeTabId: "tab",
  tabs: [tab],
  lastKnownCwd: "/saved",
};

test("recovery preserves sessions in legacy layouts deeper than the new split limit", () => {
  let root: LayoutNode = {
    ...pane,
    type: "pane",
    tabs: [{ ...tab, backend: "direct" }],
  };
  for (let level = 0; level < 6; level++) {
    root = {
      type: "split",
      id: `legacy-${level}`,
      direction: "horizontal",
      ratio: 0.5,
      first: root,
      second: {
        ...pane,
        type: "pane",
        id: `sibling-${level}`,
        activeTabId: `tab-${level}`,
        tabs: [
          {
            ...tab,
            backend: "direct",
            id: `tab-${level}`,
            sessionId: `pty-${level}`,
          },
        ],
      },
    };
  }
  const recovered = restoreState({
    activeWorkspaceId: "ws",
    workspaces: [{ id: "ws", name: "^1", focusedPaneId: "pane", root }],
  });
  assert.equal(getPaneDepth(recovered.workspaces[0].root, "pane"), 6);
  assert.deepEqual(recovered.workspaces[0].root, root);
  assert.deepEqual(
    getTabs(recovered.workspaces[0].root).map((item) => item.sessionId),
    getTabs(root).map((item) => item.sessionId),
  );
});

test("restart recovery preserves workspace, split, pane, tab, cwd and shell identity", () => {
  const saved = {
    activeWorkspaceId: "ws",
    workspaces: [
      {
        id: "ws",
        name: "^1",
        focusedPaneId: "pane",
        root: {
          type: "split",
          id: "split",
          ratio: 0.4,
          direction: "vertical",
          first: pane,
          second: {
            ...pane,
            id: "other",
            tabs: [{ ...tab, id: "other-tab", sessionId: "other-pty" }],
            activeTabId: "other-tab",
          },
        },
      },
    ],
  };
  const recovered = restoreState(saved);
  assert.deepEqual(recovered, saved);
  assert.notEqual(recovered.workspaces[0].root, saved.workspaces[0].root);
});

test("invalid storage cannot prevent opening GaoGrid; valid siblings survive", () => {
  assert.deepEqual(restoreState(undefined), {
    workspaces: [],
    activeWorkspaceId: "",
  });
  assert.deepEqual(restoreState({ workspaces: "broken" }).workspaces, []);
  const recovered = restoreState({
    activeWorkspaceId: "missing",
    workspaces: [
      null,
      {
        id: "ws",
        root: { type: "split", id: "split", first: pane, second: null },
      },
    ],
  });
  assert.equal(recovered.activeWorkspaceId, "ws");
  assert.equal(recovered.workspaces[0].root?.id, "pane");
});

test("recovery repairs stale selection and only restores metadata, never commands", () => {
  const recovered = restoreState({
    workspaces: [
      {
        id: "ws",
        root: {
          ...pane,
          activeTabId: "missing",
          tabs: [null, { ...tab, command: "codex resume secret" }],
        },
      },
    ],
  });
  const root = recovered.workspaces[0].root;
  assert.equal(root?.type, "pane");
  if (root?.type !== "pane") return;
  assert.equal(root.activeTabId, "tab");
  assert.deepEqual(root.tabs, [tab]);
});

test("protected recovery restores backend identifiers and timestamps, never stale connection state", () => {
  const saved = {
    ...tab,
    backend: "tmux",
    backendSessionId: "gaogrid-id",
    createdAt: 123,
    updatedAt: 456,
    connectionState: "connected",
  };
  const result = restoreState({
    workspaces: [{ id: "ws", root: { ...pane, tabs: [saved] } }],
  });
  const root = result.workspaces[0].root;
  if (root?.type !== "pane") throw new Error("missing pane");
  assert.equal(root.tabs[0].backend, "tmux");
  assert.equal(root.tabs[0].backendSessionId, "gaogrid-id");
  assert.equal(root.tabs[0].createdAt, 123);
  assert.equal(root.tabs[0].updatedAt, 456);
  assert.equal(root.tabs[0].connectionState, undefined);
});
