import { test } from "node:test";
import assert from "node:assert/strict";
import { installTerminalDrop } from "../src/webview/terminal-drop";

function harness() {
  const host = new EventTarget();
  const drops: { resources: unknown[]; names: string[] }[] = [];
  const dispose = installTerminalDrop(
    host as unknown as HTMLElement,
    (resources, names) => drops.push({ resources, names }),
  );
  return {
    drops,
    dispose,
    dispatch(
      type: string,
      payloads: Record<string, string>,
      files: { name: string; path?: string }[] = [],
      items: unknown[] = [],
    ) {
      const event = new Event(type, { cancelable: true, bubbles: true });
      let stopped = false;
      event.stopPropagation = () => {
        stopped = true;
      };
      const transfer = {
        types: Object.keys(payloads),
        files,
        items,
        getData: (type: string) => payloads[type] || "",
        dropEffect: "none",
      };
      Object.defineProperty(event, "dataTransfer", { value: transfer });
      host.dispatchEvent(event);
      return { event, transfer, stopped };
    },
  };
}

test("file drags are consumed and disposing the terminal removes its drop handlers", () => {
  const h = harness();
  for (const type of ["dragenter", "dragover", "drop"]) {
    const { event, transfer, stopped } = h.dispatch(type, { Files: "" }, [
      { name: "file.txt" },
    ]);
    assert.equal(event.defaultPrevented, true);
    assert.equal(stopped, true);
    assert.equal(transfer.dropEffect, "copy");
  }
  assert.deepEqual(h.drops, [{ resources: [], names: ["file.txt"] }]);
  h.dispose();
  assert.equal(h.dispatch("drop", { Files: "" }).event.defaultPrevented, false);
  assert.equal(h.drops.length, 1);
});

test("Explorer's full internal URI list precedes the truncated public list", () => {
  const h = harness();
  h.dispatch("drop", {
    "text/uri-list": "file:///tmp/folder/",
    "application/vnd.code.uri-list":
      "# Explorer selection\r\nfile:///tmp/folder/\r\nfile:///tmp/a%20file.txt\r\n",
    CodeFiles: JSON.stringify(["/tmp/folder", "/tmp/a file.txt"]),
    ResourceURLs: "invalid JSON",
    CodeEditors: JSON.stringify([
      { resource: { scheme: "file", path: "/tmp/a file.txt" } },
    ]),
  });
  assert.deepEqual(h.drops, [
    {
      resources: ["file:///tmp/folder/", "file:///tmp/a%20file.txt"],
      names: [],
    },
  ]);
});

test("ResourceURLs retains the full selection ahead of editor-only drag data", () => {
  const h = harness();
  const resources = ["file:///tmp/folder/", "file:///tmp/a%20file.txt"];
  h.dispatch("drop", {
    ResourceURLs: JSON.stringify(resources),
    "application/vnd.code.uri-list": "file:///tmp/a%20file.txt",
    CodeEditors: JSON.stringify([
      { resource: { scheme: "file", path: "/tmp/a file.txt" } },
    ]),
  });
  assert.deepEqual(h.drops, [{ resources, names: [] }]);
});

test("CodeFiles retains the full file selection when URI-list formats are unavailable", () => {
  const h = harness();
  const resources = ["/tmp/folder", "/tmp/a file.txt"];
  h.dispatch("drop", {
    ResourceURLs: "[]",
    "application/vnd.code.uri-list": "",
    CodeFiles: JSON.stringify(resources),
    CodeEditors: JSON.stringify([
      { resource: { scheme: "file", path: "/tmp/a file.txt" } },
    ]),
  });
  assert.deepEqual(h.drops, [{ resources, names: [] }]);
});

test("empty or unavailable preferred formats fall back to other resource formats", () => {
  const h = harness();
  h.dispatch("drop", {
    "application/vnd.code.uri-list": "",
    CodeFiles: "invalid JSON",
    ResourceURLs: "[]",
    CodeEditors: JSON.stringify([
      { resource: { scheme: "file", path: "/tmp/a file.txt" } },
    ]),
  });
  assert.deepEqual(h.drops, [
    {
      resources: [{ resource: { scheme: "file", path: "/tmp/a file.txt" } }],
      names: [],
    },
  ]);
});

test("native file paths and directory-only drag items are forwarded without reading contents", () => {
  const h = harness();
  h.dispatch("drop", { Files: "" }, [
    { name: "a file.txt", path: "/tmp/a file.txt" },
  ]);
  h.dispatch(
    "drop",
    { Files: "" },
    [],
    [
      {
        kind: "file",
        webkitGetAsEntry: () => ({ name: "folder", isDirectory: true }),
        getAsFile: () => assert.fail("Directory entries need no file access"),
      },
    ],
  );
  h.dispatch(
    "drop",
    { Files: "" },
    [{ name: "file.txt" }],
    [
      {
        kind: "file",
        getAsFile: () => ({ name: "file.txt" }),
      },
      {
        kind: "file",
        webkitGetAsEntry: () => ({ name: "folder", isDirectory: true }),
      },
    ],
  );
  assert.deepEqual(h.drops, [
    { resources: ["/tmp/a file.txt"], names: ["a file.txt"] },
    { resources: [], names: ["folder"] },
    { resources: [], names: ["file.txt", "folder"] },
  ]);
});

test("plain text and GaoGrid tab reorders are not file drops", () => {
  const h = harness();
  for (const payload of [
    { "text/plain": "a command" },
    { "application/x-gaogrid-tab": "tab-id", "text/plain": "terminal" },
    { "application/x-gaogrid-workspace": "workspace-id", "text/plain": "^1" },
  ]) {
    for (const type of ["dragenter", "dragover", "drop"]) {
      const { event, stopped, transfer } = h.dispatch(type, payload);
      assert.equal(event.defaultPrevented, false);
      assert.equal(stopped, false);
      assert.equal(transfer.dropEffect, "none");
    }
  }
  assert.deepEqual(h.drops, []);
});

test("file drags may use plain-text paths only after a file format identifies the drag", () => {
  const h = harness();
  h.dispatch("drop", { Files: "", "text/plain": "/tmp/a file.txt" }, [
    { name: "a file.txt" },
  ]);
  assert.deepEqual(h.drops, [
    { resources: ["/tmp/a file.txt"], names: ["a file.txt"] },
  ]);
});
