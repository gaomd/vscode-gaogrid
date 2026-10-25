const { build } = require("esbuild");
const { readdirSync } = require("node:fs");
const { spawnSync } = require("node:child_process");

async function main() {
  const names = readdirSync("tests").filter((name) =>
    name.endsWith(".test.ts"),
  );
  await build({
    entryPoints: [
      ...names.map((name) => `tests/${name}`),
      "tests/fixtures/protected-host.ts",
      "tests/fixtures/direct-host.ts",
    ],
    outdir: "dist/tests",
    bundle: true,
    platform: "node",
    target: "node20",
    external: ["node-pty"],
    loader: { ".svg": "text" },
  });
  const result = spawnSync(
    process.execPath,
    [
      "--test",
      ...names.map((name) => `dist/tests/${name.replace(/\.ts$/, ".js")}`),
    ],
    { stdio: "inherit" },
  );
  process.exitCode = result.status ?? 1;
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
