import { test } from "node:test";
import assert from "node:assert/strict";
import { restoreState } from "../src/persistence-store";

const tab = {
  id: "tab",
  sessionId: "pty",
  title: "Codex",
  cwd: "/saved",
  profile: "/bin/zsh",
};
const pane = {
  type: "pane",
  id: "pane",
  activeTabId: "tab",
  tabs: [tab],
  lastKnownCwd: "/saved",
};

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
