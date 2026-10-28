import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { constants as osConstants } from "os";
import { StringDecoder } from "string_decoder";
import { TmuxOutputFilter } from "./tmux-output-filter";
import {
  TmuxControlProtocol,
  type TmuxControlBlock,
} from "./tmux-control-protocol";
import {
  TMUX_SNAPSHOT_FORMAT,
  decodeTmuxEscapes,
  renderTmuxSnapshot,
} from "./tmux-snapshot";
import { TERMINAL_HISTORY_LINES } from "./terminal-constants";
import type { TerminalDefaultColors } from "./terminal-colors";

export interface TmuxControlOptions {
  args: string[];
  target: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  cols: number;
  rows: number;
  defaultColors?: TerminalDefaultColors;
  colorReports?: boolean;
}

type Exit = { exitCode: number; signal?: number };
type Listener<T> = (value: T) => void;
const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
const SNAPSHOT_BLOCKS = 5; // refresh-client, metadata, saved, pending, active capture
const READY_TIMEOUT_MS = 30_000;

/** A tmux control-mode client that turns %output records into terminal bytes. */
export class TmuxControlProcess {
  readonly pid: number;
  readonly ready: Promise<void>;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly paneDecoder = new StringDecoder("utf8");
  private readonly outputFilter = new TmuxOutputFilter();
  private readonly protocol: TmuxControlProtocol;
  private completedBlocks = 0;
  private info = "";
  private paneId = "";
  private active: Buffer[] = [];
  private saved: Buffer[] = [];
  private pending: Buffer[] = [];
  private pendingPrefix: Buffer = Buffer.alloc(0);
  private snapshotDone = false;
  private attached = false;
  private snapshotCommands = "";
  private readonly dataListeners = new Set<Listener<string>>();
  private readonly exitListeners = new Set<Listener<Exit>>();
  private exited = false;
  private failed = false;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private readonly readyTimer: NodeJS.Timeout;
  private readonly target: string;
  private defaultColors?: TerminalDefaultColors;
  private readonly colorReports: boolean;

