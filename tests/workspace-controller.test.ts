import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkspaceController } from "../src/webview/workspace-controller";
import type { LayoutNode, PersistedState, PaneNode } from "../src/model";
import type { WorkspaceActions } from "../src/webview/ui/types";
import type { TerminalFrontend } from "../src/webview/terminal-frontend";
import type {
  LifecycleRequest,
  LifecycleResult,
} from "../src/terminal-protocol";
import { getPaneDepth, getPanes, getTabs } from "../src/webview/layout";
import { resolveShortcut } from "../src/webview/shortcuts";

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
      backend: "direct",
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

function nestedLayout(depth: number, target: PaneNode): LayoutNode {
  let root: LayoutNode = target;
  for (let level = 0; level < depth; level++)
    root = {
      type: "split",
      id: `${target.id}-split-${level}`,
      direction: level % 2 ? "vertical" : "horizontal",
      ratio: 0.5,
      first: root,
      second: pane(`${target.id}-sibling-${level}`, "/sibling"),
    };
  return root;
}

function layoutFixture(
  root: LayoutNode,
  focusedPaneId: string,
): PersistedState {
  return {
    activeWorkspaceId: "one",
    workspaces: [{ id: "one", name: "^1", root, focusedPaneId }],
  };
}

function harness(initial = fixture()) {
  let state = initial;
  let actions: WorkspaceActions;
  const requests: LifecycleRequest[] = [];
  const disposed: string[] = [];
  const sent: any[] = [];
  let protect: (
    request: LifecycleRequest,
  ) => Promise<LifecycleResult> = async () => false;
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
      send(message) {
        sent.push(message);
      },
      persist: (value) => {
        state = structuredClone(value);
      },
      request: async (request): Promise<LifecycleResult> => {
        requests.push(request);
        if (request.kind === "close") return close();
        if (request.kind === "protect" || request.kind === "reconnect")
          return protect(request);
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
    sent,
    protection: (callback: typeof protect) => {
      protect = callback;
    },
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

test("shell exit removes its tab and focuses the adjacent tab without a close request", async () => {
  const h = harness();
  h.controller.sessionEnded("b-s1");
  await settled();
  const panes = getPanes(h.state().workspaces[0].root);
  assert.deepEqual(
    panes[1].tabs.map((tab) => tab.id),
    ["b-2"],
  );
  assert.equal(panes[1].activeTabId, "b-2");
  assert.equal(h.focused.at(-1), "b-2");
  assert.equal(panes[0].tabs.length, 2);
  assert.deepEqual(h.disposed, ["b-1"]);
  assert.deepEqual(h.requests, []);
  h.controller.sessionEnded("b-s1");
  await settled();
  assert.deepEqual(h.disposed, ["b-1"]);
});

test("the last shell exiting closes its workspace when another workspace remains", async () => {
  const initial = fixture();
  const first = pane("a", "/frontend");
  first.tabs.splice(1);
  initial.workspaces[0].root = first;
  initial.workspaces[0].focusedPaneId = first.id;
  const h = harness(initial);
  h.controller.sessionEnded("a-s1");
  await settled();
  assert.deepEqual(
    h.state().workspaces.map((workspace) => workspace.id),
    ["two"],
  );
  assert.equal(h.state().activeWorkspaceId, "two");
  assert.equal(h.state().workspaces[0].name, "^1");
  assert.deepEqual(h.disposed, ["a-1"]);
  assert.deepEqual(h.requests, []);
});

test("window handoff waits for pending tab creation and retains the same layout and terminals", async () => {
  const h = harness();
  h.controller.setPresentation({
    mode: "sidebar",
    canDetach: true,
    canMaximize: true,
    transitioning: false,
  });
  assert.equal(h.actions.windowPresentation().mode, "sidebar");
  h.actions.createTab("b");
  const handoff = await h.controller.preparePresentation();
  const source = getPanes(handoff.workspaces[0].root)[1];
  assert.equal(source.tabs.length, 3);
  assert.equal(source.activeTabId, source.tabs[2].id);
  const before = structuredClone(handoff);
  h.controller.setPresentation({
    mode: "window",
    canDetach: true,
    canMaximize: true,
    transitioning: true,
  });
  assert.deepEqual(await h.controller.preparePresentation(), before);
  assert.deepEqual(h.disposed, []);
  h.actions.toggleWindow();
  assert.deepEqual(h.sent.at(-1), { type: "toggleWindow" });
});

test("window shortcuts respect presentation capabilities and leave detached Cmd+X available", () => {
  const h = harness();
  const before = structuredClone(h.state());
  const press = (key: string) => {
    const shortcut = resolveShortcut({
      key,
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
    });
    assert.ok(shortcut);
    h.controller.performAction(shortcut.action);
  };
  const available = {
    mode: "sidebar" as const,
    canDetach: true,
    canMaximize: true,
    transitioning: false,
  };
  h.controller.setPresentation(available);
  press("d");
  press("x");
  assert.deepEqual(h.sent.splice(0), [
    { type: "toggleWindow" },
    { type: "toggleSidebarSize" },
  ]);

  h.controller.setPresentation({ ...available, mode: "window" });
  assert.equal(h.controller.canToggleSidebarSize(), false);
  press("d");
  press("x");
  assert.deepEqual(h.sent.splice(0), [{ type: "toggleWindow" }]);

  h.controller.setPresentation({ ...available, transitioning: true });
  press("d");
  press("x");
  h.controller.setPresentation({
    ...available,
    canDetach: false,
    canMaximize: false,
  });
  press("d");
  press("x");
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.state(), before);
  assert.deepEqual(h.disposed, []);
});

test("sidebar resize completion restores the current terminal without changing selection or layout", () => {
  const h = harness();
  const available = {
    mode: "sidebar" as const,
    canDetach: true,
    canMaximize: true,
    transitioning: false,
  };
  h.controller.setPresentation(available);
  h.controller.performAction("toggleSidebarSize");
  assert.deepEqual(h.sent, [{ type: "toggleSidebarSize" }]);

  // A selection change while the host resizes must win over the old tab.
  h.actions.activateWorkspace("two");
  h.actions.activateTab("c", "c-2");
  const before = structuredClone(h.state());
  h.focused.length = 0;
  h.controller.performAction("focusTerminal");
  assert.deepEqual(h.focused, ["c-2"]);
  assert.deepEqual(h.state(), before);
  assert.deepEqual(h.disposed, []);

  // A resize reply must not interfere with an in-progress window handoff.
  h.controller.setPresentation({ ...available, transitioning: true });
  h.focused.length = 0;
  h.controller.performAction("focusTerminal");
  assert.deepEqual(h.focused, []);
});

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
  h.actions.splitPane("b", "bottom");
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

for (const [direction, arrow, letter, glyph] of [
  ["Up", "ArrowUp", "KeyT", "ˇ"],
  ["Down", "ArrowDown", "KeyD", "Î"],
  ["Left", "ArrowLeft", "KeyL", "Ò"],
  ["Right", "ArrowRight", "KeyR", "‰"],
] as const) {
  for (const [key, code] of [
    [arrow, arrow],
    [glyph, letter],
  ]) {
    test(`${code} splits ${direction.toLowerCase()} relative to the focused pane and preserves existing terminals`, async () => {
      const h = harness();
      h.actions.activateTab("b", "b-2");
      const before = structuredClone(h.state());
      const originalRoot = before.workspaces[0].root!;
      assert.equal(originalRoot.type, "split");
      if (originalRoot.type !== "split") return;
      const shortcut = resolveShortcut({
        key,
        code,
        metaKey: false,
        ctrlKey: false,
        altKey: true,
        shiftKey: true,
      });
      assert.equal(shortcut?.action, `split${direction}`);
      h.controller.performAction(shortcut!.action);
      await settled();

      const workspace = h.state().workspaces[0];
      const root = workspace.root!;
      assert.equal(root.type, "split");
      if (root.type !== "split") return;
      assert.equal(root.ratio, 0.4);
      assert.deepEqual(root.first, originalRoot.first);
      const split = root.second;
      assert.equal(split.type, "split");
      if (split.type !== "split") return;
      assert.equal(
        split.direction,
        direction === "Left" || direction === "Right"
          ? "horizontal"
          : "vertical",
      );
      assert.equal(split.ratio, 0.5);
      const newFirst = direction === "Up" || direction === "Left";
      const fresh = newFirst ? split.first : split.second;
      const source = newFirst ? split.second : split.first;
      assert.equal(fresh.type, "pane");
      assert.equal(source.type, "pane");
      if (fresh.type !== "pane" || source.type !== "pane") return;
      assert.deepEqual(source, originalRoot.second);
      assert.equal(fresh.tabs.length, 1);
      assert.equal(fresh.tabs[0].cwd, "/backend");
      assert.equal(workspace.focusedPaneId, fresh.id);
      assert.equal(h.focused.at(-1), fresh.activeTabId);
      assert.deepEqual(h.state().workspaces[1], before.workspaces[1]);
      assert.deepEqual(h.disposed, []);
      assert.equal(
        h.sent.filter((message) => message.type === "start").length,
        1,
      );
    });
  }
}

test("split shortcuts leave unshifted Option/Alt navigation, extra modifiers, and IME composition alone", () => {
  const base = {
    key: "ArrowLeft",
    code: "ArrowLeft",
    altKey: true,
    shiftKey: true,
    metaKey: false,
    ctrlKey: false,
  };
  for (const [key, code] of [
    ["ArrowLeft", "ArrowLeft"],
    ["d", "KeyD"],
    ["t", "KeyT"],
  ]) {
    assert.equal(
      resolveShortcut({ ...base, key, code, shiftKey: false }),
      undefined,
    );
  }
  assert.equal(resolveShortcut({ ...base, metaKey: true }), undefined);
  assert.equal(resolveShortcut({ ...base, ctrlKey: true }), undefined);
  assert.equal(resolveShortcut({ ...base, isComposing: true }), undefined);
  assert.equal(resolveShortcut({ ...base, keyCode: 229 }), undefined);
});

test("Alt+Shift+Space distributes panes without intercepting other modifiers or IME", () => {
  const event = {
    key: " ",
    code: "Space",
    altKey: true,
    shiftKey: true,
    metaKey: false,
    ctrlKey: false,
  };
  assert.equal(resolveShortcut(event)?.action, "distributePanes");
  assert.equal(
    resolveShortcut({ ...event, key: "\u00a0" })?.action,
    "distributePanes",
  );
  for (const override of [
    { shiftKey: false },
    { ctrlKey: true },
    { metaKey: true },
    { isComposing: true },
    { keyCode: 229 },
  ])
    assert.equal(resolveShortcut({ ...event, ...override }), undefined);
  assert.equal(
    resolveShortcut({
      ...event,
      key: "1",
      code: "Digit1",
      altKey: false,
      shiftKey: false,
      ctrlKey: true,
      keyCode: 229,
    }),
    undefined,
  );
});

function distributionFixture(): PersistedState {
  return {
    activeWorkspaceId: "one",
    workspaces: [
      {
        id: "one",
        name: "^1",
        focusedPaneId: "b",
        root: {
          type: "split",
          id: "rows",
          direction: "vertical",
          ratio: 0.7,
          first: {
            type: "split",
            id: "columns",
            direction: "horizontal",
            ratio: 0.2,
            first: pane("a", "/a"),
            second: {
              type: "split",
              id: "inner",
              direction: "horizontal",
              ratio: 0.3,
              first: pane("b", "/b"),
              second: pane("c", "/c"),
            },
          },
          second: {
            type: "split",
            id: "lower",
            direction: "vertical",
            ratio: 0.25,
            first: pane("d", "/d"),
            second: pane("e", "/e"),
          },
        },
      },
      fixture().workspaces[1],
    ],
  };
}

test("one distribution balances the nearest split and preserves terminals, focus, and other groups", async () => {
  const initial = distributionFixture();
  const before = structuredClone(initial);
  const h = harness(initial);
  h.controller.performAction("distributePanes");
  await settled();
  const expected = structuredClone(before);
  const rows = expected.workspaces[0].root!;
  assert.equal(rows.type, "split");
  if (
    rows.type !== "split" ||
    rows.first.type !== "split" ||
    rows.first.second.type !== "split"
  )
    return;
  rows.first.second.ratio = 0.5;
  assert.deepEqual(h.state(), expected);
  assert.equal(h.focused.at(-1), "b-1");
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.requests, []);
  assert.deepEqual(h.disposed, []);
});

