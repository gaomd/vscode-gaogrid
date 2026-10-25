import { execFile } from "child_process";
import { promisify } from "util";

const exec = promisify(execFile);
export interface ProcessInfo {
  pid: number;
  ppid: number;
  pgid: number;
  tpgid: number;
  tty: string;
  state: string;
  started: string;
  command: string;
}

export function parseProcessList(output: string): ProcessInfo[] {
  return output.split("\n").flatMap((line) => {
    const match =
      /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/.exec(
        line,
      );
    return match
      ? [
          {
            pid: +match[1],
            ppid: +match[2],
            pgid: +match[3],
            tpgid: +match[4],
            tty: match[5],
            state: match[6],
            started: match[7],
            command: match[8],
          },
        ]
      : [];
  });
}

export async function inspectProcesses(): Promise<ProcessInfo[] | undefined> {
  if (process.platform === "win32") return;
  try {
    const { stdout } = await exec(
      "/bin/ps",
      ["-ax", "-o", "pid=,ppid=,pgid=,tpgid=,tty=,stat=,lstart=,comm="],
      {
        timeout: 1200,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, LC_ALL: "C" },
      },
    );
    return parseProcessList(stdout);
  } catch {
    return;
  }
}

/** Recheck individual identities after HUP; never signal a cached process group. */
export function remainingProcesses(
  known: ProcessInfo[],
  current: ProcessInfo[],
): ProcessInfo[] {
  return current.filter(
    (entry) =>
      !entry.state.startsWith("Z") &&
      known.some(
        (prior) =>
          entry.pid === prior.pid &&
          entry.started === prior.started &&
          entry.pgid === prior.pgid &&
          // Shell exit can revoke the controlling tty without detaching the job.
          (entry.tty === prior.tty || /^(\?|\?\?|-)$/u.test(entry.tty)),
      ),
  );
}

/** Includes background jobs in other process groups, excludes detached daemons. */
export function terminalChildren(
  processes: ProcessInfo[],
  rootPid: number,
): ProcessInfo[] {
  const root = processes.find((entry) => entry.pid === rootPid);
  if (!root) return [];
  const descendants = new Set([rootPid]);
  let added = true;
  while (added) {
    added = false;
    for (const entry of processes) {
      if (!descendants.has(entry.pid) && descendants.has(entry.ppid)) {
        descendants.add(entry.pid);
        added = true;
      }
    }
  }
  return processes.filter(
    (entry) =>
      entry.pid !== rootPid &&
      descendants.has(entry.pid) &&
      entry.tty === root.tty &&
      !/^(\?|\?\?|-)$/u.test(entry.tty) &&
      !entry.state.startsWith("Z"),
  );
}
