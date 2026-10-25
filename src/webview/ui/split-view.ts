import type { SplitNode } from "../../model";
import { reconcileChildren } from "./controls";
import type { WorkspaceActions } from "./types";

const MIN_RATIO = 0.12;
const MAX_RATIO = 0.88;
const HOVER_DELAY_MS = 200;

/** Grid ratios use the structural gutter, shared by the sash and pane spacing. */
export class SplitView {
  readonly element = document.createElement("div");
  private readonly sash = document.createElement("div");
  private node: SplitNode;
  private hoverTimer?: number;

  constructor(
    node: SplitNode,
    private readonly actions: WorkspaceActions,
  ) {
    this.node = node;
    this.element.className = "split-view";
    this.sash.className = "split-view__sash";
    this.sash.tabIndex = 0;
    this.sash.setAttribute("role", "separator");
    this.sash.setAttribute("aria-label", "Resize panes");
    this.sash.setAttribute("aria-valuemin", "12");
    this.sash.setAttribute("aria-valuemax", "88");
    this.sash.addEventListener("keydown", (event) => {
      const horizontal = this.node.direction === "horizontal";
      const delta =
        event.key === (horizontal ? "ArrowLeft" : "ArrowUp")
          ? -0.02
          : event.key === (horizontal ? "ArrowRight" : "ArrowDown")
            ? 0.02
            : 0;
      if (!delta) return;
      event.preventDefault();
      this.setRatio(this.node.ratio + delta, true);
    });
    this.sash.addEventListener("pointerdown", (event) => this.startDrag(event));
    this.sash.addEventListener("pointerenter", (event) => {
      if (event.pointerType === "touch") return;
      this.clearHover();
      this.hoverTimer = window.setTimeout(() => {
        this.hoverTimer = undefined;
        if (this.sash.isConnected && this.sash.matches(":hover"))
          this.sash.dataset.hovered = "true";
      }, HOVER_DELAY_MS);
    });
    this.sash.addEventListener("pointerleave", () => this.clearHover());
  }

  update(node: SplitNode, first: HTMLElement, second: HTMLElement) {
    this.node = node;
    this.element.dataset.axis =
      node.direction === "horizontal" ? "columns" : "rows";
    this.sash.setAttribute(
      "aria-orientation",
      node.direction === "horizontal" ? "vertical" : "horizontal",
    );
    reconcileChildren(this.element, [first, this.sash, second]);
    this.applyRatio();
  }

  dispose() {
    this.clearHover();
    this.element.remove();
  }

  private clearHover() {
    window.clearTimeout(this.hoverTimer);
    this.hoverTimer = undefined;
    delete this.sash.dataset.hovered;
  }

  private applyRatio() {
    this.element.style.setProperty("--split-first", `${this.node.ratio}fr`);
    this.element.style.setProperty(
      "--split-second",
      `${1 - this.node.ratio}fr`,
    );
    this.sash.setAttribute(
      "aria-valuenow",
      String(Math.round(this.node.ratio * 100)),
    );
  }

  private setRatio(ratio: number, complete: boolean) {
    this.node.ratio = Math.max(MIN_RATIO, Math.min(MAX_RATIO, ratio));
    this.applyRatio();
    this.actions.resizeSplit(this.node.id, this.node.ratio, complete);
  }

  private startDrag(event: PointerEvent) {
    if (event.button !== 0) return;
    event.preventDefault();
    this.clearHover();
    this.sash.setPointerCapture(event.pointerId);
    this.sash.dataset.dragging = "true";
    const bounds = this.element.getBoundingClientRect();
    const horizontal = this.node.direction === "horizontal";
    const sashBounds = this.sash.getBoundingClientRect();
    const gutter = horizontal ? sashBounds.width : sashBounds.height;
    const move = (pointer: PointerEvent) => {
      const distance = horizontal
        ? pointer.clientX - bounds.left
        : pointer.clientY - bounds.top;
      const available = (horizontal ? bounds.width : bounds.height) - gutter;
      this.setRatio((distance - gutter / 2) / Math.max(1, available), false);
    };
    const finish = () => {
      this.sash.removeEventListener("pointermove", move);
      this.sash.removeEventListener("pointerup", finish);
      this.sash.removeEventListener("pointercancel", finish);
      this.sash.removeEventListener("lostpointercapture", finish);
      delete this.sash.dataset.dragging;
      if (this.sash.matches(":hover")) this.sash.dataset.hovered = "true";
      else this.clearHover();
      this.setRatio(this.node.ratio, true);
    };
    this.sash.addEventListener("pointermove", move);
    this.sash.addEventListener("pointerup", finish);
    this.sash.addEventListener("pointercancel", finish);
    this.sash.addEventListener("lostpointercapture", finish);
  }
}
