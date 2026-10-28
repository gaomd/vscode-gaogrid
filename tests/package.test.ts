import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const { prepareSpawnHelpers } = require("../scripts/prepare-node-pty");

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
