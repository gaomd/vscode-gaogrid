import { promises as fs } from "fs";
import { createHash, randomUUID } from "crypto";
import * as path from "path";
import { MAX_SNAPSHOT_LENGTH, type OutputSnapshot } from "./terminal-history";

/** Atomic, same-user snapshots in VS Code storage, separate from layout state. */
export class TerminalOutputStore {
  private readonly pending = new Map<string, Promise<void>>();
  constructor(private readonly directory: string) {}
  private file(id: string) {
    return path.join(
      this.directory,
      `${createHash("sha256").update(id).digest("hex")}.json`,
    );
  }
  async read(id: string): Promise<OutputSnapshot | undefined> {
    await this.pending.get(id);
    try {
      const file = this.file(id);
      if ((await fs.stat(file)).size > MAX_SNAPSHOT_LENGTH * 6 + 1024) return;
      const value = JSON.parse(
        await fs.readFile(file, "utf8"),
      ) as OutputSnapshot;
      if (
        !value ||
        typeof value !== "object" ||
        value.version !== 1 ||
        typeof value.data !== "string" ||
        value.data.length > MAX_SNAPSHOT_LENGTH ||
        !Number.isInteger(value.cols) ||
        value.cols < 2 ||
        value.cols > 4096 ||
        !Number.isInteger(value.rows) ||
        value.rows < 1 ||
        value.rows > 4096
      )
        return;
      return value;
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === "ENOENT" ||
        error instanceof SyntaxError
      )
        return;
      throw error;
    }
  }
  private enqueue(id: string, operation: () => Promise<void>) {
    const pending = (this.pending.get(id) || Promise.resolve())
      .catch(() => {})
      .then(operation);
    this.pending.set(id, pending);
    void pending
      .finally(() => {
        if (this.pending.get(id) === pending) this.pending.delete(id);
      })
      .catch(() => {});
    return pending;
  }
  save(id: string, snapshot: OutputSnapshot) {
    return this.enqueue(id, async () => {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      const file = this.file(id);
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, JSON.stringify(snapshot), {
          mode: 0o600,
          flag: "wx",
        });
        await fs.rename(temporary, file);
      } finally {
        await fs.unlink(temporary).catch(() => {});
      }
    });
  }
  remove(id: string) {
    return this.enqueue(id, () =>
      fs.unlink(this.file(id)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      }),
    );
  }
}
