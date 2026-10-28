import { test } from "node:test";
import assert from "node:assert/strict";
import { Terminal } from "@xterm/headless";
import {
  decodeTmuxEscapes,
  renderTmuxSnapshot,
  TMUX_SNAPSHOT_FORMAT,
} from "../src/tmux-snapshot";

const esc = "\x1b";
const info = (fields: Partial<Record<string, string>> = {}) => {
  const values = [
    "%7",
    "12",
    "3",
    "0",
    "4",
    "1",
    "1",
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
    "1",
    "0",
    "0",
    "2",
    "2",
    "1",
  ];
  const names = [
    "pane_id",
    "pane_width",
    "pane_height",
    "alternate_on",
    "cursor_x",
    "cursor_y",
    "cursor_flag",
    "keypad_cursor_flag",
    "keypad_flag",
    "mouse_standard_flag",
    "mouse_button_flag",
    "mouse_all_flag",
    "mouse_utf8_flag",
    "mouse_sgr_flag",
    "bracket_paste_flag",
    "insert_flag",
    "wrap_flag",
    "origin_flag",
    "scroll_region_upper",
    "scroll_region_lower",
    "alternate_saved_x",
    "alternate_saved_y",
  ];
  for (const [name, value] of Object.entries(fields)) {
    const index = names.indexOf(name);
    if (index >= 0) values[index] = value;
  }
  return values.join("|");
};

