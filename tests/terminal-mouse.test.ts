import { test } from "node:test";
import assert from "node:assert/strict";
import { frontend } from "./fixtures/terminal-frontend";

function wheel(deltaY: number, shiftKey = false): WheelEvent {
  return {
    deltaY,
    shiftKey,
    preventDefault() {},
  } as WheelEvent;
}

test("mouse policy follows libghostty-style application and Shift routing", async (t) => {
  const f = frontend(t);
  f.tab.transport = "control";
  f.view.updateTab(f.tab);
  const surface = (
    f.view as unknown as {
      surfaces: Map<
        string,
        {
          transport?: string;
          terminal: typeof f.terminal;
        }
      >;
    }
  ).surfaces.get(f.tab.id)!;
  const dispatch = (event: WheelEvent): boolean =>
    (
      f.view as unknown as {
        handleWheel(surface: unknown, event: WheelEvent): boolean;
      }
    ).handleWheel(surface, event);

  await new Promise<void>((resolve) =>
    f.terminal.write("\x1b[?1000h", resolve),
  );
  f.view.setPreferences({
    defaultProtected: false,
    transport: "control",
    mousePolicy: "application",
  });
  assert.equal(dispatch(wheel(-1)), true);
  assert.equal(dispatch(wheel(-1, true)), false);

  f.view.setPreferences({
    defaultProtected: false,
    transport: "control",
    mousePolicy: "terminal",
  });
  assert.equal(dispatch(wheel(-1)), false);

  f.view.setPreferences({
    defaultProtected: false,
    transport: "control",
    mousePolicy: "exclusive",
  });
  assert.equal(dispatch(wheel(-1, true)), true);

  surface.transport = "attach";
  f.view.setPreferences({
    defaultProtected: false,
    transport: "attach",
    mousePolicy: "terminal",
  });
  assert.equal(dispatch(wheel(-1)), true);
});