  constructor(options: TmuxControlOptions) {
    this.target = options.target;
    this.defaultColors = options.defaultColors;
    this.colorReports = options.colorReports ?? true;
    this.ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.readyTimer = setTimeout(() => this.fail(), READY_TIMEOUT_MS);
    this.readyTimer.unref();
    this.protocol = new TmuxControlProtocol(
      () => (this.attached ? this.completedBlocks : -1),
      (block) => this.completeControlBlock(block),
      (paneId, bytes) => this.handleOutput(paneId, bytes),
    );
    this.child = spawn("tmux", options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.pid = this.child.pid ?? 0;
    this.child.stdout.on("data", (chunk: Buffer) => {
      try {
        this.protocol.write(chunk);
      } catch {
        // Invalid protocol or snapshot data must not escape an EventEmitter
        // callback. Keep implementation details and payload data out of errors.
        this.fail();
      }
    });
    this.child.stdout.on("error", () => this.fail());
    this.child.stdin.on("error", () => this.fail());
    // stderr is diagnostic only; never inject it into the terminal stream.
    this.child.stderr.resume();
    this.child.once("error", () => this.fail());
    this.child.once("close", (code, signal) => {
      // Drain stdout before announcing exit, so the final pane bytes reach
      // history before lifecycle cleanup can dispose the terminal.
      this.deliver(
        this.outputFilter.write(this.paneDecoder.end()) +
          this.outputFilter.flush(),
      );
      this.exited = true;
      const event: Exit = { exitCode: code ?? (signal ? 1 : 0) };
      if (signal) event.signal = osConstants.signals[signal];
      for (const listener of this.exitListeners) {
        try {
          listener(event);
        } catch {
          // A consumer callback must not crash child-process event handling.
        }
      }
      if (!this.snapshotDone) this.fail();
    });

    // The attached client first reports completion of the command-line
    // attach-session. Submit the ordered snapshot batch only after that block.
    const target = quote(options.target);
    this.snapshotCommands = [
      `refresh-client -C ${Math.max(1, options.cols)}x${Math.max(1, options.rows)}`,
      `display-message -p -t ${target} ${quote(TMUX_SNAPSHOT_FORMAT)}`,
      `capture-pane -p -e -C -a -q -t ${target} -S -${TERMINAL_HISTORY_LINES}`,
      `capture-pane -p -C -P -t ${target}`,
      // Capture the active pane last so notifications from before this command
      // are reflected in the snapshot at the final ordered boundary.
      `capture-pane -p -e -C -t ${target} -S -${TERMINAL_HISTORY_LINES}`,
    ].join("; ");
  }

  onData(listener: Listener<string>) {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }
  onExit(listener: Listener<Exit>) {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  }
  write(data: string | Buffer) {
    if (this.exited) return;
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
    // Hex input is binary-safe, including newlines and control-mode markers.
    // Bound command size to keep each line comfortably below tmux's limits.
    const chunkSize = 256;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      const hex = bytes.subarray(offset, offset + chunkSize).toString("hex");
      this.send(
        `send-keys -H -t ${quote(this.target)} ${hex.match(/../g)?.join(" ") ?? ""}\n`,
      );
    }
  }
  resize(cols: number, rows: number) {
    if (!this.exited)
      this.send(
        `refresh-client -C ${Math.max(1, cols)}x${Math.max(1, rows)}\n`,
      );
  }
  setDefaultColors(colors: TerminalDefaultColors) {
    this.defaultColors = colors;
    if (!this.snapshotDone || this.exited) return;
    if (this.colorReports) {
      for (const [command, color] of [
        [10, colors.foreground],
        [11, colors.background],
      ] as const) {
        const rgb = color.slice(1).match(/../g)!.join("/");
        this.send(
          `refresh-client -r ${quote(`${this.paneId}:\x1b]${command};rgb:${rgb}\x07`)}\n`,
        );
      }
    } else {
      // tmux before 3.5 has no control-client color reports. Pane defaults
      // provide the same OSC 10/11 answers without injecting terminal input.
      this.send(
        `select-pane -t ${quote(this.target)} -P ${quote(`fg=${colors.foreground},bg=${colors.background}`)}\n`,
      );
    }
  }
  pause() {
    this.child.stdout.pause();
  }
  resume() {
    this.child.stdout.resume();
  }
  kill(signal?: string) {
    if (signal) this.child.kill(signal as NodeJS.Signals);
    else this.child.kill();
  }

  private completeControlBlock(block: TmuxControlBlock) {
    if (block.error) {
      if (!this.snapshotDone) this.fail();
      return;
    }
    this.completeBlock(block.lines);
  }
  private handleOutput(paneId: string, encoded: Buffer) {
    const paneBytes = decodeTmuxEscapes(encoded);
    if (this.snapshotDone && paneId === this.paneId) {
      const orderedBytes = this.pendingPrefix.length
        ? Buffer.concat([this.pendingPrefix, paneBytes])
        : paneBytes;
      this.pendingPrefix = Buffer.alloc(0);
      this.deliver(
        this.outputFilter.write(this.paneDecoder.write(orderedBytes)),
      );
    }
  }
  private completeBlock(lines: Buffer[]) {
    if (!this.attached) {
      this.attached = true;
      this.send(this.snapshotCommands + "\n");
      return;
    }
    if (this.completedBlocks === 1)
      this.info = Buffer.concat(lines).toString("utf8");
    else if (this.completedBlocks === 2)
      this.saved = lines.map((line) =>
        Buffer.concat([line, Buffer.from("\n")]),
      );
    else if (this.completedBlocks === 3) this.pending = lines;
    else if (this.completedBlocks === 4)
      this.active = lines.map((line) =>
        Buffer.concat([line, Buffer.from("\n")]),
      );
    this.completedBlocks++;
    if (this.completedBlocks === SNAPSHOT_BLOCKS) {
      const snapshot = renderTmuxSnapshot(this.info, this.active, this.saved);
      this.paneId = snapshot.paneId;
      this.snapshotDone = true;
      clearTimeout(this.readyTimer);
      this.deliver(snapshot.data);
      // Keep an incomplete parser prefix adjacent to its continuation in the
      // post-snapshot stream; separate delivery would lose parser state when
      // the frontend rebuilds from parsed terminal cells.
      this.pendingPrefix = decodeTmuxEscapes(Buffer.concat(this.pending));
      if (this.defaultColors) this.setDefaultColors(this.defaultColors);
      this.readyResolve();
    }
  }
  private deliver(data: string) {
    if (!data.length) return;
    for (const listener of this.dataListeners) {
      try {
        listener(data);
      } catch {
        // Isolate transport parsing from downstream terminal consumers.
      }
    }
  }
  private send(command: string) {
    if (this.exited || this.child.stdin.destroyed) return;
    try {
      this.child.stdin.write(command);
    } catch {
      this.fail();
    }
  }
  private fail() {
    if (this.failed) return;
    this.failed = true;
    clearTimeout(this.readyTimer);
    if (!this.snapshotDone)
      this.readyReject(
        new Error(
          "tmux control process failed before its initial snapshot was ready.",
        ),
      );
    if (!this.exited) this.child.kill();
  }
}
