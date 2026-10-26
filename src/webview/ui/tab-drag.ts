import type { DropSide } from "./types";

export const TAB_DRAG_TYPE = "application/x-gaogrid-tab";
export const WORKSPACE_DRAG_TYPE = "application/x-gaogrid-workspace";
let draggedTabId: string | undefined;

export function writeDraggedTab(
  dataTransfer: DataTransfer | null,
  tabId: string,
) {
  if (!dataTransfer) return;
  draggedTabId = tabId;
  dataTransfer.setData(TAB_DRAG_TYPE, tabId);
}

export type InsertAxis = "horizontal" | "vertical";

export function isTabDrag(dataTransfer: DataTransfer | null) {
  return !!dataTransfer && [...dataTransfer.types].includes(TAB_DRAG_TYPE);
}

export function readDraggedTab(dataTransfer: DataTransfer | null) {
  if (!isTabDrag(dataTransfer)) return undefined;
  // Browsers hide the payload during dragover. Keep this webview's source ID
  // available so previews can validate a move before allowing the drop.
  return dataTransfer!.getData(TAB_DRAG_TYPE) || draggedTabId;
}

export function isWorkspaceDrag(dataTransfer: DataTransfer | null) {
  return (
    !!dataTransfer && [...dataTransfer.types].includes(WORKSPACE_DRAG_TYPE)
  );
}

export function readDraggedWorkspace(dataTransfer: DataTransfer | null) {
  if (!isWorkspaceDrag(dataTransfer)) return undefined;
  return dataTransfer!.getData(WORKSPACE_DRAG_TYPE) || undefined;
}

export function insertionAt(
  container: HTMLElement,
  items: HTMLElement[],
  axis: InsertAxis,
  clientX: number,
  clientY: number,
) {
  const horizontal = axis === "horizontal";
  const origin = horizontal
    ? container.getBoundingClientRect().left
    : container.getBoundingClientRect().top;
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
          ? start
          : ((horizontal ? rects[i - 1].right : rects[i - 1].bottom) + start) /
            2;
      break;
    }
  }
  return { index, offset: boundary - origin + scroll };
}

export function showInsertionMarker(
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
  if (axis === "horizontal") marker.style.left = `${position.offset}px`;
  else marker.style.top = `${position.offset}px`;
  marker.hidden = false;
  return position.index;
}

export function clearInsertionMarker(
  container: HTMLElement,
  marker: HTMLElement,
) {
  delete container.dataset.insertionIndex;
  marker.hidden = true;
}

export function clearAllInsertionMarkers() {
  document
    .querySelectorAll<HTMLElement>(".drag-insertion-marker")
    .forEach((marker) => {
      marker.hidden = true;
      delete marker.parentElement?.dataset.insertionIndex;
    });
}

export function clearAllDragIndicators() {
  draggedTabId = undefined;
  clearAllInsertionMarkers();
  document
    .querySelectorAll<HTMLElement>(
      "[data-drop-new], [data-drop-target], [data-drop-side], [data-drop-preview]",
    )
    .forEach((element) => {
      delete element.dataset.dropNew;
      delete element.dataset.dropTarget;
      delete element.dataset.dropSide;
      delete element.dataset.dropPreview;
    });
}

if (typeof document !== "undefined") {
  document.addEventListener("dragend", clearAllDragIndicators);
  document.addEventListener(
    "drop",
    () => queueMicrotask(clearAllDragIndicators),
    true,
  );
}

/** Pick the closest side, covering the whole terminal surface with four zones. */
export function dropSideAt(
  bounds: Pick<DOMRect, "left" | "right" | "top" | "bottom">,
  x: number,
  y: number,
): DropSide {
  const distances: [DropSide, number][] = [
    ["left", Math.max(0, x - bounds.left)],
    ["right", Math.max(0, bounds.right - x)],
    ["top", Math.max(0, y - bounds.top)],
    ["bottom", Math.max(0, bounds.bottom - y)],
  ];
  return distances.reduce((closest, current) =>
    current[1] < closest[1] ? current : closest,
  )[0];
}
