import * as path from "path";
import { ProcessInfo, terminalChildren } from "./process-inspector";

const executable = (value: string) =>
  path
    .basename(value)
    .replace(/^-/, "")
    .replace(/\.exe$/i, "")
    .toLowerCase();

/** Called only when closing, using one OS snapshot shared by all target tabs. */
export function hasActiveTask(
  processes: ProcessInfo[],
  pid: number,
  shell: string,
): boolean {
  const root = processes.find((entry) => entry.pid === pid);
  if (!root || root.state.startsWith("Z")) return false;
  if (terminalChildren(processes, pid).length) return true;
  if (executable(root.command) !== executable(shell)) return true;
  return (
    root.tpgid > 0 &&
    root.tpgid !== root.pgid &&
    processes.some(
      (entry) =>
        entry.pgid === root.tpgid &&
        entry.tty === root.tty &&
        !entry.state.startsWith("Z") &&
        !/^(\?|\?\?|-)$/u.test(entry.tty),
    )
  );
}
