import { beginDrag, endDrag, readDrag, type DragPayload } from "./drag-session";

export type InsertAxis = "horizontal" | "vertical";

export interface InsertionPosition {
  index: number;
  offset: number;
}

interface DragTargetOptions {
  owner: HTMLElement;
  accepts: (drag: DragPayload) => boolean;
  ignore?: (event: DragEvent, drag: DragPayload) => boolean;
}

interface DropTargetOptions extends DragTargetOptions {
  onDrop: (drag: DragPayload) => void;
}

interface InsertionTargetOptions extends DragTargetOptions {
  container: HTMLElement;
  marker: HTMLElement;
  items: () => HTMLElement[];
  axis: InsertAxis;
  canDrop?: (drag: DragPayload) => boolean;
  onDrop: (drag: DragPayload, index: number) => void;
}

export function insertionAt(
  container: HTMLElement,
  items: HTMLElement[],
  axis: InsertAxis,
  clientX: number,
  clientY: number,
): InsertionPosition {
  const horizontal = axis === "horizontal";
  const bounds = container.getBoundingClientRect();
  const origin = horizontal ? bounds.left : bounds.top;
  const farEdge = horizontal ? bounds.right : bounds.bottom;
  const scroll = horizontal ? container.scrollLeft : container.scrollTop;
  const pointer = horizontal ? clientX : clientY;
  const rects = items.map((item) => item.getBoundingClientRect());
  let index = items.length;
  let boundary = rects.length
    ? horizontal
      ? rects[rects.length - 1].right
      : rects[rects.length - 1].bottom
    : origin;
  for (let i = 0; i < rects.length; i++) {
    const start = horizontal ? rects[i].left : rects[i].top;
    const end = horizontal ? rects[i].right : rects[i].bottom;
    if (pointer < (start + end) / 2) {
      index = i;
      boundary =
        i === 0
          ? (origin + start) / 2
          : ((horizontal ? rects[i - 1].right : rects[i - 1].bottom) + start) /
            2;
      break;
    }
  }
  if (index === rects.length && rects.length) {
    const lastEnd = horizontal
      ? rects[rects.length - 1].right
      : rects[rects.length - 1].bottom;
    boundary = (lastEnd + farEdge) / 2;
  }
  return { index, offset: boundary - origin + scroll };
}

function showInsertionMarker(
  container: HTMLElement,
  marker: HTMLElement,
  items: HTMLElement[],
  axis: InsertAxis,
  clientX: number,
  clientY: number,
) {
  const position = insertionAt(container, items, axis, clientX, clientY);
  container.dataset.insertionIndex = String(position.index);
  marker.dataset.axis = axis;
  if (position.index === 0) marker.dataset.edge = "start";
  else delete marker.dataset.edge;
  if (axis === "horizontal") marker.style.left = `${position.offset}px`;
  else marker.style.top = `${position.offset}px`;
  marker.hidden = false;
  return position.index;
}

function clearInsertionMarker(container: HTMLElement, marker: HTMLElement) {
  delete container.dataset.insertionIndex;
  delete marker.dataset.edge;
  marker.hidden = true;
}

export function startInternalDrag(
  dataTransfer: DataTransfer | null,
  payload: DragPayload,
) {
  clearAllDragIndicators();
  beginDrag(dataTransfer, payload);
}

export function clearAllDragIndicators() {
  if (typeof document === "undefined") return;
  document
    .querySelectorAll<HTMLElement>(".drag-insertion-marker")
    .forEach((marker) => {
      delete marker.dataset.edge;
      marker.hidden = true;
    });
  document
    .querySelectorAll<HTMLElement>("[data-insertion-index]")
    .forEach((element) => {
      delete element.dataset.insertionIndex;
    });
  document
    .querySelectorAll<HTMLElement>(
      "[data-drop-target], [data-drop-side], [data-drop-preview]",
    )
    .forEach((element) => {
      delete element.dataset.dropTarget;
      delete element.dataset.dropSide;
      delete element.dataset.dropPreview;
    });
}

export function finishDrag() {
  clearAllDragIndicators();
  endDrag();
}

function dragIsIgnored(
  event: DragEvent,
  drag: DragPayload,
  options: DragTargetOptions,
) {
  return !!options.ignore?.(event, drag);
}

function listen(
  owner: HTMLElement,
  type: keyof HTMLElementEventMap,
  listener: (event: DragEvent) => void,
  signal: AbortSignal,
) {
  owner.addEventListener(type, listener as EventListener, {
    capture: true,
    signal,
  });
}

export function installDropTarget(options: DropTargetOptions) {
  const controller = new AbortController();
  const over = (event: DragEvent) => {
    const drag = readDrag(event.dataTransfer);
    if (!drag || !options.accepts(drag) || dragIsIgnored(event, drag, options))
      return;
    event.preventDefault();
    event.stopPropagation();
    options.owner.dataset.dropTarget = "true";
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  };
  listen(options.owner, "dragenter", over, controller.signal);
  listen(options.owner, "dragover", over, controller.signal);
  listen(
    options.owner,
    "dragleave",
    (event) => {
      if (
        event.relatedTarget instanceof Node &&
        options.owner.contains(event.relatedTarget)
      )
        return;
      delete options.owner.dataset.dropTarget;
    },
    controller.signal,
  );
  listen(
    options.owner,
    "drop",
    (event) => {
      const drag = readDrag(event.dataTransfer);
      if (
        !drag ||
        !options.accepts(drag) ||
        dragIsIgnored(event, drag, options)
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      delete options.owner.dataset.dropTarget;
      options.onDrop(drag);
      finishDrag();
    },
    controller.signal,
  );
  return () => controller.abort();
}

export function installInsertionTarget(options: InsertionTargetOptions) {
  const controller = new AbortController();
  const update = (event: DragEvent) => {
    const drag = readDrag(event.dataTransfer);
    if (
      !drag ||
      !options.accepts(drag) ||
      dragIsIgnored(event, drag, options)
    ) {
      clearInsertionMarker(options.container, options.marker);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (options.canDrop && !options.canDrop(drag)) {
      clearInsertionMarker(options.container, options.marker);
      if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
      return;
    }
    showInsertionMarker(
      options.container,
      options.marker,
      options.items(),
      options.axis,
      event.clientX,
      event.clientY,
    );
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  };
  listen(options.owner, "dragenter", update, controller.signal);
  listen(options.owner, "dragover", update, controller.signal);
  listen(
    options.owner,
    "dragleave",
    (event) => {
      if (
        event.relatedTarget instanceof Node &&
        options.owner.contains(event.relatedTarget)
      )
        return;
      clearInsertionMarker(options.container, options.marker);
    },
    controller.signal,
  );
  listen(
    options.owner,
    "drop",
    (event) => {
      const drag = readDrag(event.dataTransfer);
      if (
        !drag ||
        !options.accepts(drag) ||
        dragIsIgnored(event, drag, options) ||
        (options.canDrop && !options.canDrop(drag))
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      const index = showInsertionMarker(
        options.container,
        options.marker,
        options.items(),
        options.axis,
        event.clientX,
        event.clientY,
      );
      clearInsertionMarker(options.container, options.marker);
      options.onDrop(drag, index);
      finishDrag();
    },
    controller.signal,
  );
  return () => controller.abort();
}

if (typeof document !== "undefined") {
  document.addEventListener("dragend", finishDrag);
}
