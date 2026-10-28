import * as pty from "node-pty";
import * as path from "path";
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
import {
  TerminalOutputBudget,
  TerminalOutputFlow,
} from "./terminal-output-flow";
import type { TerminalOutputStore } from "./terminal-output-store";
import { TmuxBackend, type TmuxPane } from "./tmux-backend";
import { TmuxControlProcess, type TmuxControlOptions } from "./tmux-control";
import {
  normalizeTerminalColors,
  type TerminalDefaultColors,
} from "./terminal-colors";
import type {
  TerminalMetadata,
  TerminalTransport,
  BackendOptions,
} from "./terminal-protocol";
import {
  OUTPUT_CHECKPOINT_INTERVAL_MS,
  OUTPUT_HIGH_WATERMARK,
  OUTPUT_LOW_WATERMARK,
  DIAGNOSTIC_OUTPUT_CHARS,
} from "./terminal-constants";

type TerminalProcess = Pick<
  pty.IPty,
  "pid" | "onData" | "onExit" | "write" | "resize" | "pause" | "resume" | "kill"
> & {
  readonly ready?: Promise<void>;
  setDefaultColors?(colors: TerminalDefaultColors): void;
};

type Session = {
  process: TerminalProcess;
  cwd: CwdResolver;
  output: string;
  shell: string;
  transport?: TerminalTransport;
  exited: boolean;
  inputRevision: number;
  deferredInput?: { data: string; binary: boolean }[];
  closing?: Promise<void>;
  history: TerminalHistory;
  flow: TerminalOutputFlow;
  checkpointTimer?: ReturnType<typeof setTimeout>;
  checkpoint?: Promise<void>;
};
interface PtyOptions {
  defaultShell(): string;
  defaultDirectories(): (string | undefined)[];
  environment?: NodeJS.ProcessEnv;
  tmuxConfigPath?: string;
  outputStore?: TerminalOutputStore;
  outputHighWatermark?: number;
  outputLowWatermark?: number;
  checkpointIntervalMs?: number;
  tmuxMouse?: boolean;
  tmuxBackend?: TmuxBackend;
  controlProcessFactory?: (options: TmuxControlOptions) => TerminalProcess;
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
  private readonly truncationNotified = new Set<string>();
  private readonly initialOutput = new Map<string, string>();
  private readonly sizes = new Map<string, { cols: number; rows: number }>();
  private readonly outputBudget = new TerminalOutputBudget();
  private stopping = false;
  private tmuxMouse: boolean;
  private defaultColors?: TerminalDefaultColors;
  readonly tmux: TmuxBackend;
  constructor(
    private readonly emit: (message: unknown) => void,
    private readonly options: PtyOptions,
  ) {
    this.tmux =
      options.tmuxBackend ||
      new TmuxBackend(
        options.tmuxConfigPath ||
          path.join(__dirname, "../resources/tmux.conf"),
        options.environment,
      );
    this.tmuxMouse = options.tmuxMouse ?? true;
  }