test("snapshot display format has the documented field order", () => {
  assert.deepEqual(
    TMUX_SNAPSHOT_FORMAT.split("|").map((value) => value.replace(/[{}#]/g, "")),
    [
      "pane_id",
      "pane_width",
      "pane_height",
      "alternate_on",
      "cursor_x",
      "cursor_y",
      "cursor_flag",
      "keypad_cursor_flag",
      "keypad_flag",
      "mouse_standard_flag",
      "mouse_button_flag",
      "mouse_all_flag",
      "mouse_utf8_flag",
      "mouse_sgr_flag",
      "bracket_paste_flag",
      "insert_flag",
      "wrap_flag",
      "origin_flag",
      "scroll_region_upper",
      "scroll_region_lower",
      "alternate_saved_x",
      "alternate_saved_y",
    ],
  );
});

test("tmux octal escapes decode losslessly, including backslash and high bytes", () => {
  const source = Buffer.from("A\\000\\134\\200\\377Z\\400\\q", "ascii");
  assert.deepEqual(
    decodeTmuxEscapes(source),
    Buffer.from([
      0x41, 0x00, 0x5c, 0x80, 0xff, 0x5a, 0x5c, 0x34, 0x30, 0x30, 0x5c, 0x71,
    ]),
  );
  assert.equal(
    decodeTmuxEscapes(Buffer.from("\\\\033[?1049h", "ascii")).toString(),
    "\\033[?1049h",
    "capture-pane's escaped backslash must stay literal",
  );
});

test("normal snapshot restores history, visible rows, cursor and terminal modes", () => {
  const { paneId, data } = renderTmuxSnapshot(
    info({
      cursor_x: "5",
      cursor_y: "2",
      cursor_flag: "0",
      keypad_cursor_flag: "1",
      keypad_flag: "1",
      mouse_standard_flag: "1",
      mouse_button_flag: "1",
      mouse_utf8_flag: "1",
      mouse_sgr_flag: "1",
      bracket_paste_flag: "1",
      insert_flag: "1",
      wrap_flag: "0",
      origin_flag: "1",
      scroll_region_upper: "1",
      scroll_region_lower: "2",
    }),
    [Buffer.from("old history\nline one\nline two\nline three\n")],
    [],
  );

  assert.equal(paneId, "%7");
  assert.ok(data.includes("old history\r\n\r\n\r\n" + `${esc}[?7h${esc}[2J`));
  assert.ok(data.includes(`${esc}[1;1H${esc}[2Kline one`));
  assert.ok(data.includes(`${esc}[3;1H${esc}[2Kline three`));
  assert.ok(data.includes(`${esc}[?1h`));
  assert.ok(data.includes(`${esc}=`));
  assert.ok(data.includes(`${esc}[4h`));
  assert.ok(data.includes(`${esc}[?25l`));
  assert.ok(data.includes(`${esc}[?1000h`));
  assert.ok(data.includes(`${esc}[?1002h`));
  assert.ok(data.includes(`${esc}[?1005h`));
  assert.ok(data.includes(`${esc}[?1006h`));
  assert.ok(data.includes(`${esc}[?2004h`));
  assert.ok(data.includes(`${esc}[2;3r`));
  assert.ok(data.endsWith(`${esc}[?6h${esc}[2;6H`));
});

test("alternate snapshot restores the saved normal screen before the true alternate screen", () => {
  const { data } = renderTmuxSnapshot(
    info({
      alternate_on: "1",
      cursor_x: "2",
      cursor_y: "1",
      alternate_saved_x: "7",
      alternate_saved_y: "0",
    }),
    [Buffer.from("normal history\nalt one\nalt two\nalt three\n")],
    [Buffer.from("saved one\nsaved two\nsaved three\n")],
  );

  const savedScreen = data.indexOf("saved one");
  const enterAlternate = data.indexOf(`${esc}[?1049h`);
  const alternateScreen = data.indexOf("alt one", enterAlternate);
  assert.ok(savedScreen >= 0 && savedScreen < enterAlternate);
  assert.ok(enterAlternate < alternateScreen);
  assert.ok(data.includes(`${esc}[1;8H${esc}[?1049h`));
  assert.ok(data.endsWith(`${esc}[2;3H`));
  assert.ok(data.includes("normal history\r\n"));
});

test("large normal and alternate snapshots retain each history row exactly once", async (t) => {
  const height = 3;
  const history = Array.from(
    { length: 420 },
    (_, index) => `H${String(index).padStart(4, "0")}`,
  );
  const normalScreen = ["NORMAL0", "NORMAL1", "NORMAL2"];
  const alternateScreen = ["ALT0000", "ALT0001", "ALT0002"];
  const cases = [
    {
      metadata: info(),
      active: [...history, ...normalScreen],
      saved: [] as string[],
      expectedVisible: normalScreen,
    },
    {
      metadata: info({ alternate_on: "1" }),
      active: [...history, ...alternateScreen],
      saved: normalScreen,
      expectedVisible: alternateScreen,
    },
  ];

  for (const snapshot of cases) {
    const terminal = new Terminal({
      allowProposedApi: true,
      cols: 12,
      rows: height,
      scrollback: 1000,
    });
    t.after(() => terminal.dispose());
    const rendered = renderTmuxSnapshot(
      snapshot.metadata,
      [Buffer.from(snapshot.active.join("\n") + "\n")],
      snapshot.saved.length
        ? [Buffer.from(snapshot.saved.join("\n") + "\n")]
        : [],
    );
    await new Promise<void>((resolve) =>
      terminal.write(rendered.data, resolve),
    );
    const normal = terminal.buffer.normal;
    assert.equal(normal.baseY, history.length);
    const normalText = Array.from(
      { length: normal.length },
      (_, index) => normal.getLine(index)?.translateToString(true) || "",
    ).join("\n");
    for (const token of history) {
      assert.equal(
        normalText.split(token).length - 1,
        1,
        `normal history ${token}`,
      );
    }
    for (const token of normalScreen) {
      assert.equal(
        normalText.split(token).length - 1,
        1,
        `normal screen ${token}`,
      );
    }

    const active = terminal.buffer.active;
    const activeText = Array.from(
      { length: active.length },
      (_, index) => active.getLine(index)?.translateToString(true) || "",
    ).join("\n");
    for (const token of snapshot.expectedVisible) {
      assert.equal(
        activeText.split(token).length - 1,
        1,
        `visible screen ${token}`,
      );
    }
  }
});
