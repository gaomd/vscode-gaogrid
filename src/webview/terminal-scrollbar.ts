import type { IDisposable, Terminal } from "@xterm/xterm";

/** A native draggable scrollbar over the grid, synchronized through xterm's API. */
export class TerminalScrollbar {
  private readonly element = document.createElement("div");
  private readonly content = document.createElement("div");
  private readonly listeners = new AbortController();
  private readonly subscriptions: IDisposable[];
  private activityTimer?: number;
  private lastViewport = -1;

  constructor(
    private readonly terminal: Terminal,
    host: HTMLElement,
  ) {
    this.element.className = "terminal-scrollbar";
    this.element.tabIndex = 0;
    this.element.setAttribute("role", "scrollbar");
    this.element.setAttribute("aria-label", "Terminal scrollback");
    this.element.setAttribute("aria-orientation", "vertical");
    this.element.setAttribute("aria-controls", host.id);
    this.element.append(this.content);
    const options = { signal: this.listeners.signal };
    this.element.addEventListener(
      "scroll",
      () => {
        const range = this.element.scrollHeight - this.element.clientHeight;
        if (range <= 0) return;
        const line = Math.round(
          (this.element.scrollTop / range) * terminal.buffer.active.baseY,
        );
        if (line !== terminal.buffer.active.viewportY)
          terminal.scrollToLine(line);
      },
      options,
    );
    this.element.addEventListener(
      "pointerdown",
      () => {
        this.element.dataset.dragging = "true";
      },
      options,
    );
    const endDrag = () => {
      delete this.element.dataset.dragging;
    };
    window.addEventListener("pointerup", endDrag, options);
    window.addEventListener("pointercancel", endDrag, options);
    window.addEventListener("blur", endDrag, options);
    this.subscriptions = [
      terminal.onScroll(() => this.sync()),
      terminal.onWriteParsed(() => this.sync()),
      terminal.onResize(() => this.sync()),
      terminal.buffer.onBufferChange(() => this.sync()),
    ];
    this.mount(host);
  }

  mount(host: HTMLElement) {
    host.append(this.element);
    this.sync();
  }

  sync() {
    const { buffer, rows } = this.terminal;
    const { baseY, viewportY, type } = buffer.active;
    this.element.hidden = type === "alternate" || baseY === 0;
    if (this.element.hidden || !this.element.clientHeight) return;
    this.content.style.height = `${(this.element.clientHeight * (baseY + rows)) / rows}px`;
    const range = this.element.scrollHeight - this.element.clientHeight;
    this.element.scrollTop = (viewportY / baseY) * range;
    this.element.setAttribute("aria-valuemin", "0");
    this.element.setAttribute("aria-valuemax", String(baseY));
    this.element.setAttribute("aria-valuenow", String(viewportY));
    if (viewportY !== this.lastViewport) {
      this.lastViewport = viewportY;
      this.element.dataset.scrolling = "true";
      window.clearTimeout(this.activityTimer);
      this.activityTimer = window.setTimeout(() => {
        delete this.element.dataset.scrolling;
      }, 700);
    }
  }

  dispose() {
    window.clearTimeout(this.activityTimer);
    this.listeners.abort();
    this.subscriptions.forEach((subscription) => subscription.dispose());
    this.element.remove();
  }
}
