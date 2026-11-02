import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clearAllDragIndicators,
  readDraggedTab,
  readDraggedTransfer,
  TAB_DRAG_TYPE,
  TRANSFER_DRAG_TYPE,
  writeDraggedTab,
  writeDraggedTransfer,
} from "../src/webview/ui/tab-drag";

test("internal tab drags remain identifiable during protected dragover and reset after cleanup", () => {
  const previousDocument = Object.getOwnPropertyDescriptor(
    globalThis,
    "document",
  );
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { querySelectorAll: () => [] },
  });
  let payload = "";
  const transfer = {
    types: [TAB_DRAG_TYPE],
    setData(_type: string, value: string) {
      payload = value;
    },
    getData() {
      return "";
    },
  } as unknown as DataTransfer;
  try {
    writeDraggedTab(transfer, "source-tab");
    assert.equal(payload, "source-tab");
    assert.equal(readDraggedTab(transfer), "source-tab");
    assert.equal(
      readDraggedTab({ types: ["Files"] } as unknown as DataTransfer),
      undefined,
    );
    clearAllDragIndicators();
    assert.equal(readDraggedTab(transfer), undefined);
  } finally {
    clearAllDragIndicators();
    if (previousDocument)
      Object.defineProperty(globalThis, "document", previousDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

test("tmux transfer drags use a distinct payload and reset independently", () => {
  const previousDocument = Object.getOwnPropertyDescriptor(
    globalThis,
    "document",
  );
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { querySelectorAll: () => [] },
  });
  let payload = "";
  const transfer = {
    types: [TRANSFER_DRAG_TYPE],
    setData(_type: string, value: string) {
      payload = value;
    },
    getData() {
      return "";
    },
  } as unknown as DataTransfer;
  try {
    writeDraggedTransfer(transfer, "gaogrid-transfer");
    assert.equal(payload, "gaogrid-transfer");
    assert.equal(readDraggedTransfer(transfer), "gaogrid-transfer");
    assert.equal(readDraggedTab(transfer), undefined);
    clearAllDragIndicators();
    assert.equal(readDraggedTransfer(transfer), undefined);
  } finally {
    clearAllDragIndicators();
    if (previousDocument)
      Object.defineProperty(globalThis, "document", previousDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
});
