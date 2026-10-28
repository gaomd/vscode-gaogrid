const fs = require("node:fs");
const path = require("node:path");

function prepareSpawnHelpers(packageRoot) {
  packageRoot ??= path.dirname(path.dirname(require.resolve("node-pty")));
  const prebuildRoot = path.join(packageRoot, "prebuilds");
  const prebuildDirs = fs.existsSync(prebuildRoot)
    ? fs
        .readdirSync(prebuildRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(prebuildRoot, entry.name))
    : [];
  const nativeDirs = [
    path.join(packageRoot, "build", "Release"),
    path.join(packageRoot, "build", "Debug"),
    ...prebuildDirs,
  ];

  for (const nativeDir of nativeDirs) {
    const helper = path.join(nativeDir, "spawn-helper");
    if (!fs.existsSync(helper)) continue;
    const mode = fs.statSync(helper).mode;
    if (!(mode & 0o111)) fs.chmodSync(helper, mode | 0o111);
  }
}

if (require.main === module) prepareSpawnHelpers();

module.exports = { prepareSpawnHelpers };
