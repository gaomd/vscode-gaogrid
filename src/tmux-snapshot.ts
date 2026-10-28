/**
 * Fields consumed by renderTmuxSnapshot, in exactly this order. Keep this
 * format in sync with the `display-message -p` call in the control transport.
 * Each value is numeric or a tmux pane id, so `|` is an unambiguous separator.
 */
export const TMUX_SNAPSHOT_FORMAT =
  "#{pane_id}|#{pane_width}|#{pane_height}|#{alternate_on}|#{cursor_x}|#{cursor_y}|#{cursor_flag}|#{keypad_cursor_flag}|#{keypad_flag}|#{mouse_standard_flag}|#{mouse_button_flag}|#{mouse_all_flag}|#{mouse_utf8_flag}|#{mouse_sgr_flag}|#{bracket_paste_flag}|#{insert_flag}|#{wrap_flag}|#{origin_flag}|#{scroll_region_upper}|#{scroll_region_lower}|#{alternate_saved_x}|#{alternate_saved_y}";

/** Decode tmux capture-pane -C's octal escapes without changing other bytes. */
export function decodeTmuxEscapes(value: Buffer): Buffer {
  const decoded: number[] = [];
  for (let i = 0; i < value.length; i++) {
    const byte = value[i];
    // capture-pane -C doubles printable backslashes. Consume the pair before
    // octal escapes so literal text such as \033 cannot become terminal input.
    if (byte === 0x5c && value[i + 1] === 0x5c) {
      decoded.push(byte);
      i++;
      continue;
    }
    if (
      byte === 0x5c &&
      i + 3 < value.length &&
      isOctal(value[i + 1]) &&
      isOctal(value[i + 2]) &&
      isOctal(value[i + 3])
    ) {
      const octet =
        ((value[i + 1] - 0x30) << 6) |
        ((value[i + 2] - 0x30) << 3) |
        (value[i + 3] - 0x30);
      if (octet <= 0xff) {
        decoded.push(octet);
        i += 3;
      } else decoded.push(byte);
    } else {
      decoded.push(byte);
    }
  }
  return Buffer.from(decoded);
}

function isOctal(value: number): boolean {
  return value >= 0x30 && value <= 0x37;
}

interface SnapshotInfo {
  paneId: string;
  width: number;
  height: number;
  alternate: boolean;
  cursorX: number;
  cursorY: number;
  cursorVisible: boolean;
  keypadCursor: boolean;
  keypad: boolean;
  mouseStandard: boolean;
  mouseButton: boolean;
  mouseAll: boolean;
  mouseUtf8: boolean;
  mouseSgr: boolean;
  bracketedPaste: boolean;
  insert: boolean;
  wrap: boolean;
  origin: boolean;
  scrollTop: number;
  scrollBottom: number;
  savedCursorX: number;
  savedCursorY: number;
}

function parseInfo(info: string): SnapshotInfo {
  const fields = info.split("|");
  if (fields.length !== 22 || !/^%\d+$/.test(fields[0]))
    throw new Error("Invalid tmux snapshot metadata.");
  const [
    paneId,
    width,
    height,
    alternate,
    cursorX,
    cursorY,
    cursorVisible,
    keypadCursor,
    keypad,
    mouseStandard,
    mouseButton,
    mouseAll,
    mouseUtf8,
    mouseSgr,
    bracketedPaste,
    insert,
    wrap,
    origin,
    scrollTop,
    scrollBottom,
    savedCursorX,
    savedCursorY,
  ] = info.split("|");
  const number = (value: string | undefined, fallback: number) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const flag = (value: string | undefined) => value === "1";
  const safeHeight = Math.max(1, number(height, 24));
  const safeWidth = Math.max(1, number(width, 80));
  const scrollTopNumber = number(scrollTop, 0);
  const scrollBottomNumber = number(scrollBottom, safeHeight - 1);
  const top = Math.max(0, Math.min(scrollTopNumber, safeHeight - 1));
  const bottom = Math.max(top, Math.min(scrollBottomNumber, safeHeight - 1));
  return {
    paneId: paneId || "",
    width: safeWidth,
    height: safeHeight,
    alternate: flag(alternate),
    cursorX: Math.max(0, Math.min(number(cursorX, 0), safeWidth - 1)),
    cursorY: Math.max(0, Math.min(number(cursorY, 0), safeHeight - 1)),
    cursorVisible: flag(cursorVisible),
    keypadCursor: flag(keypadCursor),
    keypad: flag(keypad),
    mouseStandard: flag(mouseStandard),
    mouseButton: flag(mouseButton),
    mouseAll: flag(mouseAll),
    mouseUtf8: flag(mouseUtf8),
    mouseSgr: flag(mouseSgr),
    bracketedPaste: flag(bracketedPaste),
    insert: flag(insert),
    wrap: flag(wrap),
    origin: flag(origin),
    scrollTop: top,
    scrollBottom: bottom,
    savedCursorX: Math.max(0, Math.min(number(savedCursorX, 0), safeWidth - 1)),
    savedCursorY: Math.max(
      0,
      Math.min(number(savedCursorY, 0), safeHeight - 1),
    ),
  };
}

