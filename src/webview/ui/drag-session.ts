export const DRAG_MIME = {
  tab: "application/x-gaogrid-tab",
  transfer: "application/x-gaogrid-transfer",
  workspace: "application/x-gaogrid-workspace",
} as const;

export type DragKind = keyof typeof DRAG_MIME;

export interface DragPayload {
  kind: DragKind;
  id: string;
}

let activeDrag: DragPayload | undefined;

export function beginDrag(
  dataTransfer: DataTransfer | null,
  payload: DragPayload,
) {
  activeDrag = payload;
  if (!dataTransfer) return;
  dataTransfer.effectAllowed = "move";
  dataTransfer.setData(DRAG_MIME[payload.kind], payload.id);
}

export function readDrag(
  dataTransfer: DataTransfer | null,
): DragPayload | undefined {
  if (!activeDrag) return undefined;
  if (!dataTransfer) return activeDrag;
  const active = activeDrag;
  const types = [...dataTransfer.types].map((type) => type.toLowerCase());
  if (types.includes("files")) return undefined;
  const expected = DRAG_MIME[active.kind];
  const mismatched = (Object.keys(DRAG_MIME) as DragKind[]).some(
    (kind) => kind !== active.kind && types.includes(DRAG_MIME[kind]),
  );
  if (mismatched) return undefined;
  return {
    kind: active.kind,
    id: dataTransfer.getData(expected) || active.id,
  };
}

export function endDrag() {
  activeDrag = undefined;
}
