import * as pty from "node-pty";
import * as path from "path";
import * as fs from "fs";
import { quoteShellPaths } from "./shell-paths";
import { CwdResolver, resolveCwd, validDirectory } from "./cwd-resolver";
import {
  inspectProcesses,
  ProcessInfo,
  terminalChildren,
  remainingProcesses,
} from "./process-inspector";
import { hasActiveTask } from "./task-detector";
import { OscCwdParser } from "./osc-cwd-parser";
import { TerminalHistory, type OutputSnapshot } from "./terminal-history";
import type { TerminalOutputStore } from "./terminal-output-store";
import { TmuxBackend } from "./tmux-backend";
import type { TerminalMetadata, BackendOptions } from "./terminal-protocol";

type Session = {
  process: pty.IPty;
  cwd: CwdResolver;
  output: string;
  shell: string;
  exited: boolean;
  inputRevision: number;
  deferredInput?: string[];
  closing?: Promise<void>;
  history: TerminalHistory;
  checkpointTimer?: ReturnType<typeof setTimeout>;
  checkpoint?: Promise<void>;
};
interface PtyOptions {
  defaultShell(): string;
  defaultDirectories(): (string | undefined)[];
  environment?: NodeJS.ProcessEnv;
  tmuxConfigPath?: string;
  outputStore?: TerminalOutputStore;
  log?(message: string): void;
}

export class PtyManager {
  private readonly sessions = new Map<string, Session>();
  private readonly starting = new Map<string, Promise<void>>();
  private readonly promoting = new Map<
    string,
    Promise<TerminalMetadata | undefined>
  >();
  private readonly backends = new Map<string, TerminalMetadata>();
  private readonly recoveryOutput = new Map<string, string>();
  private readonly initialOutput = new Map<string, string>();
  private readonly sizes = new Map<string, { cols: number; rows: number }>();
  private stopping = false;
  readonly tmux: TmuxBackend;
  constructor(
    private readonly emit: (message: unknown) => void,
    private readonly options: PtyOptions,
  ) {
    this.tmux = new TmuxBackend(
      options.tmuxConfigPath || path.join(__dirname, "../media/tmux.conf"),
      options.environment,
    );
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
    backend: BackendOptions = {},
  ): Promise<void> {
    const existing = this.sessions.get(sessionId);
    if (
      existing &&
      (!existing.exited || this.backends.get(sessionId)?.backend !== "tmux")
    )
      return;
    const pending = this.starting.get(sessionId);
    if (pending) return pending;
    const start = this.spawn(sessionId, cwd, profile, recovering, backend);
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
    backend: BackendOptions = {},
  ) {
    const previous = this.backends.get(sessionId);
    const shell = profile || previous?.profile || this.options.defaultShell();
    const metadata: TerminalMetadata = {
      cwd: cwd || previous?.cwd || "",
      profile: shell,
      backend:
        previous?.backend === "tmux" ? "tmux" : backend.backend || "direct",
      backendSessionId: backend.backendSessionId || previous?.backendSessionId,
      createdAt: backend.createdAt || previous?.createdAt || Date.now(),
      updatedAt: Date.now(),
      connectionState: "disconnected",
    };
    this.backends.set(sessionId, metadata);
    try {
      let prefix = this.initialOutput.get(sessionId) || "";
      let pane;
      if (
        recovering &&
        metadata.backend === "direct" &&
        this.options.outputStore
      ) {
        const saved = await this.options.outputStore
          .read(sessionId)
          .catch((error) => {
            this.options.log?.(
              `Could not read terminal output: ${String(error)}`,
            );
            return undefined;
          });
        if (saved) {
          prefix = saved.data + "\x1b[0m";
          if (!this.sizes.has(sessionId))
            this.sizes.set(sessionId, { cols: saved.cols, rows: saved.rows });
        }
      }
      if (metadata.backend === "tmux") {
        if (!(await this.tmux.capabilities()).tmux.available)
          throw new Error(
            "tmux is unavailable. Protected session metadata was retained; right-click the tab to retry.",
          );
        if (metadata.backendSessionId)
          pane = await this.tmux.inspect(metadata.backendSessionId);
      }
      const workingDirectory = await resolveCwd([
        pane?.cwd,
        metadata.cwd,
        ...this.options.defaultDirectories(),
      ]);
      metadata.cwd = workingDirectory;
      const size = this.sizes.get(sessionId) || { cols: 80, rows: 24 };
      if (metadata.backend === "tmux") {
        if (!pane) {
          const missing = !!metadata.backendSessionId;
          metadata.backendSessionId = await this.tmux.create(
            workingDirectory,
            shell,
            size.cols,
            size.rows,
          );
          if (missing) {
            prefix =
              `[GaoGrid] Protected session is no longer available.\r\nA new shell was started in:\r\n${workingDirectory}\r\n` +
              "\r\n".repeat(size.rows);
            this.emit({
              type: "notice",
              sessionId,
              message: `Protected session is no longer available. A new shell was started in: ${workingDirectory}`,
            });
          }
        } else
          prefix = await this.tmux.history(
            metadata.backendSessionId!,
            size.rows,
          );
        if (pane) await this.tmux.configure();
        // Persist a newly created session even if the attach client subsequently fails.
        this.emitMetadata(sessionId);
      } else if (recovering)
        prefix += `\r\n[GaoGrid] Previous Direct Session ended. A new shell was started in:\r\n${workingDirectory}\r\n\r\n`;
      const session = this.spawnClient(
        sessionId,
        workingDirectory,
        shell,
        metadata.backendSessionId,
        prefix,
      );
      if (metadata.backend === "tmux")
        await this.waitForAttach(metadata.backendSessionId!, session);
      this.sessions.set(sessionId, session);
      this.initialOutput.delete(sessionId);
      this.recoveryOutput.delete(sessionId);
      const currentSize = this.sizes.get(sessionId) || size;
      this.resize(sessionId, currentSize.cols, currentSize.rows);
      metadata.connectionState = "connected";
      this.emitMetadata(sessionId);
      if (metadata.backend === "tmux") this.emit({ type: "reset", sessionId });
      if (session.output)
        this.emit({ type: "data", sessionId, data: session.output });
      this.scheduleCheckpoint(sessionId, session);
    } catch (error) {
      metadata.connectionState = "disconnected";
      this.emitMetadata(sessionId);
      const message = `[GaoGrid] ${String(error)}${metadata.backend === "tmux" ? " Right-click the tab to reconnect." : ""}`;
      this.recoveryOutput.set(sessionId, `\r\n${message}\r\n`);
      this.emit({ type: "error", sessionId, message });
    }
  }

