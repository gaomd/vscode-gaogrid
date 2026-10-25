import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkspaceController } from "../src/webview/workspace-controller";
import type { PersistedState, PaneNode } from "../src/model";
import type { WorkspaceActions } from "../src/webview/ui/types";
import type { TerminalFrontend } from "../src/webview/terminal-frontend";
import type {
  LifecycleRequest,
  LifecycleResult,
} from "../src/terminal-protocol";
import { getPanes, getTabs } from "../src/webview/layout";

function pane(id: string, cwd: string): PaneNode {
  return {
    type: "pane",
    id,
    activeTabId: `${id}-1`,
    lastKnownCwd: cwd,
    tabs: [1, 2].map((index) => ({
      id: `${id}-${index}`,
      sessionId: `${id}-s${index}`,
      title: "terminal",
      cwd,
    })),
  };
}

function fixture() {
  const a = pane("a", "/frontend");
  const b = pane("b", "/backend");
  return {
    activeWorkspaceId: "one",
    workspaces: [
      {
        id: "one",
        name: "^1",
        focusedPaneId: "b",
        root: {
          type: "split",
          id: "split",
          direction: "horizontal",
          ratio: 0.4,
          first: a,
          second: b,
        },
      },
      { id: "two", name: "^2", focusedPaneId: "c", root: pane("c", "/other") },
    ],
  } as PersistedState;
}

function harness(initial = fixture()) {
  let state = initial;
  let actions: WorkspaceActions;
  const requests: LifecycleRequest[] = [];
  const disposed: string[] = [];
  const focused: string[] = [];
  let close: () => Promise<boolean> = async () => true;
  const controller = new WorkspaceController(
    {} as HTMLElement,
    {
      focus: (tabId: string) => focused.push(tabId),
      disposeTab: (tab: { id: string }) => disposed.push(tab.id),
      scheduleFit() {},
    } as unknown as TerminalFrontend,
    {
      send() {},
      persist: (value) => {
        state = structuredClone(value);
      },
      request: async (request): Promise<LifecycleResult> => {
        requests.push(request);
        if (request.kind === "close") return close();
        const active = initial.workspaces
          .flatMap((workspace) => getTabs(workspace.root))
          .find((tab) => tab.sessionId === request.sessionId);
        return (
          request.explicitCwd ||
          active?.cwd ||
          request.lastKnownCwd ||
          "/workspace"
        );
      },
    },
    (_root, intent) => {
      actions = intent;
      return { update() {}, setFocusedPane() {} };
    },
  );
  controller.restore(initial);
  return {
    controller,
    actions: actions!,
    requests,
    disposed,
    focused,
    state: () => state,
    close: (callback: () => Promise<boolean>) => {
      close = callback;
    },
  };
}

async function settled() {
  await new Promise((resolve) => setImmediate(resolve));
}

test("new tabs and nested splits inherit only the source pane and retain other selections", async () => {
  const h = harness();
  h.actions.createTab("b");
  await settled();
  const first = h.state().workspaces[0];
  const panes = getPanes(first.root);
  assert.equal(panes[0].activeTabId, "a-1");
  assert.equal(panes[1].tabs.at(-1)?.cwd, "/backend");
  assert.equal(panes[1].tabs.length, 3);
  assert.equal(h.focused.at(-1), panes[1].activeTabId);
  h.actions.splitPane("b", "vertical");
  await settled();
  const split = h.state().workspaces[0].root!;
  assert.equal(split.type, "split");
  if (split.type !== "split") return;
  assert.equal(split.ratio, 0.4);
  assert.equal(split.second.type, "split");
  const all = getPanes(split);
  assert.equal(all.length, 3);
  assert.equal(all[2].tabs[0].cwd, "/backend");
  assert.equal(all[0].activeTabId, "a-1");
});

test("explicit cwd/profile override inheritance through the command action", async () => {
  const h = harness();
  h.controller.performAction("newTab", undefined, {
    cwd: "/explicit",
    profile: "/bin/bash",
  });
  await settled();
  const tab = getPanes(h.state().workspaces[0].root)[1].tabs.at(-1)!;
  assert.equal(tab.cwd, "/explicit");
  assert.equal(tab.profile, "/bin/bash");
});

test("pending and cancelled close preserve layout, output ownership, selection, and focus", async () => {
  const h = harness();
  const before = structuredClone(h.state());
  let cancel!: (value: boolean) => void;
  h.close(
    () =>
      new Promise((resolve) => {
        cancel = resolve;
      }),
  );
  h.controller.performAction("closeTab");
  await settled();
  assert.deepEqual(h.state(), before);
  assert.deepEqual(h.disposed, []);
  cancel(false);
  await settled();
  assert.deepEqual(h.state(), before);
  assert.deepEqual(h.disposed, []);
  assert.equal(h.focused.at(-1), "b-1");
});

test("duplicate closes target the original tab once and collapse empty panes", async () => {
  const h = harness();
  h.actions.closeTab("b", "b-1");
  h.actions.closeTab("b", "b-1");
  await settled();
  assert.deepEqual(h.disposed, ["b-1"]);
  assert.equal(
    h.requests.filter((request) => request.kind === "close").length,
    1,
  );
  assert.equal(getPanes(h.state().workspaces[0].root)[1].activeTabId, "b-2");
  h.actions.closeTab("b", "b-2");
  await settled();
  assert.equal(h.state().workspaces[0].root?.id, "a");
});

test("workspace close is atomic, aggregates all terminals, and focuses the adjacent workspace", async () => {
  const h = harness();
  h.close(async () => false);
  const before = structuredClone(h.state());
  h.actions.closeWorkspace("one");
  await settled();
  assert.deepEqual(h.state(), before);
  assert.deepEqual(h.disposed, []);
  h.close(async () => true);
  h.actions.closeWorkspace("one");
  await settled();
  assert.equal(h.state().activeWorkspaceId, "two");
  assert.equal(h.state().workspaces[0].name, "^1");
  assert.deepEqual(h.disposed, ["a-1", "a-2", "b-1", "b-2"]);
  const request = h.requests.at(-1)!;
  assert.equal(request.kind, "close");
  if (request.kind === "close") {
    assert.equal(request.scope, "workspace");
    assert.equal(request.terminals.length, 4);
  }
});

test("pane closure uses a single aggregate request and keeps existing empty-pane semantics", async () => {
  const h = harness();
  h.controller.performAction("closePane");
  await settled();
  assert.equal(h.requests.length, 1);
  const request = h.requests[0];
  assert.equal(request.kind, "close");
  if (request.kind === "close") {
    assert.equal(request.scope, "pane");
    assert.equal(request.terminals.length, 2);
  }
  assert.equal(h.state().workspaces[0].root?.id, "a");
  h.controller.performAction("closePane");
  await settled();
  assert.equal(h.state().workspaces[0].root, null);
});

test("rapid new-tab requests in an empty workspace share a pane and respect the tab limit", async () => {
  const h = harness({
    activeWorkspaceId: "one",
    workspaces: [{ id: "one", name: "^1", root: null }],
  });
  for (let i = 0; i < 12; i++) h.controller.performAction("newTab");
  await settled();
  const panes = getPanes(h.state().workspaces[0].root);
  assert.equal(panes.length, 1);
  assert.equal(panes[0].tabs.length, 9);
  assert.equal(h.disposed.length, 0);
});
