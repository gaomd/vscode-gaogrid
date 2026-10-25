import * as pty from "node-pty";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { execFileSync } from "child_process";
import * as fs from "fs";
import { quoteShellPaths } from "./shell-paths";

type Session = {
  process: pty.IPty;
  cwd: string;
  output: string;
  shell: string;
};
export class PtyManager {
  private readonly sessions = new Map<string, Session>();
  constructor(private readonly emit: (message: unknown) => void) {
    this.ensureSpawnHelperExecutable();
  }
  private ensureSpawnHelperExecutable() {
    if (process.platform === "win32") return;
    try {
      const packageRoot = path.dirname(
        path.dirname(require.resolve("node-pty")),
      );
      const nativeDirs = [
        path.join(packageRoot, "build", "Release"),
        path.join(packageRoot, "build", "Debug"),
        path.join(
          packageRoot,
          "prebuilds",
          `${process.platform}-${process.arch}`,
        ),
      ];
      const nativeDir = nativeDirs.find((dir) =>
        fs.existsSync(path.join(dir, "pty.node")),
      );
      if (!nativeDir) return;
      const helper = path.join(nativeDir, "spawn-helper");
      const mode = fs.statSync(helper).mode;
      if (!(mode & 0o111)) fs.chmodSync(helper, mode | 0o111);
    } catch (error) {
      this.emit({
        type: "error",
        message: `Could not prepare node-pty spawn helper: ${String(error)}`,
      });
    }
  }
  start(sessionId: string, cwd?: string, profile?: string) {
    if (this.sessions.has(sessionId)) return;
    const configured = vscode.workspace
      .getConfiguration("gaogrid")
      .get<string>("defaultShell", "");
    const shell =
      profile ||
      configured ||
      (process.platform === "win32"
        ? "powershell.exe"
        : process.env.SHELL || "/bin/bash");
    const home = os.homedir();
    const workingDirectory =
      cwd && path.isAbsolute(cwd)
        ? cwd
        : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || home;
    try {
      const proc = pty.spawn(shell, [], {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd: workingDirectory,
        env: process.env as { [key: string]: string },
      });
      const session = {
        process: proc,
        cwd: workingDirectory,
        output: "",
        shell,
      };
      this.sessions.set(sessionId, session);
      proc.onData((data) => {
        session.output = (session.output + data).slice(-512_000);
        this.emit({ type: "data", sessionId, data });
      });
      proc.onExit(({ exitCode }) => {
        this.sessions.delete(sessionId);
        this.emit({ type: "exit", sessionId, exitCode });
      });
    } catch (error) {
      this.emit({ type: "error", sessionId, message: String(error) });
    }
  }
  input(sessionId: string, data: string) {
    this.sessions.get(sessionId)?.process.write(data);
  }
  quotePaths(sessionId: string, paths: string[]) {
    const session = this.sessions.get(sessionId);
    return session ? quoteShellPaths(paths, session.shell) : undefined;
  }
  output(sessionId: string) {
    return this.sessions.get(sessionId)?.output;
  }
  resize(sessionId: string, cols: number, rows: number) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    try {
      session.process.resize(Math.max(2, cols), Math.max(1, rows));
    } catch {
      /* process may be exiting */
    }
  }
  cwd(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    try {
      if (process.platform !== "win32") {
        const fs = require("fs") as typeof import("fs");
        const cwd =
          process.platform === "linux"
            ? fs.readlinkSync(`/proc/${session.process.pid}/cwd`)
            : execFileSync(
                "/usr/sbin/lsof",
                ["-a", "-p", String(session.process.pid), "-d", "cwd", "-Fn"],
                { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
              )
                .split("\n")
                .find((line) => line.startsWith("n"))
                ?.slice(1);
        if (cwd) session.cwd = cwd;
      }
    } catch {
      /* retain last known cwd */
    }
    return session.cwd;
  }
  close(sessionId: string) {
    const s = this.sessions.get(sessionId);
    if (s) {
      this.sessions.delete(sessionId);
      try {
        s.process.kill();
      } catch {
        /* already exited */
      }
    }
  }
  closeAll() {
    for (const id of this.sessions.keys()) this.close(id);
  }
}