  private spawnClient(
    sessionId: string,
    cwd: string,
    shell: string,
    tmuxId?: string,
    output = "",
  ): Session {
    const size = this.sizes.get(sessionId) || { cols: 80, rows: 24 };
    const environment = tmuxId
      ? this.tmux.environment
      : (this.options.environment ?? process.env);
    const proc = pty.spawn(
      tmuxId ? "tmux" : shell,
      tmuxId ? this.tmux.attachArgs(tmuxId) : [],
      {
        name: "xterm-256color",
        ...size,
        cwd,
        env: Object.fromEntries(
          Object.entries(environment).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        ),
      },
    );
    const session: Session = {
      process: proc,
      cwd: new CwdResolver(cwd),
      output,
      shell,
      exited: false,
      inputRevision: 0,
      history: new TerminalHistory(size.cols, size.rows),
    };
    session.history.write(output);
    const current = () => this.sessions.get(sessionId) === session;
    const cwdParser = new OscCwdParser((uri) => {
      session.cwd.report(uri);
      if (!tmuxId)
        void session.cwd.refresh().then(() => {
          if (current()) this.emitMetadata(sessionId);
        });
    });
    proc.onData((data) => {
      cwdParser.write(data);
      session.output = (session.output + data).slice(-2_000_000);
      const publish = current();
      session.history.write(data, () => {
        if (publish && current()) {
          this.emit({ type: "data", sessionId, data });
          this.scheduleCheckpoint(sessionId, session);
        }
      });
    });
    proc.onExit(({ exitCode }) => {
      session.exited = true;
      const message = tmuxId
        ? "[GaoGrid] Protected session disconnected. Right-click the tab to reconnect."
        : `[process exited: ${exitCode}]`;
      const publish = current();
      session.history.write(`\r\n${message}\r\n`, () => {
        if (publish && current()) {
          this.emit({ type: "data", sessionId, data: `\r\n${message}\r\n` });
          this.scheduleCheckpoint(sessionId, session);
        }
      });
      session.output = (session.output + `\r\n${message}\r\n`).slice(
        -2_000_000,
      );
      if (current()) {
        const metadata = this.backends.get(sessionId);
        if (metadata) metadata.connectionState = "disconnected";
        this.emitMetadata(sessionId);
      }
    });
    return session;
  }

