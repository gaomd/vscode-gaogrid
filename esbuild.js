const esbuild = require("esbuild");
const watch = process.argv.includes("--watch");
const common = {
  bundle: true,
  platform: "node",
  target: "node20",
  sourcemap: true,
  external: ["vscode", "node-pty"],
};
async function build() {
  const extension = await esbuild.context({
    ...common,
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.js",
  });
  const webview = await esbuild.context({
    bundle: true,
    platform: "browser",
    target: "es2022",
    sourcemap: true,
    entryPoints: ["src/webview/main.ts"],
    outfile: "dist/webview.js",
    loader: { ".css": "css", ".svg": "text" },
  });
  if (watch) {
    await extension.watch();
    await webview.watch();
  } else {
    await extension.rebuild();
    await webview.rebuild();
    await extension.dispose();
    await webview.dispose();
  }
}
build().catch((e) => {
  console.error(e);
  process.exit(1);
});