/**
 * Split capture-pane's physical row delimiters before decoding octal escapes.
 * A pane can itself contain an octal-escaped LF, which must remain row data.
 */
function captureRows(capture: Buffer): Buffer[] {
  const rows: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < capture.length; i++) {
    if (capture[i] !== 0x0a) continue;
    rows.push(decodeTmuxEscapes(capture.subarray(start, i)));
    start = i + 1;
  }
  if (start < capture.length)
    rows.push(decodeTmuxEscapes(capture.subarray(start)));
  else if (capture.length === 0) rows.push(Buffer.alloc(0));
  return rows;
}

const esc = "\x1b";
const csi = `${esc}[`;
const decMode = (mode: number, enabled: boolean) =>
  `${csi}?${mode}${enabled ? "h" : "l"}`;
const rowCursor = (x: number, y: number) =>
  `${csi}${Math.max(0, y) + 1};${Math.max(0, x) + 1}H`;

function paintRows(rows: Buffer[], height: number): string {
  const visible = rows.slice(-height);
  const padding = Math.max(0, height - visible.length);
  let output = "";
  for (let y = 0; y < height; y++) {
    output += `${csi}${y + 1};1H${csi}2K`;
    if (y >= padding) output += visible[y - padding].toString("utf8");
  }
  return output;
}

function setModes(info: SnapshotInfo): string {
  let output = "";
  output += decMode(1, info.keypadCursor); // DECCKM
  output += info.keypad ? `${esc}=` : `${esc}>`; // DECKPAM / DECKPNM
  output += decMode(6, false); // draw/cursor coordinates are absolute
  output += decMode(7, info.wrap); // DECAWM
  output += `${csi}4${info.insert ? "h" : "l"}`; // IRM
  output += decMode(25, info.cursorVisible);
  output += decMode(1000, info.mouseStandard);
  output += decMode(1002, info.mouseButton);
  output += decMode(1003, info.mouseAll);
  output += decMode(1005, info.mouseUtf8);
  output += decMode(1006, info.mouseSgr);
  output += decMode(2004, info.bracketedPaste);
  const top = Math.max(0, Math.min(info.scrollTop, info.height - 1));
  const bottom = Math.max(top, Math.min(info.scrollBottom, info.height - 1));
  output += `${csi}${top + 1};${bottom + 1}r`;
  return output;
}

/**
 * Rebuild the pane's normal scrollback/screen and (when active) the actual
 * alternate screen. `active` is the ordinary capture-pane -S result; tmux
 * includes normal history followed by the current alternate rows while in
 * alternate mode. `saved` is capture-pane -a, which contains normal rows only.
 */
export function renderTmuxSnapshot(
  infoText: string,
  active: Buffer[],
  saved: Buffer[],
): { paneId: string; data: string } {
  const info = parseInfo(infoText);
  const activeRows = captureRows(Buffer.concat(active));
  const savedRows = captureRows(Buffer.concat(saved));
  const height = info.height;
  const historyRows = activeRows.slice(
    0,
    Math.max(0, activeRows.length - height),
  );
  const normalRows = info.alternate ? savedRows : activeRows;

  // Move to the normal buffer, preserve scrollback, then deterministically
  // paint each visible row. Clear-screen does not erase xterm scrollback.
  let data = `${decMode(1049, false)}${decMode(6, false)}${csi}r${csi}2J${csi}H`;
  if (historyRows.length) {
    data += decMode(7, false);
    data += historyRows.map((row) => row.toString("utf8")).join("\r\n");
    data += "\r\n";
    // Scroll each captured history row off the visible screen. The viewport
    // is repainted below, while these rows remain in xterm's normal scrollback.
    data += "\r\n".repeat(Math.max(0, height - 1));
    data += decMode(7, true);
  }
  data += `${csi}2J${csi}H`;

  if (info.alternate) {
    data += paintRows(normalRows, height);
    data += rowCursor(info.savedCursorX, info.savedCursorY);
    data += decMode(1049, true);
    data += paintRows(activeRows, height);
  } else {
    data += paintRows(normalRows, height);
  }

  data += setModes(info);
  if (info.origin) {
    data += decMode(6, true);
    data += rowCursor(info.cursorX, info.cursorY - info.scrollTop);
  } else data += rowCursor(info.cursorX, info.cursorY);
  return { paneId: info.paneId, data };
}
