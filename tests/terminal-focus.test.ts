import { test } from "node:test";
import assert from "node:assert/strict";
import { frontend } from "./fixtures/terminal-frontend";

test("a replayed terminal is opened before focus so its textarea can receive focus", (t) => {
  const f = frontend(t);
  Object.defineProperties(f.host, {
    isConnected: { configurable: true, value: true },
    hidden: { configurable: true, value: false },
    clientWidth: { configurable: true, value: 800 },
    clientHeight: { configurable: true, value: 300 },
  });
  const surface = (
    f.view as unknown as {
      surfaces: Map<
        string,
        {
          opened: boolean;
          replaying: boolean;
          host: HTMLElement;
          terminal: {
            cols: number;
            rows: number;
            open(host: HTMLElement): void;
            clearTextureAtlas(): void;
            refresh(start: number, end: number): void;
            dispose(): void;
          };
        }
      >;
      useWebgl: boolean;
      fitVisible(): void;
    }
  ).surfaces.get(f.tab.id)!;
  surface.opened = false;
  surface.replaying = true;
  (
    f.view as unknown as {
      useWebgl: boolean;
      fitVisible(): void;
    }
  ).useWebgl = false;
  let opened = 0;
  let cleared = 0;
  let refreshed = 0;
  surface.terminal = {
    cols: 80,
    rows: 24,
    open: () => opened++,
    clearTextureAtlas: () => cleared++,
    refresh: () => refreshed++,
    dispose() {},
  };

  (
    f.view as unknown as {
      fitVisible(): void;
    }
  ).fitVisible();

  assert.equal(opened, 1);
  assert.equal(surface.opened, true);
  f.host.dispatchEvent(new Event("focusin"));
  assert.equal(cleared, 1);
  assert.equal(refreshed, 1);

  f.host.dispatchEvent(new Event("focusout"));
  f.runAnimationFrames();
  assert.equal(cleared, 1, "losing focus must not clear the glyph atlas");
  assert.equal(refreshed, 2);
});

test("WebGL requires an explicit on setting and auto remains on the DOM renderer", (t) => {
  const f = frontend(t);
  const view = f.view as unknown as {
    useWebgl: boolean;
    applySettings(settings?: Record<string, unknown>): void;
  };
  view.applySettings({ gpuAcceleration: "auto" });
  assert.equal(view.useWebgl, false);
  view.applySettings({ gpuAcceleration: "off" });
  assert.equal(view.useWebgl, false);
  view.applySettings({ gpuAcceleration: "on" });
  assert.equal(view.useWebgl, true);
});
