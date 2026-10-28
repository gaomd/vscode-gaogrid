export interface TmuxControlBlock {
  id: string;
  error: boolean;
  lines: Buffer[];
}

interface PendingBlock extends TmuxControlBlock {
  responseIndex: number;
}

const MAX_CONTROL_LINE_BYTES = 16 * 1024 * 1024;

/** Incremental parser for tmux control-mode framing and pane output records. */
export class TmuxControlProtocol {
  private lineBuffer = Buffer.alloc(0);
  private block?: PendingBlock;

  constructor(
    private readonly nextResponseIndex: () => number,
    private readonly onBlock: (block: TmuxControlBlock) => void,
    private readonly onOutput: (paneId: string, bytes: Buffer) => void,
  ) {}

  write(chunk: Buffer) {
    this.lineBuffer = Buffer.concat([this.lineBuffer, chunk]);
    let newline: number;
    while ((newline = this.lineBuffer.indexOf(0x0a)) !== -1) {
      let line = this.lineBuffer.subarray(0, newline);
      if (line.length && line[line.length - 1] === 0x0d)
        line = line.subarray(0, line.length - 1);
      this.lineBuffer = this.lineBuffer.subarray(newline + 1);
      if (line.length > MAX_CONTROL_LINE_BYTES)
        throw new Error("tmux control line exceeded the size limit.");
      this.record(line);
    }
    if (this.lineBuffer.length > MAX_CONTROL_LINE_BYTES)
      throw new Error("tmux control line exceeded the size limit.");
  }

  private record(bytes: Buffer) {
    const line = bytes.toString("utf8");
    const marker = /^(%begin|%end|%error) (\d+) (\d+) (\d+)(?:\s|$)/.exec(line);
    if (line.startsWith("%begin")) {
      if (this.block) {
        // Capture responses can contain arbitrary pane rows that resemble
        // control markers. Metadata responses cannot.
        if (this.block.responseIndex >= 2) this.block.lines.push(bytes);
        else throw new Error("Unexpected nested tmux control block.");
      } else if (marker?.[1] === "%begin") {
        this.block = {
          id: `${marker[2]} ${marker[3]} ${marker[4]}`,
          error: false,
          lines: [],
          responseIndex: this.nextResponseIndex(),
        };
      } else throw new Error("Invalid tmux control block marker.");
      return;
    }

    const markerId = marker && `${marker[2]} ${marker[3]} ${marker[4]}`;
    if (line.startsWith("%end") || line.startsWith("%error")) {
      if (!marker || !this.block)
        throw new Error("tmux control block ended unexpectedly.");
      if (this.block.id !== markerId) {
        if (this.block.responseIndex >= 2) this.block.lines.push(bytes);
        else throw new Error("tmux control block marker mismatch.");
        return;
      }
      const block = this.block;
      this.block = undefined;
      this.onBlock({
        id: block.id,
        error: marker[1] === "%error",
        lines: block.lines,
      });
      return;
    }

    const output = !this.block && /^%output (%\d+) /.exec(line);
    if (output) {
      const payloadOffset = Buffer.byteLength(output[0], "utf8");
      this.onOutput(output[1], bytes.subarray(payloadOffset));
      return;
    }
    if (this.block) this.block.lines.push(bytes);
  }
}
