export const OUTPUT_HIGH_WATERMARK = 256 * 1024;
export const OUTPUT_LOW_WATERMARK = 64 * 1024;

/** Count xterm string units until both history and the attached view consume them. */
export class TerminalOutputFlow {
  private historyPending = 0;
  private viewPending = 0;
  private paused = false;
  private disposed = false;
  private holds = 0;

  constructor(
    private readonly pause: () => void,
    private readonly resume: () => void,
  ) {}

  queued(length: number) {
    this.historyPending += length;
    this.update();
  }

  parsed(length: number) {
    this.historyPending = Math.max(0, this.historyPending - length);
    this.update();
  }

  setViewPending(length: number) {
    this.viewPending = length;
    this.update();
  }

  /** Stop new PTY reads while a backend promotion replaces parsed history. */
  hold() {
    this.holds++;
    this.update();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holds--;
      this.update();
    };
  }

  private update() {
    if (this.disposed) return;
    const pending = this.historyPending + this.viewPending;
    if (!this.paused && (this.holds > 0 || pending >= OUTPUT_HIGH_WATERMARK)) {
      this.paused = true;
      this.pause();
    } else if (this.paused && !this.holds && pending <= OUTPUT_LOW_WATERMARK) {
      this.paused = false;
      this.resume();
    }
  }

  dispose() {
    this.disposed = true;
    if (this.paused) {
      this.paused = false;
      this.resume();
    }
  }
}
