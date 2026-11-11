import { test } from "node:test";
import assert from "node:assert/strict";
import type { Terminal } from "@xterm/xterm";
import { TerminalFitAddon } from "../src/webview/terminal-fit";

function measure(hostWidth: number, screenWidth = 640) {
  // Simulate a stale render canvas that would have proposed half the host
  // width before the fitter switched to the screen's CSS dimensions.
  const canvas = { width: screenWidth * 4 };
  const screen = {
    style: { width: `${screenWidth}px` },
    querySelector: () => canvas,
    getBoundingClientRect: () => ({ width: screenWidth }),
  };
  const host = {
    clientWidth: hostWidth,
    clientHeight: 320,
  };
  const element = {
    parentElement: host,
    querySelector: () => screen,
  };
  const terminal = {
    cols: 80,
    rows: 24,
    element,
    options: { scrollback: 1000, overviewRuler: { width: 14 } },
    _core: {
      _renderService: {
        dimensions: {
          css: {
            cell: { width: 8, height: 16 },
          },
        },
      },
    },
  };
  const style = {
    getPropertyValue(name: string) {
      if (name === "--gg-terminal-scrollbar-width") return "6px";
      if (name === "height") return "320px";
      if (name === "width") return `${hostWidth}px`;
      if (
        name === "padding-top" ||
        name === "padding-right" ||
        name === "padding-bottom" ||
        name === "padding-left"
      )
        return "0px";
      return "";
    },
  };
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousComputedStyle = Object.getOwnPropertyDescriptor(
    globalThis,
    "getComputedStyle",
  );
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { getComputedStyle: () => style, devicePixelRatio: 2 },
  });
  Object.defineProperty(globalThis, "getComputedStyle", {
    configurable: true,
    value: () => style,
  });
  try {
    const fit = new TerminalFitAddon();
    fit.activate(terminal as unknown as Terminal);
    return fit.proposeDimensions();
  } finally {
    if (previousWindow)
      Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (previousComputedStyle)
      Object.defineProperty(
        globalThis,
        "getComputedStyle",
        previousComputedStyle,
      );
    else Reflect.deleteProperty(globalThis, "getComputedStyle");
  }
}

test("fit rejects a transient host narrower than two character cells", () => {
  assert.equal(measure(14), undefined);
});

test("fit ignores a stale canvas width and reserves the slim scrollbar gutter", () => {
  assert.deepEqual(measure(640), { cols: 79, rows: 20 });
});