  private async waitForAttach(id: string, session: Session) {
    try {
      const deadline = Date.now() + 2500;
      while (!session.exited && Date.now() < deadline) {
        if (await this.tmux.attached(id, session.process.pid)) return;
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      throw new Error(
        `Could not attach to protected session. ${session.output.trim()}`,
      );
    } catch (error) {
      if (!session.exited) session.process.kill();
      session.history.dispose();
      throw error;
    }
  }

  promote(sessionId: string): Promise<TerminalMetadata | undefined> {
    const pending = this.promoting.get(sessionId);
    if (pending) return pending;
    const promotion = this.promoteIdle(sessionId);
    this.promoting.set(sessionId, promotion);
    void promotion
      .finally(() => this.promoting.delete(sessionId))
      .catch(() => {});
    return promotion;
  }

  private async idle(session: Session) {
    const processes = await inspectProcesses();
    const root = processes?.find((item) => item.pid === session.process.pid);
    const shell = path.basename(session.shell).replace(/\.exe$/i, "");
    return (
      !session.exited &&
      !!root &&
      ["zsh", "bash", "fish", "sh", "dash", "ksh", "tcsh", "csh"].includes(
        shell,
      ) &&
      !hasActiveTask(processes!, session.process.pid, session.shell)
    );
  }

  private async promoteIdle(
    sessionId: string,
  ): Promise<TerminalMetadata | undefined> {
    await this.starting.get(sessionId);
    if (this.backends.get(sessionId)?.backend === "tmux")
      return this.metadata(sessionId);
    const original = this.sessions.get(sessionId);
    if (!original || original.closing || !(await this.idle(original))) return;
    if (!(await this.tmux.capabilities()).tmux.available)
      throw new Error("tmux is unavailable.");
    const revision = original.inputRevision;
    const cwd = (await this.cwd(sessionId)) || original.cwd.cwd;
    const size = this.sizes.get(sessionId) || { cols: 80, rows: 24 };
    let id: string | undefined;
    let candidate: Session | undefined;
    let switched = false;
    try {
      id = await this.tmux.create(cwd, original.shell, size.cols, size.rows);
      candidate = this.spawnClient(sessionId, cwd, original.shell, id);
      await this.waitForAttach(id, candidate);
      // Buffer keystrokes during the final check; never lose input or migrate a task.
      original.deferredInput = [];
      if (!(await this.idle(original)) || original.inputRevision !== revision)
        return;
      const previousScreen = await original.history.snapshot();
      // A new tmux client enters the alternate screen. Keep its initial shell
      // redraw in the existing main buffer so Direct-session scrollback remains
      // visible above it. Later application alternate-screen changes pass through.
      candidate.output = candidate.output.replace("\x1b[?1049h", "");
      candidate.history.dispose();
      candidate.history = new TerminalHistory(
        previousScreen.cols,
        previousScreen.rows,
      );
      candidate.history.write(previousScreen.data);
      candidate.history.write(candidate.output);
      this.sessions.set(sessionId, candidate);
      this.backends.set(sessionId, {
        cwd,
        profile: original.shell,
        backend: "tmux",
        backendSessionId: id,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        connectionState: "connected",
      });
      switched = true;
      const currentSize = this.sizes.get(sessionId) || size;
      this.resize(sessionId, currentSize.cols, currentSize.rows);
      const data = candidate.output;
      candidate.output = (original.output + data).slice(-2_000_000);
      this.emitMetadata(sessionId);
      if (data) this.emit({ type: "data", sessionId, data });
      await this.terminate(original, await inspectProcesses());
      if (original.checkpointTimer) clearTimeout(original.checkpointTimer);
      await original.checkpoint;
      original.history.dispose();
      await this.options.outputStore?.remove(sessionId);
      return this.metadata(sessionId);
    } finally {
      const input = original.deferredInput;
      original.deferredInput = undefined;
      if (!switched) {
        if (candidate && !candidate.exited) candidate.process.kill();
        candidate?.history.dispose();
        if (id) await this.tmux.destroy(id);
      }
      for (const data of input || []) this.input(sessionId, data);
    }
  }

  input(sessionId: string, data: string) {
    const session = this.sessions.get(sessionId);
    if (!session || session.exited || session.closing) return;
    session.inputRevision++;
    if (session.deferredInput) session.deferredInput.push(data);
    else session.process.write(data);
  }
  quotePaths(sessionId: string, paths: string[]) {
    const shell = this.metadata(sessionId)?.profile;
    return shell ? quoteShellPaths(paths, shell) : undefined;
  }
  output(sessionId: string) {
    return (
      this.recoveryOutput.get(sessionId) || this.sessions.get(sessionId)?.output
    );
  }
  async replay(
    sessionId: string,
    consume?: (snapshot: OutputSnapshot) => void,
  ): Promise<OutputSnapshot | undefined> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    return session.history.snapshot(consume, true);
  }

