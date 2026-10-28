const fs = require("node:fs");
const path = require("node:path");

function prepareSpawnHelper() {
  const packageRoot = path.dirname(path.dirname(require.resolve("node-pty")));
  const nativeDirs = [
    path.join(packageRoot, "build", "Release"),
    path.join(packageRoot, "build", "Debug"),
    path.join(packageRoot, "prebuilds", `${process.platform}-${process.arch}`),
  ];
  const nativeDir = nativeDirs.find((dir) =>
    fs.existsSync(path.join(dir, "pty.node")),
  );
  if (!nativeDir) return;
  const helper = path.join(nativeDir, "spawn-helper");
  if (!fs.existsSync(helper)) return;
  const mode = fs.statSync(helper).mode;
  if (!(mode & 0o111)) fs.chmodSync(helper, mode | 0o111);
}

prepareSpawnHelper();
