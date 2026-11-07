import { test } from "node:test";
import assert from "node:assert/strict";
import {
  beginDrag,
  DRAG_MIME,
  endDrag,
  readDrag,
} from "../src/webview/ui/drag-session";

function transfer(types: string[], payloads: Record<string, string> = {}) {
  const written: Record<string, string> = {};
  return {
    data: types,
    types,
    setData(type: string, value: string) {
      written[type] = value;
    },
    getData(type: string) {
      return written[type] || payloads[type] || "";
    },
    effectAllowed: "uninitialized",
  } as unknown as DataTransfer;
}

test("internal drags retain their kind and ID while payload data is hidden", () => {
  const drag = transfer([DRAG_MIME.tab], { [DRAG_MIME.tab]: "" });
  beginDrag(drag, { kind: "tab", id: "source-tab" });

  assert.deepEqual(readDrag(drag), { kind: "tab", id: "source-tab" });
  assert.equal(drag.effectAllowed, "move");

  endDrag();
  assert.equal(readDrag(drag), undefined);
});

test("workspace drags use the same fallback and remain distinct from files", () => {
  const drag = transfer([], {
    [DRAG_MIME.workspace]: "source-workspace",
  });
  beginDrag(drag, { kind: "workspace", id: "original-workspace" });

  assert.deepEqual(readDrag(drag), {
    kind: "workspace",
    id: "original-workspace",
  });
  assert.equal(readDrag(transfer(["Files"])), undefined);

  endDrag();
  assert.equal(readDrag(drag), undefined);
});

test("tmux transfer drags use the transfer payload", () => {
  const drag = transfer([], {
    [DRAG_MIME.transfer]: "gaogrid-transfer",
  });
  beginDrag(drag, { kind: "transfer", id: "fallback-transfer" });

  assert.deepEqual(readDrag(drag), {
    kind: "transfer",
    id: "fallback-transfer",
  });
  endDrag();
});