  private scheduleCheckpoint(sessionId: string, session: Session) {
    if (
      !this.options.outputStore ||
      this.stopping ||
      session.closing ||
      session.checkpointTimer ||
      this.backends.get(sessionId)?.backend !== "direct"
    )
      return;
    session.checkpointTimer = setTimeout(() => {
      session.checkpointTimer = undefined;
      session.checkpoint = this.saveOutput(sessionId, session);
    }, 500);
  }

  private async saveOutput(sessionId: string, session: Session) {
    try {
      const snapshot = await session.history.snapshot();
      if (this.backends.get(sessionId)?.backend === "direct")
        await this.options.outputStore?.save(sessionId, snapshot);
    } catch (error) {
      this.options.log?.(`Could not save terminal output: ${String(error)}`);
    }
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
      void session.history.resize(cols, rows);
    } catch {
      /* process may be exiting */
    }
  }
  async cwd(sessionId: string) {
    await this.starting.get(sessionId);
    const session = this.sessions.get(sessionId);
    const metadata = this.backends.get(sessionId);
    if (metadata?.backend === "tmux" && metadata.backendSessionId) {
      const pane = await this.tmux.inspect(metadata.backendSessionId);
      const cwd = await validDirectory(pane?.cwd);
      if (cwd) {
        metadata.cwd = cwd;
        if (session) session.cwd.cwd = cwd;
      }
    } else if (session) {
      const cwd = await session.cwd.refresh(
        session.exited ? undefined : session.process.pid,
      );
      if (cwd && metadata) metadata.cwd = cwd;
    }
    this.emitMetadata(sessionId);
    return metadata?.cwd;
  }
  metadata(sessionId: string): TerminalMetadata | undefined {
    const metadata = this.backends.get(sessionId);
    if (!metadata) return;
    const cwd = this.sessions.get(sessionId)?.cwd.cwd || metadata.cwd;
    if (cwd !== metadata.cwd) {
      metadata.cwd = cwd;
      metadata.updatedAt = Date.now();
    }
    return { ...metadata };
  }
  private emitMetadata(sessionId: string) {
    const metadata = this.metadata(sessionId);
    if (metadata) this.emit({ type: "metadata", sessionId, ...metadata });
  }
  lastCwd(sessionId: string) {
    return this.metadata(sessionId)?.cwd;
  }

  async activeTasks(sessionIds: string[]) {
    await Promise.all(sessionIds.map((id) => this.starting.get(id)));
    const processes = await inspectProcesses();
    const active = new Set<string>();
    await Promise.all(
      sessionIds.map(async (id) => {
        const session = this.sessions.get(id);
        const metadata = this.backends.get(id);
        if (metadata?.backend === "tmux" && metadata.backendSessionId) {
          const pane = await this.tmux.inspect(metadata.backendSessionId);
          if (
            pane &&
            (!processes ||
              !processes.some((item) => item.pid === pane.pid) ||
              hasActiveTask(processes, pane.pid, metadata.profile))
          )
            active.add(id);
        } else if (
          session &&
          !session.exited &&
          processes &&
          hasActiveTask(processes, session.process.pid, session.shell)
        )
          active.add(id);
      }),
    );
    return active;
  }

  async closeSessions(sessionIds: string[]) {
    await Promise.all(sessionIds.map((id) => this.promoting.get(id)));
    await Promise.all(sessionIds.map((id) => this.starting.get(id)));
    const processes = await inspectProcesses();
    await Promise.all(sessionIds.map((id) => this.close(id, processes)));
  }

  /** Explicitly destroys a protected session and replaces it with a fresh direct shell. */
  async unprotect(sessionId: string): Promise<TerminalMetadata | undefined> {
    const metadata = this.backends.get(sessionId);
    if (metadata?.backend !== "tmux")
      throw new Error("Terminal is not a protected session.");
    if ((await this.activeTasks([sessionId])).has(sessionId))
      throw new Error(
        "Cannot remove protection while a task is running. Wait until the terminal returns to the shell prompt.",
      );
    const session = this.sessions.get(sessionId);
    const currentSize = this.sizes.get(sessionId) || { cols: 80, rows: 24 };
    let preservedSnapshot: OutputSnapshot;
    if (session && !session.exited)
      preservedSnapshot = await session.history.snapshot();
    else {
      const history = new TerminalHistory(currentSize.cols, currentSize.rows);
      try {
        history.write(await this.tmux.capture(metadata.backendSessionId!));
        preservedSnapshot = await history.snapshot();
      } finally {
        history.dispose();
      }
    }
    const cwd = (await this.cwd(sessionId)) || metadata.cwd;
    const profile = metadata.profile;
    const size = this.sizes.get(sessionId);
    await this.closeSessions([sessionId]);
    this.sizes.set(sessionId, size || currentSize);
    this.initialOutput.set(sessionId, preservedSnapshot.data);
    try {
      await this.options.outputStore?.save(sessionId, preservedSnapshot);
    } catch (error) {
      this.options.log?.(
        `Could not preserve output while removing protection: ${String(error)}`,
      );
    }
    this.emit({ type: "reset", sessionId });
    await this.start(sessionId, cwd, profile, false, { backend: "direct" });
    return this.metadata(sessionId);
  }
  private async close(sessionId: string, processes?: ProcessInfo[]) {
    const session = this.sessions.get(sessionId);
    if (session?.closing) return session.closing;
    const closing = (async () => {
      const metadata = this.backends.get(sessionId);
      if (metadata?.backend === "tmux" && metadata.backendSessionId) {
        const pane = await this.tmux.inspect(metadata.backendSessionId);
        const root = processes?.find((entry) => entry.pid === pane?.pid);
        const known = root
          ? [root, ...terminalChildren(processes!, root.pid)]
          : [];
        await this.tmux.destroy(metadata.backendSessionId);
        await this.cleanup(known);
      }
      if (session) {
        if (session.checkpointTimer) clearTimeout(session.checkpointTimer);
        await this.terminate(session, processes);
        await session.checkpoint;
        session.history.dispose();
      }
      await this.options.outputStore?.remove(sessionId);
      this.sessions.delete(sessionId);
      this.backends.delete(sessionId);
      this.recoveryOutput.delete(sessionId);
      this.sizes.delete(sessionId);
    })();
    if (session) session.closing = closing;
    try {
      await closing;
    } catch (error) {
      if (session) session.closing = undefined;
      throw error;
    }
  }
  private async cleanup(known: ProcessInfo[]) {
    if (!known.length) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
    const current = await inspectProcesses();
    if (!current) return;
    const remaining = remainingProcesses(known, current);
    for (const entry of remaining.reverse()) signal(entry.pid, "SIGTERM");
    if (!remaining.length) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
    const final = await inspectProcesses();
    if (final)
      for (const entry of remainingProcesses(remaining, final).reverse())
        signal(entry.pid, "SIGKILL");
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
      ...new Set([...this.backends.keys(), ...this.starting.keys()]),
    ]);
  }

  async settle() {
    await Promise.allSettled([
      ...this.starting.values(),
      ...this.promoting.values(),
    ]);
  }

  /** VS Code shutdown detaches protected clients, without invoking user-close logic. */
  async shutdown() {
    this.stopping = true;
    await this.settle();
    const processes = await inspectProcesses();
    await Promise.all(
      [...this.sessions].map(async ([id, session]) => {
        if (session.checkpointTimer) clearTimeout(session.checkpointTimer);
        await session.checkpoint;
        if (this.backends.get(id)?.backend === "direct") {
          await this.terminate(session, processes);
          await this.saveOutput(id, session);
        } else if (!session.exited) session.process.kill();
        session.history.dispose();
      }),
    );
    this.sessions.clear();
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
