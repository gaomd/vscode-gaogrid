import {
  GLOBAL_OUTPUT_HIGH_WATERMARK,
  GLOBAL_OUTPUT_LOW_WATERMARK,
  OUTPUT_HIGH_WATERMARK,
  OUTPUT_LOW_WATERMARK,
} from "./terminal-constants";

export {
  GLOBAL_OUTPUT_HIGH_WATERMARK,
  GLOBAL_OUTPUT_LOW_WATERMARK,
  OUTPUT_HIGH_WATERMARK,
  OUTPUT_LOW_WATERMARK,
};

interface FlowLimits {
  high: number;
  low: number;
}

/** Shared pressure keeps one burst from exhausting the extension-host heap. */
export class TerminalOutputBudget {
  private readonly pending = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private foregroundId?: string;

  setPending(id: string, length: number) {
    this.pending.set(id, Math.max(0, length));
  }

  remove(id: string) {
    this.pending.delete(id);
    if (this.foregroundId === id) this.foregroundId = undefined;
  }

  setForeground(id?: string) {
    this.foregroundId = id;
    for (const listener of this.listeners) listener();
  }

  listen(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  pressure(): "none" | "high" | "low" {
    const total = [...this.pending.values()].reduce(
      (value, pending) => value + pending,
      0,
    );
    if (total >= GLOBAL_OUTPUT_HIGH_WATERMARK) return "high";
    if (total > GLOBAL_OUTPUT_LOW_WATERMARK) return "low";
    return "none";
  }

  shouldPause(id: string) {
    return this.pressure() === "high" && this.foregroundId !== id;
  }

  canResume(id: string) {
    return (
      this.pressure() === "none" ||
      this.pressure() === "low" ||
      this.foregroundId === id
    );
  }
}

/** Count xterm string units until both history and the attached view consume them. */
export class TerminalOutputFlow {
  private historyPending = 0;
  private viewPending = 0;
  private paused = false;
  private disposed = false;
  private holds = 0;

  constructor(
    private readonly id: string,
    private readonly pause: () => void,
    private readonly resume: () => void,
    private readonly budget?: TerminalOutputBudget,
    private readonly limits: FlowLimits = {
      high: OUTPUT_HIGH_WATERMARK,
      low: OUTPUT_LOW_WATERMARK,
    },
  ) {
    this.unlisten = budget?.listen(() => this.update());
  }

  private readonly unlisten?: () => void;

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
    this.budget?.setPending(this.id, pending);
    const overLocal = pending >= this.limits.high;
    const underLocal = pending <= this.limits.low;
    const overGlobal = this.budget?.shouldPause(this.id) ?? false;
    const canResumeGlobally = this.budget?.canResume(this.id) ?? true;
    if (!this.paused && (this.holds > 0 || overLocal || overGlobal)) {
      this.paused = true;
      this.pause();
    } else if (this.paused && !this.holds && underLocal && canResumeGlobally) {
      this.paused = false;
      this.resume();
    }
  }

  dispose() {
    this.disposed = true;
    this.unlisten?.();
    this.budget?.remove(this.id);
    if (this.paused) {
      this.paused = false;
      this.resume();
    }
  }
}
