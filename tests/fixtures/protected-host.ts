import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PtyManager } from "../../src/pty-manager";

async function main() {
  const root = process.argv[2];
  const manager = new PtyManager(() => {}, {
    defaultShell: () => "/bin/bash",
    defaultDirectories: () => [root],
    tmuxConfigPath: resolve("media/tmux.conf"),
    environment: { ...process.env, HOME: root },
  });
  await manager.start("crash", root, undefined, false, { backend: "tmux" });
  const metadata = manager.metadata("crash");
  if (metadata?.connectionState !== "connected")
    throw new Error("Helper could not attach");
  await writeFile(join(root, "backend.json"), JSON.stringify(metadata));
  manager.input(
    "crash",
    `sleep 300 & echo $! > '${root}/crash-task.pid'; wait\r`,
  );
  setInterval(() => {}, 1000);
}
void main().catch(() => {
  process.exitCode = 1;
});
