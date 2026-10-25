import { execFile } from "child_process";
import { promisify } from "util";
import { randomUUID } from "crypto";
import type { BackendCapabilities } from "./terminal-protocol";

const exec = promisify(execFile);
const OWNER = "gaogrid-v1";
const OWNED_ID =
  /^gaogrid-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const missing = (error: unknown) =>
  /can't find session|no server running|no sessions|(?:error connecting|failed to connect)[^\n]*No such file or directory/i.test(
    String((error as { stderr?: string }).stderr || error),
  );
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

export interface TmuxPane {
  pid: number;
  cwd: string;
}

/** Only this server namespace and explicitly marked UUID sessions are ours. */
export class TmuxBackend {
  private detected?: Promise<BackendCapabilities>;
  readonly environment: NodeJS.ProcessEnv;
  constructor(
    private readonly configPath: string,
    environment = process.env,
  ) {
    this.environment = {
      ...environment,
      TMUX: undefined,
      TMUX_PANE: undefined,
    };
  }
  capabilities(): Promise<BackendCapabilities> {
    return (this.detected ??= exec("tmux", ["-V"], {
      env: this.environment,
      timeout: 1500,
    })
      .then(({ stdout }) => ({
        tmux: { available: true, version: stdout.trim() },
      }))
      .catch(() => ({ tmux: { available: false } })));
  }
  private args(args: string[]) {
    return ["-L", "gaogrid", "-f", this.configPath, ...args];
  }
  private async run(args: string[]) {
    try {
      const { stdout } = await exec("tmux", this.args(args), {
        env: this.environment,
        timeout: 3000,
        maxBuffer: 8 * 1024 * 1024,
      });
      return stdout;
    } catch (error) {
      // execFile's default message includes every argument, including -e secrets.
      const failure = error as NodeJS.ErrnoException & { stderr?: string };
      const stderr = failure.stderr?.trim() || "";
      throw Object.assign(
        new Error(
          `tmux ${args[0]}: ${stderr || failure.code || "command failed"}`,
        ),
        { code: failure.code, stderr },
      );
    }
  }
  private target(id: string) {
    if (!OWNED_ID.test(id))
      throw new Error("Invalid GaoGrid protected session identifier.");
    return `=${id}`;
  }
  async inspect(id: string): Promise<TmuxPane | undefined> {
    const target = this.target(id);
    try {
      await this.run(["has-session", "-t", target]);
    } catch (error) {
      if (missing(error)) return;
      throw error;
    }
    const output = await this.run([
      "display-message",
      "-p",
      "-t",
      `${target}:0.0`,
      "#{@gaogrid-owner}\n#{pane_pid}\n#{pane_current_path}",
    ]);
    const [owner, pid, ...cwd] = output.replace(/\n$/, "").split("\n");
    if (owner !== OWNER || !/^\d+$/.test(pid))
      throw new Error("Protected session ownership could not be verified.");
    return { pid: +pid, cwd: cwd.join("\n") };
  }
  async create(cwd: string, shell: string, cols: number, rows: number) {
    const id = `gaogrid-${randomUUID()}`;
    const env = Object.entries(this.environment).flatMap(([key, value]) =>
      typeof value === "string" ? ["-e", `${key}=${value}`] : [],
    );
    await this.run([
      "new-session",
      "-d",
      "-s",
      id,
      "-c",
      cwd,
      "-x",
      String(cols),
      "-y",
      String(rows),
      ...env,
      `exec ${quote(shell)}`,
    ]);
    try {
      await this.configure();
      // set-option's session target does not accept has-session's '=' syntax.
      await this.run(["set-option", "-t", id, "@gaogrid-owner", OWNER]);
      if (!(await this.inspect(id)))
        throw new Error("Could not verify the new protected session.");
      return id;
    } catch (error) {
      // new-session succeeded in this invocation; only this fresh UUID is ours.
      await this.run(["kill-session", "-t", this.target(id)]).catch(() => {});
      throw error;
    }
  }
  async configure() {
    await this.run(["source-file", this.configPath]);
  }
  attachArgs(id: string) {
    return this.args(["attach-session", "-t", this.target(id)]);
  }
  async attached(id: string, pid: number) {
    const output = await this.run([
      "list-clients",
      "-t",
      this.target(id),
      "-F",
      "#{client_pid}",
    ]);
    return output.trim().split("\n").includes(String(pid));
  }
  async history(id: string, rows: number) {
    const target = `${this.target(id)}:0.0`;
    const size = +(
      await this.run(["display-message", "-p", "-t", target, "#{history_size}"])
    ).trim();
    if (!size) return "";
    // Only history, excluding the visible screen that attach will redraw.
    const output = await this.run([
      "capture-pane",
      "-p",
      "-e",
      "-t",
      target,
      "-S",
      "-10000",
      "-E",
      "-1",
    ]);
    return output.replace(/\r?\n/g, "\r\n") + "\r\n".repeat(rows);
  }
  async destroy(id: string) {
    if (await this.inspect(id))
      await this.run(["kill-session", "-t", this.target(id)]);
  }
  async orphans(known: string[]) {
    let output: string;
    try {
      output = await this.run(["list-sessions", "-F", "#{session_name}"]);
    } catch (error) {
      if (missing(error)) return [];
      throw error;
    }
    const candidates = output
      .trim()
      .split("\n")
      .filter((id) => OWNED_ID.test(id) && !known.includes(id));
    const owned = await Promise.all(
      candidates.map(async (id) =>
        (await this.inspect(id).catch(() => undefined)) ? id : undefined,
      ),
    );
    return owned.filter((id): id is string => !!id);
  }
}
