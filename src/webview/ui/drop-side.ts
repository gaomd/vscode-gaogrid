import type { DropSide } from "./types";

/** Pick the closest side, covering the whole surface with four zones. */
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
