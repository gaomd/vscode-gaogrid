import type { OutputSnapshot } from "./terminal-history";
import type { TerminalOutputPacket } from "./terminal-protocol";

interface OutputBackend {
  replay(
    id: string,
    consume: (snapshot: OutputSnapshot) => void,
  ): Promise<OutputSnapshot | undefined>;
  setOutputPending(id: string, length: number): void;
}

interface Subscription {
  id: string;
  ready: boolean;
  sent: number;
  acknowledged: number;
}

const REPLAY_CHUNK_SIZE = 256 * 1024;

/** A snapshot barrier followed by ordered, acknowledged output for mounted tabs. */
export class TerminalOutputStream {
  private readonly subscriptions = new Map<string, Subscription>();

  constructor(
    private readonly backend: OutputBackend,
    private readonly post: (
      message:
        | TerminalOutputPacket
        | {
            type: "streamError";
            sessionId: string;
            streamId: string;
            message: string;
          },
    ) => PromiseLike<boolean> | boolean | void,
  ) {}

  async subscribe(sessionId: string, streamId: string) {
    this.unsubscribe(sessionId);
    const subscription: Subscription = {
      id: streamId,
      ready: false,
      sent: 0,
      acknowledged: 0,
    };
    this.subscriptions.set(sessionId, subscription);
    try {
      const snapshot = await this.backend.replay(sessionId, (value) => {
        if (this.subscriptions.get(sessionId) !== subscription) return;
        subscription.ready = true;
        const chunks = chunkData(value.data);
        if (!chunks.length)
          this.send(
            sessionId,
            subscription,
            "replay",
            "",
            value.cols,
            value.rows,
          );
        else
          chunks.forEach((chunk, index) =>
            this.send(
              sessionId,
              subscription,
              index ? "data" : "replay",
              chunk,
              index ? undefined : value.cols,
              index ? undefined : value.rows,
            ),
          );
      });
      if (!snapshot && this.subscriptions.get(sessionId) === subscription) {
        subscription.ready = true;
        this.send(sessionId, subscription, "replay", "");
      }
    } catch (error) {
      if (this.subscriptions.get(sessionId) !== subscription) return;
      this.unsubscribe(sessionId);
      // A disposed webview may reject even the error message.
      await Promise.resolve()
        .then(() =>
          this.post({
            type: "streamError",
            sessionId,
            streamId,
            message: String(error),
          }),
        )
        .catch(() => {});
    }
  }

  write(sessionId: string, data: string) {
    const subscription = this.subscriptions.get(sessionId);
    if (subscription?.ready)
      for (const chunk of chunkData(data))
        this.send(sessionId, subscription, "data", chunk);
  }

  acknowledge(sessionId: string, streamId: string, sequence: number) {
    const subscription = this.subscriptions.get(sessionId);
    if (
      !subscription ||
      subscription.id !== streamId ||
      !Number.isSafeInteger(sequence) ||
      sequence <= subscription.acknowledged ||
      sequence > subscription.sent
    )
      return;
    subscription.acknowledged = sequence;
    this.backend.setOutputPending(sessionId, subscription.sent - sequence);
  }

  unsubscribe(sessionId: string, streamId?: string) {
    const subscription = this.subscriptions.get(sessionId);
    if (!subscription || (streamId && subscription.id !== streamId)) return;
    this.subscriptions.delete(sessionId);
    this.backend.setOutputPending(sessionId, 0);
  }

  clear() {
    for (const id of this.subscriptions.keys()) this.unsubscribe(id);
  }

  private send(
    sessionId: string,
    subscription: Subscription,
    type: "data" | "replay",
    data: string,
    cols?: number,
    rows?: number,
  ) {
    subscription.sent += Math.max(1, data.length);
    this.backend.setOutputPending(
      sessionId,
      subscription.sent - subscription.acknowledged,
    );
    const packet: TerminalOutputPacket = {
      type,
      sessionId,
      streamId: subscription.id,
      sequence: subscription.sent,
      data,
      cols,
      rows,
    };
    void Promise.resolve()
      .then(() => {
        if (this.subscriptions.get(sessionId) !== subscription) return false;
        return this.post(packet);
      })
      .then(
        (accepted) => {
          if (
            accepted === false &&
            this.subscriptions.get(sessionId) === subscription
          )
            this.unsubscribe(sessionId);
        },
        () => {
          if (this.subscriptions.get(sessionId) === subscription)
            this.unsubscribe(sessionId);
        },
      );
  }
}

function chunkData(data: string) {
  const chunks: string[] = [];
  let offset = 0;
  while (offset < data.length) {
    let end = Math.min(data.length, offset + REPLAY_CHUNK_SIZE);
    if (end < data.length && isHighSurrogate(data.charCodeAt(end - 1))) end--;
    chunks.push(data.slice(offset, end));
    offset = end;
  }
  return chunks;
}

function isHighSurrogate(code: number) {
  return code >= 0xd800 && code <= 0xdbff;
}
