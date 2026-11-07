import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const { prepareSpawnHelpers } = require("../scripts/prepare-node-pty");

test("production webview CSS includes terminal layout and input styles", async () => {
  await promisify(execFile)(process.execPath, ["esbuild.js"]);
  const css = await readFile("dist/webview.css", "utf8");
  assert.match(
    css,
    /\.xterm \.xterm-screen canvas\s*\{[^}]*position:\s*absolute/,
  );
  assert.match(css, /\.xterm \.xterm-helper-textarea\s*\{[^}]*opacity:\s*0/);
  assert.match(css, /\.xterm \.xterm-viewport\s*\{[^}]*overflow-y:\s*scroll/);
  assert.match(
    css,
    /\.terminal-mount\[data-file-drag-preview=true\]::after\s*\{[^}]*content:\s*"Drop to insert paths"/,
  );
  assert.match(css, /\.terminal-tabs::after\s*\{[^}]*content:\s*""/);
  assert.match(css, /\.workspace-rail__list::after\s*\{[^}]*content:\s*""/);
  assert.match(
    css,
    /\.drag-insertion-marker\[data-axis=horizontal\]\[data-edge=start\]\s*\{[^}]*transform:\s*translate\(0,\s*-50%\)/,
  );
  assert.match(
    css,
    /\.workspace-label\[data-drop-target=true\]\s*\{[^}]*box-shadow:\s*inset 0 0 0 2px/,
  );
  assert.match(
    css,
    /\.workspace-label,\s*\.workspace-rail__add,\s*\.workspace-rail__window,\s*\.workspace-rail__maximize,\s*\.workspace-rail__transfer,\s*\.workspace-rail__settings\s*\{[^}]*width:\s*100%[^}]*height:\s*auto[^}]*aspect-ratio:\s*1/,
  );
  for (const side of ["left", "right", "top", "bottom"])
    assert.match(
      css,
      new RegExp(
        `\\.terminal-surface\\[data-drop-side=${side}\\]::after\\s*\\{[^}]*border-radius:`,
      ),
    );
});

test("release preparation makes every bundled pty helper executable", async (t) => {
  const packageRoot = await mkdtemp(join(tmpdir(), "gaogrid-package-"));
  t.after(() => rm(packageRoot, { recursive: true, force: true }));
  const nativeDirs = [
    join(packageRoot, "build", "Release"),
    join(packageRoot, "prebuilds", "darwin-arm64"),
    join(packageRoot, "prebuilds", "darwin-x64"),
  ];
  await Promise.all(nativeDirs.map((dir) => mkdir(dir, { recursive: true })));
  await Promise.all(
    nativeDirs.map(async (dir) => {
      const helper = join(dir, "spawn-helper");
      await writeFile(helper, "");
      await chmod(helper, 0o644);
    }),
  );

  prepareSpawnHelpers(packageRoot);

  for (const dir of nativeDirs) {
    const helper = join(dir, "spawn-helper");
    assert.notEqual((await stat(helper)).mode & 0o111, 0);
  }
});