test("a double distribution within 400 ms balances every workspace group including three adjacent columns", async (t) => {
  let now = 1000;
  t.mock.method(performance, "now", () => now);
  const initial = distributionFixture();
  const before = structuredClone(initial);
  const h = harness(initial);
  h.controller.performAction("distributePanes");
  now += 250;
  h.controller.performAction("distributePanes");
  await settled();
  const expected = structuredClone(before);
  const rows = expected.workspaces[0].root!;
  if (
    rows.type !== "split" ||
    rows.first.type !== "split" ||
    rows.first.second.type !== "split" ||
    rows.second.type !== "split"
  )
    throw new Error("Invalid fixture");
  rows.ratio = 1 / 3;
  rows.first.ratio = 1 / 3;
  rows.first.second.ratio = 0.5;
  rows.second.ratio = 0.5;
  assert.deepEqual(h.state(), expected);
  assert.deepEqual(
    getTabs(h.state().workspaces[0].root),
    getTabs(before.workspaces[0].root),
  );
  assert.equal(h.focused.at(-1), "b-1");
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.requests, []);
  assert.deepEqual(h.disposed, []);
});

test("timeout, intervening actions, and lost focus reset the distribution double press", async (t) => {
  let now = 1000;
  t.mock.method(performance, "now", () => now);
  for (const reset of [
    () => {
      now += 401;
    },
    (h: ReturnType<typeof harness>) => h.controller.resetDistributionShortcut(),
    (h: ReturnType<typeof harness>) =>
      h.controller.performAction("focusTerminal"),
    (h: ReturnType<typeof harness>) => {
      h.actions.activateWorkspace("two");
      h.actions.activateWorkspace("one");
    },
    (h: ReturnType<typeof harness>) => {
      h.actions.focusPane("a");
      h.actions.focusPane("b");
    },
  ]) {
    const h = harness(distributionFixture());
    h.controller.performAction("distributePanes");
    await settled();
    const afterSingle = structuredClone(h.state());
    reset(h);
    now += 50;
    h.controller.performAction("distributePanes");
    await settled();
    assert.deepEqual(h.state(), afterSingle);
  }
});

