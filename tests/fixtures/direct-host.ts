import { join } from "node:path";
import { PtyManager } from "../../src/pty-manager";
import { TerminalOutputStore } from "../../src/terminal-output-store";
const root = process.argv[2];
const manager = new PtyManager(() => {}, {
  defaultShell: () => "/bin/bash",
  defaultDirectories: () => [root],
  environment: { ...process.env, HOME: root },
  outputStore: new TerminalOutputStore(join(root, "storage")),
  checkpointIntervalMs: 500,
});
void manager
  .start("crash", root)
  .then(() => manager.input("crash", "printf 'OUTPUT_%s\\n' 'BEFORE_CRASH'\r"));
setInterval(() => {}, 1000);
