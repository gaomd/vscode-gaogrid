import { Terminal, type ITerminalAddon } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import {
  MAX_SNAPSHOT_LENGTH,
  TERMINAL_HISTORY_LINES,
} from "./terminal-constants";

export interface OutputSnapshot {
  version: 1;
  cols: number;
  rows: number;
  data: string;
  truncated?: boolean;
}
export { MAX_SNAPSHOT_LENGTH };

/** Parse output into terminal cells, so recovery never replays protocol queries. */
export class TerminalHistory {
  private readonly terminal: Terminal;
  private readonly serializer = new SerializeAddon();
  private disposed = false;
  private readonly mouseEncodingModes = new Set<number>();
  private cursorHidden = false;
  constructor(cols: number, rows: number) {
    this.terminal = new Terminal({
      cols,
      rows,
      scrollback: TERMINAL_HISTORY_LINES,
      allowProposedApi: true,
    });
    this.terminal.loadAddon(new Unicode11Addon() as unknown as ITerminalAddon);
    this.terminal.unicode.activeVersion = "11";
    // SerializeAddon officially supports both browser and headless terminals.
    this.terminal.loadAddon(this.serializer as unknown as ITerminalAddon);
    for (const final of ["h", "l"])
      this.terminal.parser.registerCsiHandler(
        { prefix: "?", final },
        (params) => {
          for (const value of params) {
            if (value === 25) this.cursorHidden = final === "l";
            else if (
              typeof value === "number" &&
              [1005, 1006, 1015, 1016].includes(value)
            ) {
              if (final === "h") this.mouseEncodingModes.add(value);
              else this.mouseEncodingModes.delete(value);
            }
          }
          return false;
        },
      );
    this.terminal.parser.registerEscHandler({ final: "c" }, () => {
      this.mouseEncodingModes.clear();
      this.cursorHidden = false;
      return false;
    });
  }
  write(data: string, parsed?: () => void) {
    if (!this.disposed) this.terminal.write(data, parsed);
  }
  resize(cols: number, rows: number) {
    this.write("", () => this.terminal.resize(cols, rows));
  }
  snapshot(
    consume?: (snapshot: OutputSnapshot) => void,
    live = false,
  ): Promise<OutputSnapshot> {
    if (this.disposed)
      return Promise.reject(new Error("Terminal history is closed."));
    return new Promise((resolve, reject) => {
      this.write("", () => {
        try {
          const snapshot = this.serialize(live);
          consume?.(snapshot);
          resolve(snapshot);
        } catch (error) {
          reject(error);
        }
      });
    });
  }
  private serialize(live: boolean): OutputSnapshot {
    let scrollback = TERMINAL_HISTORY_LINES;
    let data: string;
    let truncated = false;
    do {
      data = this.serializer.serialize({
        scrollback,
        excludeModes: !live,
        excludeAltBuffer: !live,
      });
      if (data.length <= MAX_SNAPSHOT_LENGTH || !scrollback) break;
      scrollback = Math.floor(scrollback / 2);
      truncated = true;
    } while (true);
    if (!live && this.terminal.buffer.active.type === "alternate") {
      // Preserve the last application screen as history, without restoring its
      // input/mouse/alternate-screen modes into the new shell.
      const screen = this.terminal.buffer.alternate;
      const lines = Array.from(
        { length: screen.length },
        (_, index) => screen.getLine(index)?.translateToString(true) || "",
      );
      data += "\x1b[0m\r\n" + lines.join("\r\n").trimEnd();
    }
    if (live) {
      for (const mode of this.mouseEncodingModes) data += `\x1b[?${mode}h`;
      // SerializeAddon omits cursor visibility and mouse encoding modes.
      if (this.cursorHidden) data += "\x1b[?25l";
    }
    if (data.length > MAX_SNAPSHOT_LENGTH)
      throw new Error("Terminal output snapshot exceeds the storage limit.");
    return {
      version: 1,
      cols: this.terminal.cols,
      rows: this.terminal.rows,
      data,
      ...(truncated ? { truncated: true } : {}),
    };
  }
  dispose() {
    this.disposed = true;
    this.terminal.dispose();
  }
}