test("the workspace distribution command works directly and a single pane is unchanged", async () => {
  const h = harness(distributionFixture());
  h.controller.performAction("distributeWorkspacePanes");
  await settled();
  const root = h.state().workspaces[0].root!;
  assert.equal(root.type, "split");
  if (root.type === "split") assert.equal(root.ratio, 1 / 3);
  const single = harness(layoutFixture(pane("only", "/only"), "only"));
  const before = structuredClone(single.state());
  single.controller.performAction("distributePanes");
  single.controller.performAction("distributePanes");
  single.controller.performAction("distributeWorkspacePanes");
  await settled();
  assert.deepEqual(single.state(), before);
  assert.deepEqual(single.sent, []);
  assert.deepEqual(single.requests, []);
});

test("splitting reaches depth four, blocks every further split entry point, and leaves shallower panes available", async () => {
  const target = pane("limit-root", "/limit");
  const h = harness(layoutFixture(target, target.id));
  for (const [index, action] of [
    "splitUp",
    "splitLeft",
    "splitDown",
    "splitRight",
  ].entries()) {
    const workspace = h.state().workspaces[0];
    assert.equal(h.actions.canSplitPane(workspace.focusedPaneId!), true);
    h.controller.performAction(action);
    await settled();
    const updated = h.state().workspaces[0];
    assert.equal(getPaneDepth(updated.root, updated.focusedPaneId!), index + 1);
  }
  const workspace = h.state().workspaces[0];
  const cappedId = workspace.focusedPaneId!;
  const cappedPane = getPanes(workspace.root).find(
    (item) => item.id === cappedId,
  )!;
  const before = structuredClone(h.state());
  const requests = h.requests.length;
  const starts = h.sent.filter((item) => item.type === "start").length;
  assert.equal(h.actions.canSplitPane(cappedId), false);
  assert.equal(
    h.actions.canSplitTabIntoPane(cappedPane.tabs[0].id, cappedId),
    false,
  );
  for (const action of ["splitUp", "splitDown", "splitLeft", "splitRight"])
    h.controller.performAction(action);
  h.actions.splitPane(cappedId, "right");
  h.actions.splitTabIntoPane(cappedPane.tabs[0].id, cappedId, "top");
  await settled();
  assert.deepEqual(h.state(), before);
  assert.equal(h.requests.length, requests);
  assert.equal(h.sent.filter((item) => item.type === "start").length, starts);
  assert.deepEqual(h.disposed, []);

  assert.equal(h.actions.canSplitPane(target.id), true);
  h.actions.splitPane(target.id, "bottom");
  await settled();
  assert.equal(getPanes(h.state().workspaces[0].root).length, 6);
  assert.equal(getPaneDepth(h.state().workspaces[0].root, cappedId), 4);
});

