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
