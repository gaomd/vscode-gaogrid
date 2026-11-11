import { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";

/** Fit the character grid while reserving a gutter for the slim scrollbar. */
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

    // The screen's CSS width is updated with the terminal buffer. Prefer it
    // over canvas device pixels so display-density changes and a temporarily
    // hidden render surface cannot distort the measured cell width.
    const screenWidth =
      Number.parseFloat(screen.style.width) ||
      screen.getBoundingClientRect().width;
    const cellWidth =
      terminal.cols > 0 && screenWidth > 0 ? screenWidth / terminal.cols : 0;
    const scrollbarWidth = Number.parseFloat(
      getComputedStyle(host).getPropertyValue("--gg-terminal-scrollbar-width"),
    );
    if (cellWidth > 0) {
      const availableWidth =
        host.clientWidth -
        (Number.isFinite(scrollbarWidth) ? scrollbarWidth : 0);
      const cols = Math.floor(availableWidth / cellWidth);
      // A transient layout can briefly report a few pixels while a tab is
      // becoming visible. Do not turn that invalid measurement into a real
      // two-column terminal resize; retry when the host has settled.
      if (cols < 2) return undefined;
      dimensions.cols = cols;
    }
    return dimensions;
  }
}