test("queued split requests recheck depth before resolving cwd or starting another PTY", async () => {
  const target = pane("queued", "/queued");
  const h = harness(layoutFixture(nestedLayout(3, target), target.id));
  h.controller.performAction("splitUp");
  h.controller.performAction("splitLeft");
  h.actions.splitPane(target.id, "right");
  await settled();
  assert.equal(getPaneDepth(h.state().workspaces[0].root, target.id), 4);
  assert.equal(h.sent.filter((item) => item.type === "start").length, 1);
  assert.equal(
    h.requests.filter((item) => item.kind === "resolveCwd").length,
    1,
  );
});

test("a tab drop at the depth limit is rejected before moving or replacing any terminal", async () => {
  const target = pane("drop-target", "/target");
  const initial = layoutFixture(nestedLayout(4, target), target.id);
  initial.workspaces.push({
    id: "two",
    name: "^2",
    root: pane("source", "/source"),
  });
  const h = harness(initial);
  const before = structuredClone(h.state());
  assert.equal(h.actions.canSplitTabIntoPane("source-1", target.id), false);
  h.actions.splitTabIntoPane("source-1", target.id, "left");
  await settled();
  assert.deepEqual(h.state(), before);
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.requests, []);
  assert.deepEqual(h.disposed, []);
});

