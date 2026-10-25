import * as pty from "node-pty";
import * as path from "path";
import * as fs from "fs";
import { quoteShellPaths } from "./shell-paths";
import { CwdResolver, resolveCwd } from "./cwd-resolver";
import {
  inspectProcesses,
  ProcessInfo,
  terminalChildren,
  remainingProcesses,
} from "./process-inspector";
import { hasActiveTask } from "./task-detector";
import { OscCwdParser } from "./osc-cwd-parser";
import type { TerminalMetadata } from "./terminal-protocol";

type Session = {
  process: pty.IPty;
  cwd: CwdResolver;
  output: string;
  shell: string;
  exited: boolean;
  closing?: Promise<void>;
};

interface PtyOptions {
  defaultShell(): string;
  defaultDirectories(): (string | undefined)[];
  environment?: NodeJS.ProcessEnv;
}

export class PtyManager {
  private readonly sessions = new Map<string, Session>();
  private readonly starting = new Map<string, Promise<void>>();
  private readonly sizes = new Map<string, { cols: number; rows: number }>();
  constructor(
    private readonly emit: (message: unknown) => void,
    private readonly options: PtyOptions,
  ) {
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
  async start(
    sessionId: string,
    cwd?: string,
    profile?: string,
    recovering = false,
  ): Promise<void> {
    if (this.sessions.has(sessionId)) return;
    const pending = this.starting.get(sessionId);
    if (pending) return pending;
    const start = this.spawn(sessionId, cwd, profile, recovering);
    this.starting.set(sessionId, start);
    try {
      await start;
    } finally {
      this.starting.delete(sessionId);
    }
  }

  private async spawn(
    sessionId: string,
    cwd?: string,
    profile?: string,
    recovering = false,
  ) {
    const shell = profile || this.options.defaultShell();
    try {
      const workingDirectory = await resolveCwd([
        cwd,
        ...this.options.defaultDirectories(),
      ]);
      const proc = pty.spawn(shell, [], {
        name: "xterm-256color",
        cols: this.sizes.get(sessionId)?.cols || 80,
        rows: this.sizes.get(sessionId)?.rows || 24,
        cwd: workingDirectory,
        // node-pty 1.x otherwise serializes undefined as the string "undefined".
        env: Object.fromEntries(
          Object.entries(this.options.environment ?? process.env).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        ),
      });
      const session: Session = {
        process: proc,
        cwd: new CwdResolver(workingDirectory),
        output: "",
        shell,
        exited: false,
      };
      this.sessions.set(sessionId, session);
      const cwdParser = new OscCwdParser((uri) => {
        session.cwd.report(uri);
        void session.cwd.refresh().then(() => this.emitMetadata(sessionId));
      });
      proc.onData((data) => {
        cwdParser.write(data);
        session.output = (session.output + data).slice(-512_000);
        this.emit({ type: "data", sessionId, data });
      });
      if (recovering) {
        const data = `\r\n[GaoGrid] Previous Direct Session ended. A new shell was started in:\r\n${workingDirectory}\r\n\r\n`;
        session.output = data;
        this.emit({ type: "data", sessionId, data });
      }
      this.emitMetadata(sessionId);
      proc.onExit(({ exitCode }) => {
        session.exited = true;
        session.output = (
          session.output + `\r\n[process exited: ${exitCode}]\r\n`
        ).slice(-512_000);
        this.emit({ type: "exit", sessionId, exitCode });
      });
    } catch (error) {
      this.emit({ type: "error", sessionId, message: String(error) });
    }
  }
  input(sessionId: string, data: string) {
    const session = this.sessions.get(sessionId);
    if (session && !session.exited && !session.closing)
      session.process.write(data);
  }
  quotePaths(sessionId: string, paths: string[]) {
    const session = this.sessions.get(sessionId);
    return session ? quoteShellPaths(paths, session.shell) : undefined;
  }
  output(sessionId: string) {
    return this.sessions.get(sessionId)?.output;
  }
  resize(sessionId: string, cols: number, rows: number) {
    cols = Math.max(2, Math.floor(cols));
    rows = Math.max(1, Math.floor(rows));
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
    this.sizes.set(sessionId, { cols, rows });
    const session = this.sessions.get(sessionId);
    if (!session || session.exited || session.closing) return;
    try {
      session.process.resize(cols, rows);
    } catch {
      /* process may be exiting */
    }
  }
  async cwd(sessionId: string) {
    await this.starting.get(sessionId);
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const cwd = await session.cwd.refresh(
      session.exited ? undefined : session.process.pid,
    );
    this.emitMetadata(sessionId);
    return cwd;
  }

  metadata(sessionId: string): TerminalMetadata | undefined {
    const session = this.sessions.get(sessionId);
    if (session) return { cwd: session.cwd.cwd, profile: session.shell };
  }

  private emitMetadata(sessionId: string) {
    const metadata = this.metadata(sessionId);
    if (metadata) this.emit({ type: "metadata", sessionId, ...metadata });
  }

  lastCwd(sessionId: string) {
    return this.sessions.get(sessionId)?.cwd.cwd;
  }

  async activeTasks(sessionIds: string[]) {
    await Promise.all(sessionIds.map((id) => this.starting.get(id)));
    const processes = await inspectProcesses();
    const active = new Set<string>();
    for (const id of sessionIds) {
      const session = this.sessions.get(id);
      if (
        session &&
        !session.exited &&
        processes &&
        hasActiveTask(processes, session.process.pid, session.shell)
      )
        active.add(id);
    }
    return active;
  }

  async closeSessions(sessionIds: string[]) {
    await Promise.all(sessionIds.map((id) => this.starting.get(id)));
    const processes = await inspectProcesses();
    await Promise.all(sessionIds.map((id) => this.close(id, processes)));
  }

  private async close(sessionId: string, processes?: ProcessInfo[]) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.closing) return session.closing;
    const closing = this.terminate(session, processes);
    session.closing = closing;
    try {
      await closing;
      this.sessions.delete(sessionId);
      this.sizes.delete(sessionId);
    } catch (error) {
      session.closing = undefined;
      throw error;
    }
  }

  private async terminate(session: Session, processes?: ProcessInfo[]) {
    if (session.exited) return;
    if (process.platform === "win32") {
      session.process.kill();
      return;
    }
    const root = processes?.find((entry) => entry.pid === session.process.pid);
    const known = root ? [root, ...terminalChildren(processes!, root.pid)] : [];
    // Let the shell's normal hangup handling finish its jobs before intervening.
    session.process.kill("SIGHUP");
    const deadline = Date.now() + 250;
    while (
      Date.now() < deadline &&
      (!session.exited || known.some((entry) => alive(entry.pid)))
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const current = await inspectProcesses();
    if (!root || !current) {
      // Without an inspectable snapshot, only the PTY's own child is ours to kill.
      if (!session.exited) session.process.kill("SIGKILL");
      return;
    }
    if (remainingProcesses([root], current).length)
      known.push(...terminalChildren(current, root.pid));
    const remaining = remainingProcesses(known, current);
    for (const entry of [...remaining].reverse()) signal(entry.pid, "SIGTERM");
    if (!remaining.length) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
    const final = await inspectProcesses();
    if (final)
      for (const entry of remainingProcesses(remaining, final).reverse())
        signal(entry.pid, "SIGKILL");
  }

  async closeAll() {
    await this.closeSessions([
      ...new Set([...this.sessions.keys(), ...this.starting.keys()]),
    ]);
  }
}

function signal(pid: number, value: NodeJS.Signals) {
  try {
    process.kill(pid, value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
