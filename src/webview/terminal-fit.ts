import { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";

/** Fit the character grid to the full width when the scrollbar is an overlay. */
export class TerminalFitAddon extends FitAddon {
  private terminal?: Terminal;

  override activate(terminal: Terminal) {
    super.activate(terminal);
    this.terminal = terminal;
  }

  override proposeDimensions() {
    const dimensions = super.proposeDimensions();
    const terminal = this.terminal;
    const screen =
      terminal?.element?.querySelector<HTMLElement>(".xterm-screen");
    const host = terminal?.element?.parentElement;
    if (!dimensions || !terminal || !screen || !host) return dimensions;

    // Public DOM measurements avoid xterm's private viewport and its 15px
    // fallback reservation. Canvas pixels retain precision across display zoom.
    const canvas = screen.querySelector<HTMLCanvasElement>(
      "canvas:not(.xterm-image-layer)",
    );
    const cellWidth = canvas
      ? canvas.width / terminal.cols / window.devicePixelRatio
      : screen.getBoundingClientRect().width / terminal.cols;
    if (cellWidth > 0)
      dimensions.cols = Math.max(2, Math.floor(host.clientWidth / cellWidth));
    return dimensions;
  }
}
