const { readFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");

function packageFileName(manifest) {
  return `vscode-${manifest.publisher}.${manifest.name}-${manifest.version}.vsix`;
}

function main() {
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  const result = spawnSync(
    npx,
    [
      "--yes",
      "@vscode/vsce@^4.0.0",
      "package",
      "--out",
      packageFileName(manifest),
      "--githubBranch",
      "main",
    ],
    { stdio: "inherit" },
  );
  process.exitCode = result.status ?? 1;
}

if (require.main === module) main();

module.exports = { packageFileName };