  async setTmuxMouse(enabled: boolean) {
    this.tmuxMouse = enabled;
    await Promise.all(
      [...this.backends.values()].map(async (metadata) => {
        if (metadata.backend !== "tmux" || !metadata.backendSessionId) return;
        try {
          await this.tmux.configureMouse(metadata.backendSessionId, enabled);
        } catch (error) {
          this.options.log?.(
            `Could not update tmux mouse for ${metadata.backendSessionId}: ${String(error)}`,
          );
        }
      }),
    );
  }
  setDefaultColors(value: unknown) {
    const colors = normalizeTerminalColors(value);
    if (
      !colors ||
      (colors.foreground === this.defaultColors?.foreground &&
        colors.background === this.defaultColors?.background)
    )
      return;
    this.defaultColors = colors;
    for (const session of this.sessions.values()) {
      if (!session.exited && !session.closing)
        session.process.setDefaultColors?.(colors);
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
      transport:
        backend.transport ||
        previous?.transport ||
        (backend.backend === "tmux" ||
        (previous?.backend === "tmux" && !backend.backend)
          ? "control"
          : undefined),
      degraded: previous?.degraded,
      createdAt: backend.createdAt || previous?.createdAt || Date.now(),
      updatedAt: Date.now(),
      connectionState: "disconnected",
    };
    this.backends.set(sessionId, metadata);
    let controlStarted = false;
    let workingDirectory = metadata.cwd;
    let size = this.sizes.get(sessionId) || { cols: 80, rows: 24 };
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
        const capabilities = (await this.tmux.capabilities()).tmux;
        if (!capabilities.available || capabilities.supported === false)
          throw new Error(
            "tmux 3.2a or newer is required. Protected session metadata was retained; right-click the tab to retry.",
          );
        if (metadata.backendSessionId)
          pane = await this.tmux.inspect(metadata.backendSessionId);
      }
      workingDirectory = await resolveCwd([
        pane?.cwd,
        metadata.cwd,
        ...this.options.defaultDirectories(),
      ]);
      metadata.cwd = workingDirectory;
      size = this.sizes.get(sessionId) || { cols: 80, rows: 24 };
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
        }
        if (pane) await this.tmux.configure();
        await this.tmux.configureMouse(
          metadata.backendSessionId!,
          this.tmuxMouse,
        );
        if (pane && metadata.transport === "attach")
          prefix = await this.tmux.history(
            metadata.backendSessionId!,
            size.rows,
          );
        // Persist a newly created session even if the attach client subsequently fails.
        this.emitMetadata(sessionId);
      } else if (recovering)
        prefix += `\r\n[GaoGrid] Previous Direct Session ended. A new shell was started in:\r\n${workingDirectory}\r\n\r\n`;
      controlStarted =
        metadata.backend === "tmux" && metadata.transport === "control";
      const session = this.spawnClient(
        sessionId,
        workingDirectory,
        shell,
        metadata.backendSessionId,
        metadata.transport,
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
      if (prefix || metadata.backend === "tmux")
        this.emit({ type: "reset", sessionId });
      this.scheduleCheckpoint(sessionId, session);
    } catch (error) {
      if (
        controlStarted &&
        metadata.backend === "tmux" &&
        metadata.backendSessionId
      ) {
        try {
          await this.startAttachFallback(
            sessionId,
            metadata,
            workingDirectory,
            shell,
            size,
          );
          return;
        } catch (fallbackError) {
          this.emit({
            type: "error",
            sessionId,
            message: String(fallbackError),
          });
        }
      }
      metadata.connectionState = "disconnected";
      metadata.displayState = "failed";
      this.emitMetadata(sessionId);
      const message = `[GaoGrid] ${String(error)}${metadata.backend === "tmux" ? " Right-click the tab to reconnect." : ""}`;
      this.recoveryOutput.set(sessionId, `\r\n${message}\r\n`);
      this.emit({ type: "error", sessionId, message });
    }
  }

  private async startAttachFallback(
    sessionId: string,
    metadata: TerminalMetadata,
    cwd: string,
    shell: string,
    size: { cols: number; rows: number },
  ) {
    const id = metadata.backendSessionId!;
    if (!(await this.tmux.inspect(id)))
      throw new Error("Protected session is no longer available.");
    await this.tmux.configureMouse(id, this.tmuxMouse);
    const prefix = await this.tmux.history(id, size.rows);
    const session = this.spawnClient(
      sessionId,
      cwd,
      shell,
      id,
      "attach",
      prefix,
    );
    try {
      await this.waitForAttach(id, session);
    } catch (error) {
      if (!session.exited) session.process.kill();
      session.history.dispose();
      session.flow.dispose();
      throw error;
    }
    this.sessions.set(sessionId, session);
    metadata.transport = "attach";
    metadata.degraded = true;
    metadata.displayState = undefined;
    metadata.connectionState = "connected";
    metadata.updatedAt = Date.now();
    this.recoveryOutput.delete(sessionId);
    this.emitMetadata(sessionId);
    this.emit({ type: "reset", sessionId });
    this.scheduleCheckpoint(sessionId, session);
  }

  private spawnClient(
    sessionId: string,
    cwd: string,
    shell: string,
    tmuxId?: string,
    transport: TerminalTransport = "control",
    output = "",
  ): Session {
    const size = this.sizes.get(sessionId) || { cols: 80, rows: 24 };
    const environment = tmuxId
      ? this.tmux.environment
      : (this.options.environment ?? process.env);
    const env = Object.fromEntries(
      Object.entries(environment).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    const controlOptions: TmuxControlOptions | undefined =
      tmuxId && transport === "control"
        ? {
            args: this.tmux.controlArgs(tmuxId),
            target: this.tmux.controlTarget(tmuxId),
            cwd,
            env,
            ...size,
            defaultColors: this.defaultColors,
            colorReports: this.tmux.supportsColorReports,
          }
        : undefined;
    const proc: TerminalProcess = controlOptions
      ? (this.options.controlProcessFactory?.(controlOptions) ??
        new TmuxControlProcess(controlOptions))
      : pty.spawn(
          tmuxId ? "tmux" : shell,
          tmuxId ? this.tmux.attachArgs(tmuxId) : [],
          {
            name: "xterm-256color",
            ...size,
            cwd,
            env,
          },
        );
    const session: Session = {
      process: proc,
      cwd: new CwdResolver(cwd),
      output,
      shell,
      transport: tmuxId ? transport : undefined,
      exited: false,
      inputRevision: 0,
      history: new TerminalHistory(size.cols, size.rows),
      flow: new TerminalOutputFlow(
        sessionId,
        () => proc.pause(),
        () => proc.resume(),
        this.outputBudget,
        {
          high: this.options.outputHighWatermark || OUTPUT_HIGH_WATERMARK,
          low: this.options.outputLowWatermark || OUTPUT_LOW_WATERMARK,
        },
      ),
    };
    session.flow.queued(output.length);
    session.history.write(output, () => session.flow.parsed(output.length));
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
      session.output = (session.output + data).slice(-DIAGNOSTIC_OUTPUT_CHARS);
      const publish = current();
      session.flow.queued(data.length);
      session.history.write(data, () => {
        try {
          if (publish && current()) {
            this.emit({ type: "data", sessionId, data });
            this.scheduleCheckpoint(sessionId, session);
          }
        } finally {
          session.flow.parsed(data.length);
        }
      });
    });
    proc.onExit(() => {
      session.exited = true;
      if (session.closing || this.stopping) return;
      if (tmuxId) {
        void this.reconcileProtectedExit(sessionId, session, tmuxId);
        return;
      }
      void this.finishEndedSession(sessionId, session);
    });
    return session;
  }

  private async reconcileProtectedExit(
    sessionId: string,
    session: Session,
    backendSessionId: string,
  ) {
    const current = () => this.sessions.get(sessionId) === session;
    let pane: TmuxPane | undefined;
    try {
      pane = await this.tmux.inspect(backendSessionId);
    } catch (error) {
      this.options.log?.(
        `Could not inspect protected session after exit: ${String(error)}`,
      );
      if (current() && !session.closing && !this.stopping) {
        this.writeExitNotice(
          sessionId,
          session,
          "[GaoGrid] Protected session disconnected. Right-click the tab to reconnect.",
        );
        const metadata = this.backends.get(sessionId);
        if (metadata) metadata.connectionState = "disconnected";
        this.emitMetadata(sessionId);
      }
      return;
    }
    if (!current() || session.closing || this.stopping) return;
    if (pane) {
      this.writeExitNotice(
        sessionId,
        session,
        "[GaoGrid] Protected session disconnected. Right-click the tab to reconnect.",
      );
      const metadata = this.backends.get(sessionId);
      if (metadata) metadata.connectionState = "disconnected";
      this.emitMetadata(sessionId);
      return;
    }

    await this.finishEndedSession(sessionId, session);
  }

  private async finishEndedSession(sessionId: string, session: Session) {
    const current = () => this.sessions.get(sessionId) === session;
    if (!current() || session.closing || this.stopping) return;
    if (session.checkpointTimer) clearTimeout(session.checkpointTimer);
    await session.checkpoint;
    if (!current() || session.closing || this.stopping) return;
    session.history.dispose();
    session.flow.dispose();
    this.sessions.delete(sessionId);
    this.backends.delete(sessionId);
    this.recoveryOutput.delete(sessionId);
    this.truncationNotified.delete(sessionId);
    this.initialOutput.delete(sessionId);
    this.sizes.delete(sessionId);
    try {
      await this.options.outputStore?.remove(sessionId);
    } catch (error) {
      this.options.log?.(
        `Could not remove ended session output: ${String(error)}`,
      );
    }
    if (!this.stopping) this.emit({ type: "sessionEnded", sessionId });
  }

  private writeExitNotice(
    sessionId: string,
    session: Session,
    message: string,
  ) {
    const current = () => this.sessions.get(sessionId) === session;
    const publish = current();
    session.history.write(`\r\n${message}\r\n`, () => {
      if (publish && current()) {
        this.emit({ type: "data", sessionId, data: `\r\n${message}\r\n` });
        this.scheduleCheckpoint(sessionId, session);
      }
    });
    session.output = (session.output + `\r\n${message}\r\n`).slice(
      -DIAGNOSTIC_OUTPUT_CHARS,
    );
  }

  private async waitForAttach(id: string, session: Session) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = Date.now() + 30_000;
      if (session.process.ready)
        await Promise.race([
          session.process.ready,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error("Protected terminal initialization timed out."),
                ),
              30_000,
            );
          }),
        ]);
      if (this.defaultColors)
        session.process.setDefaultColors?.(this.defaultColors);
      while (!session.exited && Date.now() < deadline) {
        if (await this.tmux.attached(id, session.process.pid)) return;
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      throw new Error("Could not attach to protected session.");
    } catch (error) {
      if (!session.exited) session.process.kill();
      session.history.dispose();
      session.flow.dispose();
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  promote(
    sessionId: string,
    transport: TerminalTransport = "control",
  ): Promise<TerminalMetadata | undefined> {
    const pending = this.promoting.get(sessionId);
    if (pending) return pending;
    const promotion = this.promoteIdle(sessionId, transport);
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
    transport: TerminalTransport,
  ): Promise<TerminalMetadata | undefined> {
    await this.starting.get(sessionId);
    if (this.backends.get(sessionId)?.backend === "tmux")
      return this.metadata(sessionId);
    const original = this.sessions.get(sessionId);
    if (!original || original.closing || !(await this.idle(original))) return;
    const capabilities = (await this.tmux.capabilities()).tmux;
    if (!capabilities.available || capabilities.supported === false)
      throw new Error("tmux 3.2a or newer is required.");
    const revision = original.inputRevision;
    const cwd = (await this.cwd(sessionId)) || original.cwd.cwd;
    const size = this.sizes.get(sessionId) || { cols: 80, rows: 24 };
    let id: string | undefined;
    let candidate: Session | undefined;
    let switched = false;
    try {
      id = await this.tmux.create(cwd, original.shell, size.cols, size.rows);
      await this.tmux.configureMouse(id, this.tmuxMouse);
      candidate = this.spawnClient(
        sessionId,
        cwd,
        original.shell,
        id,
        transport,
      );
      await this.waitForAttach(id, candidate);
      // Buffer keystrokes during the final check; never lose input or migrate a task.
      original.deferredInput = [];
      if (!(await this.idle(original)) || original.inputRevision !== revision)
        return;
      const previousScreen = await original.history.snapshot();
      // Preserve Direct-session scrollback above the new protected shell.
      // Pause reads before the snapshot barrier so no candidate output can
      // land in the old history after it has been captured and replaced.
      const release = candidate.flow.hold();
      try {
        const candidateScreen = await candidate.history.snapshot(
          undefined,
          true,
        );
        const data = previousScreen.data + candidateScreen.data;
        candidate.history.dispose();
        candidate.history = new TerminalHistory(
          previousScreen.cols,
          previousScreen.rows,
        );
        const flow = candidate.flow;
        flow.queued(data.length);
        candidate.history.write(data, () => flow.parsed(data.length));
      } finally {
        release();
      }
      this.sessions.set(sessionId, candidate);
      this.backends.set(sessionId, {
        cwd,
        profile: original.shell,
        backend: "tmux",
        backendSessionId: id,
        transport,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        connectionState: "connected",
      });
      switched = true;
      const currentSize = this.sizes.get(sessionId) || size;
      this.resize(sessionId, currentSize.cols, currentSize.rows);
      candidate.output = (original.output + candidate.output).slice(
        -DIAGNOSTIC_OUTPUT_CHARS,
      );
      this.emitMetadata(sessionId);
      this.emit({ type: "reset", sessionId });
      original.flow.setViewPending(0);
      await this.terminate(original, await inspectProcesses());
      if (original.checkpointTimer) clearTimeout(original.checkpointTimer);
      await original.checkpoint;
      original.history.dispose();
      original.flow.dispose();
      await this.options.outputStore?.remove(sessionId);
      return this.metadata(sessionId);
    } finally {
      const input = original.deferredInput;
      original.deferredInput = undefined;
      if (!switched) {
        if (candidate && !candidate.exited) candidate.process.kill();
        candidate?.history.dispose();
        candidate?.flow.dispose();
        if (id) await this.tmux.destroy(id);
      }
      for (const { data, binary } of input || [])
        this.input(sessionId, data, binary);
    }
  }

  input(sessionId: string, data: string, binary = false) {
    const session = this.sessions.get(sessionId);
    if (!session || session.exited || session.closing) return;
    session.inputRevision++;
    if (session.deferredInput) session.deferredInput.push({ data, binary });
    else session.process.write(binary ? Buffer.from(data, "latin1") : data);
  }

  setOutputPending(sessionId: string, length: number) {
    if (!Number.isSafeInteger(length) || length < 0) return;
    this.sessions.get(sessionId)?.flow.setViewPending(length);
  }
  setForeground(sessionId?: string) {
    this.outputBudget.setForeground(sessionId);
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
    await this.starting.get(sessionId);
    await this.promoting.get(sessionId);
    const session = this.sessions.get(sessionId);
    if (!session) {
      // Startup errors are complete messages. Never render the diagnostic raw
      // output tail, which can begin in the middle of an escape or surrogate.
      const snapshot: OutputSnapshot = {
        version: 1,
        ...(this.sizes.get(sessionId) || { cols: 80, rows: 24 }),
        data: this.recoveryOutput.get(sessionId) || "",
      };
      if (!this.backends.has(sessionId)) return;
      consume?.(snapshot);
      return snapshot;
    }
    const snapshot = await session.history.snapshot(consume, true);
    if (snapshot.truncated && !this.truncationNotified.has(sessionId)) {
      this.truncationNotified.add(sessionId);
      this.emit({
        type: "notice",
        sessionId,
        message:
          "Terminal history exceeded the snapshot limit; older lines were omitted.",
      });
    }
    return snapshot;
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
    }, this.options.checkpointIntervalMs || OUTPUT_CHECKPOINT_INTERVAL_MS);
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

  async reconnectDisplay(
    sessionId: string,
  ): Promise<TerminalMetadata | undefined> {
    const metadata = this.backends.get(sessionId);
    if (metadata?.backend !== "tmux" || !metadata.backendSessionId)
      throw new Error("Terminal is not a protected session.");
    await this.starting.get(sessionId);
    await this.promoting.get(sessionId);
    const previous = this.sessions.get(sessionId);
    const size = this.sizes.get(sessionId) || { cols: 80, rows: 24 };
    metadata.displayState = "refreshing";
    this.emitMetadata(sessionId);
    const transport: TerminalTransport = metadata.degraded
      ? "control"
      : metadata.transport || "control";
    try {
      if (!(await this.tmux.inspect(metadata.backendSessionId)))
        throw new Error("Protected session is no longer available.");
      await this.tmux.configureMouse(metadata.backendSessionId, this.tmuxMouse);
      const cwd = metadata.cwd || previous?.cwd.cwd || "";
      const prefix =
        transport === "attach"
          ? await this.tmux.history(metadata.backendSessionId, size.rows)
          : "";
      const candidate = this.spawnClient(
        sessionId,
        cwd,
        metadata.profile,
        metadata.backendSessionId,
        transport,
        prefix,
      );
      try {
        await this.waitForAttach(metadata.backendSessionId, candidate);
      } catch (error) {
        if (!candidate.exited) candidate.process.kill();
        candidate.history.dispose();
        candidate.flow.dispose();
        throw error;
      }
      this.sessions.set(sessionId, candidate);
      metadata.transport = transport;
      metadata.degraded = false;
      metadata.displayState = undefined;
      metadata.connectionState = "connected";
      metadata.updatedAt = Date.now();
      if (previous && previous !== candidate) {
        if (!previous.exited) previous.process.kill();
        previous.history.dispose();
        previous.flow.dispose();
      }
      this.emitMetadata(sessionId);
      this.emit({ type: "reset", sessionId });
      return this.metadata(sessionId);
    } catch (error) {
      metadata.displayState = "failed";
      metadata.connectionState =
        previous && !previous.exited ? "connected" : "disconnected";
      this.emitMetadata(sessionId);
      this.emit({ type: "error", sessionId, message: String(error) });
      return this.metadata(sessionId);
    }
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
        session.flow.setViewPending(0);
        if (session.checkpointTimer) clearTimeout(session.checkpointTimer);
        await this.terminate(session, processes);
        await session.checkpoint;
        session.history.dispose();
        session.flow.dispose();
      }
      await this.options.outputStore?.remove(sessionId);
      this.sessions.delete(sessionId);
      this.backends.delete(sessionId);
      this.recoveryOutput.delete(sessionId);
      this.truncationNotified.delete(sessionId);
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
        session.flow.setViewPending(0);
        if (session.checkpointTimer) clearTimeout(session.checkpointTimer);
        await session.checkpoint;
        if (this.backends.get(id)?.backend === "direct") {
          await this.terminate(session, processes);
          await this.saveOutput(id, session);
        } else if (!session.exited) session.process.kill();
        session.history.dispose();
        session.flow.dispose();
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