test("moving a sole sibling tab can reuse the fourth split level without restarting its protected session", async () => {
  const target = pane("drop-reuse", "/target");
  const root = nestedLayout(4, target);
  const source = getPanes(root).find(
    (item) => item.id === "drop-reuse-sibling-0",
  )!;
  source.tabs.splice(1);
  source.tabs[0].backend = "tmux";
  source.tabs[0].backendSessionId = "owned-protected-session";
  const moved = structuredClone(source.tabs[0]);
  const beforeSessions = getTabs(root)
    .map((tab) => tab.sessionId)
    .sort();
  const h = harness(layoutFixture(root, target.id));
  assert.equal(h.actions.canSplitPane(target.id), false);
  assert.equal(h.actions.canSplitTabIntoPane(moved.id, target.id), true);
  h.actions.splitTabIntoPane(moved.id, target.id, "left");
  await settled();
  const afterRoot = h.state().workspaces[0].root;
  const fresh = getPanes(afterRoot).find((item) =>
    item.tabs.some((tab) => tab.id === moved.id),
  )!;
  assert.equal(getPaneDepth(afterRoot, target.id), 4);
  assert.equal(getPaneDepth(afterRoot, fresh.id), 4);
  assert.deepEqual(fresh.tabs, [moved]);
  assert.deepEqual(
    getTabs(afterRoot)
      .map((tab) => tab.sessionId)
      .sort(),
    beforeSessions,
  );
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.requests, []);
  assert.deepEqual(h.disposed, []);
});

test("dropping onto a full workspace cannot create a fifth split level or remove the source tab", async () => {
  const target = pane("full-target", "/full");
  target.tabs = Array.from({ length: 9 }, (_, index) => ({
    ...target.tabs[0],
    id: `full-${index}`,
    sessionId: `full-session-${index}`,
  }));
  target.activeTabId = target.tabs[0].id;
  const initial = layoutFixture(nestedLayout(4, target), target.id);
  initial.workspaces.push({
    id: "two",
    name: "^2",
    root: pane("source", "/source"),
  });
  const h = harness(initial);
  const before = structuredClone(h.state());
  h.actions.moveTabToWorkspace("source-1", "one");
  await settled();
  assert.deepEqual(h.state(), before);
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.disposed, []);
});

