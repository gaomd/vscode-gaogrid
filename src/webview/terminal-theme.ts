import type { FontWeight, ITerminalOptions, ITheme } from "@xterm/xterm";

const ANSI_COLORS = [
  ["black", "Black", "#000000"],
  ["red", "Red", "#cd3131"],
  ["green", "Green", "#0dbc79"],
  ["yellow", "Yellow", "#e5e510"],
  ["blue", "Blue", "#2472c8"],
  ["magenta", "Magenta", "#bc3fbc"],
  ["cyan", "Cyan", "#11a8cd"],
  ["white", "White", "#e5e5e5"],
  ["brightBlack", "BrightBlack", "#666666"],
  ["brightRed", "BrightRed", "#f14c4c"],
  ["brightGreen", "BrightGreen", "#23d18b"],
  ["brightYellow", "BrightYellow", "#f5f543"],
  ["brightBlue", "BrightBlue", "#3b8eea"],
  ["brightMagenta", "BrightMagenta", "#d670d6"],
  ["brightCyan", "BrightCyan", "#29b8db"],
  ["brightWhite", "BrightWhite", "#ffffff"],
] as const;

function fontWeight(value: string, fallback: FontWeight): FontWeight {
  if (value === "normal" || value === "bold") return value;
  const weight = Number(value);
  return weight >= 100 && weight <= 900 && weight % 100 === 0
    ? (weight as FontWeight)
    : fallback;
}

export function readTerminalOptions(): ITerminalOptions {
  const style = getComputedStyle(document.body);
  const read = (name: string, fallback = "") =>
    style.getPropertyValue(name).trim() || fallback;
  const number = (name: string, fallback: number) => {
    const value = Number.parseFloat(read(name));
    return Number.isFinite(value) ? value : fallback;
  };
  const theme: ITheme = {
    background: read(
      "--vscode-terminal-background",
      read("--vscode-editor-background"),
    ),
    foreground: read(
      "--vscode-terminal-foreground",
      read("--vscode-foreground"),
    ),
    cursor: read("--vscode-terminalCursor-foreground") || undefined,
    selectionBackground:
      read("--vscode-terminal-selectionBackground") || undefined,
  };
  for (const [name, token, fallback] of ANSI_COLORS) {
    theme[name] = read(`--vscode-terminal-ansi${token}`, fallback);
  }
  return {
    theme,
    fontFamily: read("--terminal-font-family", "monospace"),
    fontSize: number("--terminal-font-size", 12),
    fontWeight: fontWeight(read("--terminal-font-weight"), "normal"),
    fontWeightBold: fontWeight(read("--terminal-font-weight-bold"), "bold"),
    lineHeight: number("--terminal-line-height", 1),
    letterSpacing: number("--terminal-letter-spacing", 0),
    minimumContrastRatio: number("--terminal-minimum-contrast", 1),
  };
}
