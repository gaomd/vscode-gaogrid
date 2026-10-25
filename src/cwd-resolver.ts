import { constants, promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import { promisify } from "util";

const exec = promisify(execFile);

export async function validDirectory(
  candidate?: string,
): Promise<string | undefined> {
  if (!candidate || candidate.includes("\0") || !path.isAbsolute(candidate))
    return;
  try {
    const normalized = path.normalize(candidate);
    if (!(await fs.stat(normalized)).isDirectory()) return;
    await fs.access(normalized, constants.X_OK);
    return normalized;
  } catch {
    return;
  }
}

export async function resolveCwd(
  candidates: (string | undefined)[],
): Promise<string> {
  for (const candidate of candidates) {
    const cwd = await validDirectory(candidate);
    if (cwd) return cwd;
  }
  throw new Error("No accessible working directory is available.");
}

export function localOscDirectory(value: string): string | undefined {
  try {
    const uri = new URL(value);
    const host = uri.hostname.toLowerCase();
    const local = os.hostname().toLowerCase();
    if (
      uri.protocol !== "file:" ||
      uri.username ||
      uri.password ||
      uri.port ||
      uri.search ||
      uri.hash
    )
      return;
    if (
      host &&
      host !== "localhost" &&
      host !== local &&
      host !== local.split(".")[0]
    )
      return;
    // fileURLToPath rejects non-empty hosts on POSIX, even our own hostname.
    uri.hostname = "";
    return fileURLToPath(uri);
  } catch {
    return;
  }
}

/** Passive reports are hints; directory inspection happens only on demand. */
export class CwdResolver {
  private reported?: { cwd: string; at: number };

  constructor(public cwd: string) {}

  report(value: string) {
    const cwd = localOscDirectory(value);
    if (cwd) this.reported = { cwd, at: Date.now() };
  }

  async refresh(pid?: number) {
    // Without command hooks, an old OSC report may predate a subsequent cd.
    const reported = this.reported;
    if (reported && Date.now() - reported.at < 1000) {
      const cwd = await validDirectory(reported.cwd);
      if (cwd) return (this.cwd = cwd);
    }
    let inspected: string | undefined;
    try {
      if (pid && process.platform === "linux")
        inspected = await fs.readlink(`/proc/${pid}/cwd`);
      else if (pid && process.platform === "darwin") {
        const { stdout } = await exec(
          "/usr/sbin/lsof",
          ["-a", "-p", String(pid), "-d", "cwd", "-Fn"],
          { timeout: 1200 },
        );
        inspected = stdout
          .split("\n")
          .find((line) => line.startsWith("n"))
          ?.slice(1);
      }
    } catch {
      // Sandboxes and exited processes may make inspection unavailable.
    }
    const cwd = await validDirectory(inspected);
    if (cwd) return (this.cwd = cwd);
    return validDirectory(this.cwd);
  }
}
