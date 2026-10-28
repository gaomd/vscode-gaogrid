export interface TerminalDefaultColors {
  foreground: string;
  background: string;
}

/** Resolve editor CSS colors to RGB values safe to send over tmux's protocol. */
export function normalizeTerminalColors(
  value: unknown,
): TerminalDefaultColors | undefined {
  if (!value || typeof value !== "object") return;
  const colors = value as Record<string, unknown>;
  const foreground = rgb(colors.foreground);
  const background = rgb(colors.background);
  if (foreground && background) return { foreground, background };
}

function rgb(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  const hex = /^#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.exec(value.trim());
  if (hex) {
    const digits = hex[1];
    return (
      "#" +
      (digits.length <= 4
        ? [...digits.slice(0, 3)].map((digit) => digit + digit).join("")
        : digits.slice(0, 6)
      ).toLowerCase()
    );
  }
  const css =
    /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)$/i.exec(
      value.trim(),
    );
  if (!css) return;
  const channels = css.slice(1).map(Number);
  if (channels.some((channel) => channel > 255)) return;
  return (
    "#" +
    channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")
  );
}
