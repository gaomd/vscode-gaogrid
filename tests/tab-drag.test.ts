import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clearAllDragIndicators,
  readDraggedTab,
  TAB_DRAG_TYPE,
  writeDraggedTab,
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
