import { test } from "node:test";
import assert from "node:assert/strict";
import {
  beginDrag,
  DRAG_MIME,
  endDrag,
  readDrag,
} from "../src/webview/ui/drag-session";
import {
  insertionAt,
  installInsertionTarget,
} from "../src/webview/ui/drag-target";

test("insertions use the leading, inner, and trailing gutters", () => {
  const rect = (left: number, right: number) =>
    ({
      left,
      right,
      top: 0,
      bottom: 20,
    }) as DOMRect;
  const container = {
    getBoundingClientRect: () => rect(0, 88),
    scrollLeft: 0,
    scrollTop: 0,
  } as unknown as HTMLElement;
  const items = [
    { getBoundingClientRect: () => rect(0, 40) },
    {
      getBoundingClientRect: () => rect(44, 84),
    },
  ] as unknown as HTMLElement[];

  assert.deepEqual(insertionAt(container, items, "horizontal", 3, 0), {
    index: 0,
    offset: 0,
  });
  assert.deepEqual(insertionAt(container, items, "horizontal", 42, 0), {
    index: 1,
    offset: 42,
  });
  assert.deepEqual(insertionAt(container, items, "horizontal", 100, 0), {
    index: 2,
    offset: 86,
  });
});

test("an insertion target handles the full owner and reports the trailing index", () => {
  const listeners = new Map<string, EventListener>();
  const owner = {
    dataset: {},
    addEventListener(type: string, listener: EventListener) {
      listeners.set(type, listener);
    },
  } as unknown as HTMLElement;
  const container = {
    dataset: {},
    getBoundingClientRect: () =>
      ({ left: 0, right: 88, top: 0, bottom: 20 }) as DOMRect,
    scrollLeft: 0,
    scrollTop: 0,
  } as unknown as HTMLElement;
  const marker = {
    dataset: {},
    style: {},
    hidden: true,
  } as unknown as HTMLElement;
  const items = [
    {
      getBoundingClientRect: () =>
        ({ left: 0, right: 40, top: 0, bottom: 20 }) as DOMRect,
    },
    {
      getBoundingClientRect: () =>
        ({ left: 44, right: 84, top: 0, bottom: 20 }) as DOMRect,
    },
  ] as unknown as HTMLElement[];
  const dataTransfer = {
    types: [DRAG_MIME.tab],
    getData: () => "",
    setData() {},
    effectAllowed: "uninitialized",
  } as unknown as DataTransfer;
  const dropped: [string, number][] = [];
  let dragDuringDrop: ReturnType<typeof readDrag>;

  beginDrag(dataTransfer, { kind: "tab", id: "source" });
  installInsertionTarget({
    owner,
    container,
    marker,
    items: () => items,
    axis: "horizontal",
    accepts: (drag) => drag.kind === "tab",
    onDrop: (drag, index) => {
      dragDuringDrop = readDrag(dataTransfer);
      dropped.push([drag.id, index]);
    },
  });
  let prevented = false;
  const event = {
    dataTransfer,
    clientX: 100,
    clientY: 10,
    preventDefault() {
      prevented = true;
    },
    stopPropagation() {},
  } as unknown as DragEvent;

  listeners.get("dragover")!({
    ...event,
    clientX: 1,
  } as DragEvent);
  assert.equal(marker.dataset.edge, "start");

  listeners.get("dragover")!(event);
  assert.equal(prevented, true);
  assert.equal(marker.hidden, false);
  assert.equal(marker.dataset.edge, undefined);
  assert.equal(container.dataset.insertionIndex, "2");

  listeners.get("drop")!(event);
  assert.deepEqual(dragDuringDrop, { kind: "tab", id: "source" });
  assert.deepEqual(dropped, [["source", 2]]);
  assert.equal(readDrag(dataTransfer), undefined);
  endDrag();
});