test("legacy layouts deeper than four remain intact while further splits are blocked", async () => {
  const target = pane("legacy", "/saved");
  const h = harness(layoutFixture(nestedLayout(6, target), target.id));
  const before = structuredClone(h.state());
  assert.equal(getPaneDepth(h.state().workspaces[0].root, target.id), 6);
  assert.equal(h.actions.canSplitPane(target.id), false);
  h.actions.splitPane(target.id, "bottom");
  await settled();
  assert.deepEqual(h.state(), before);
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.requests, []);
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

test("protection preserves the right-clicked tab identity and its pane without changing other tabs", async () => {
  const h = harness();
  const before = getPanes(h.state().workspaces[0].root)[0].tabs[1];
  h.protection(async () => ({
    cwd: "/frontend/nested",
    profile: "/bin/zsh",
    backend: "tmux",
    backendSessionId: "gaogrid-test",
    connectionState: "connected",
  }));
  h.actions.protectTab("a", "a-2");
  await settled();
  const panes = getPanes(h.state().workspaces[0].root);
  assert.equal(panes[0].tabs[1].id, before.id);
  assert.equal(panes[0].tabs[1].sessionId, before.sessionId);
  assert.equal(panes[0].tabs[1].title, before.title);
  assert.equal(panes[0].tabs[1].backend, "tmux");
  assert.equal(panes[0].tabs[1].cwd, "/frontend/nested");
  assert.equal(panes[1].tabs[0].backend, "direct");
  assert.deepEqual(h.disposed, []);
});

test("busy protection opens a protected tab in the source pane and inherits the source tab cwd", async () => {
  const h = harness();
  h.protection(async () => "openProtectedTab");
  h.actions.protectTab("a", "a-2");
  await settled();
  const panes = getPanes(h.state().workspaces[0].root);
  assert.equal(panes[0].tabs.length, 3);
  assert.equal(panes[1].tabs.length, 2);
  const tab = panes[0].tabs[2];
  assert.equal(tab.backend, "tmux");
  assert.equal(tab.cwd, "/frontend");
  assert.deepEqual(h.requests[1], {
    kind: "resolveCwd",
    sessionId: "a-s2",
    lastKnownCwd: "/frontend",
  });
  assert.equal(h.sent.at(-1).type, "start");
  assert.equal(h.sent.at(-1).backend, "tmux");
  assert.equal(panes[0].tabs[1].backend, "direct");
  assert.deepEqual(h.disposed, []);
});

test("cancelling protection preserves the layout, and disconnected protected tabs request reconnection", async () => {
  const h = harness();
  const before = structuredClone(h.state());
  h.actions.protectTab("a", "a-1");
  await settled();
  assert.deepEqual(h.state(), before);
  h.controller.updateTerminal("a-s1", {
    cwd: "/frontend",
    profile: "/bin/bash",
    backend: "tmux",
    backendSessionId: "gaogrid-test",
    connectionState: "disconnected",
  });
  h.actions.protectTab("a", "a-1");
  await settled();
  assert.equal(h.requests.at(-1)?.kind, "reconnect");
});

test("the backend creation API accepts tmux directly without first creating a direct PTY", async () => {
  const h = harness();
  h.controller.performAction("newTab", undefined, {
    backend: "tmux",
    cwd: "/explicit",
  });
  await settled();
  assert.equal(h.sent.at(-1).backend, "tmux");
  assert.equal(
    getPanes(h.state().workspaces[0].root)[1].tabs.at(-1)?.backend,
    "tmux",
  );
});

test("pane focus commands select the neighboring pane's active terminal and preserve sessions", () => {
  const initial = fixture();
  initial.workspaces[0].root = {
    type: "split",
    id: "navigation-columns",
    direction: "horizontal",
    ratio: 0.4,
    first: {
      type: "split",
      id: "navigation-left",
      direction: "vertical",
      ratio: 0.5,
      first: pane("nav-a", "/a"),
      second: pane("nav-b", "/b"),
    },
    second: {
      type: "split",
      id: "navigation-right",
      direction: "vertical",
      ratio: 0.5,
      first: pane("nav-c", "/c"),
      second: pane("nav-d", "/d"),
    },
  };
  initial.workspaces[0].focusedPaneId = "nav-a";
  for (const item of getPanes(initial.workspaces[0].root))
    item.activeTabId = `${item.id}-2`;
  const h = harness(initial);
  const before = structuredClone(h.state());
  for (const [action, paneId] of [
    ["focusPaneRight", "nav-c"],
    ["focusPaneDown", "nav-d"],
    ["focusPaneLeft", "nav-b"],
    ["focusPaneUp", "nav-a"],
  ]) {
    h.controller.performAction(action);
    assert.equal(h.state().workspaces[0].focusedPaneId, paneId);
    assert.equal(h.focused.at(-1), `${paneId}-2`);
    assert.deepEqual(h.state().workspaces[0].root, before.workspaces[0].root);
    assert.deepEqual(h.state().workspaces[1], before.workspaces[1]);
    assert.equal(h.state().activeWorkspaceId, "one");
  }
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.requests, []);
  assert.deepEqual(h.disposed, []);
  const count = h.focused.length;
  h.controller.performAction("focusPaneLeft");
  h.controller.performAction("focusPaneUp");
  assert.equal(
    h.focused.length,
    count,
    "outer edges do not wrap or send terminal input",
  );
  assert.deepEqual(h.state(), before);
});
