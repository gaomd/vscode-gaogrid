import type { TerminalBackendType } from "./model";

export interface TerminalOutputPacket {
  type: "data" | "replay";
  sessionId: string;
  streamId: string;
  // Cumulative string units, including one unit for an empty snapshot.
  sequence: number;
  data: string;
  cols?: number;
  rows?: number;
}

export interface NewTerminalOptions {
  cwd?: string;
  profile?: string;
  backend?: TerminalBackendType;
}

export type TerminalTransport = "control" | "attach";
export type MousePolicy = "application" | "terminal" | "exclusive";

export interface TerminalPreferences {
  defaultProtected: boolean;
  transport: TerminalTransport;
  mousePolicy: MousePolicy;
}

export type CloseScope = "terminal" | "pane" | "workspace";
export type LifecycleRequest =
  | {
      kind: "resolveCwd";
      explicitCwd?: string;
      sessionId?: string;
      lastKnownCwd?: string;
    }
  | {
      kind: "protect";
      sessionId: string;
      canOpenTab: boolean;
      transport: TerminalTransport;
    }
  | { kind: "reconnect"; sessionId: string }
  | { kind: "reconnectDisplay"; sessionId: string }
  | { kind: "unprotect"; sessionId: string }
  | {
      kind: "close";
      scope: CloseScope;
      title?: string;
      terminals: { sessionId: string; title: string }[];
    };

export type LifecycleResult =
  string | boolean | TerminalMetadata | "openProtectedTab";

export interface TerminalMetadata {
  cwd: string;
  profile: string;
  backend: TerminalBackendType;
  backendSessionId?: string;
  createdAt?: number;
  updatedAt?: number;
  connectionState: "connected" | "disconnected";
  transport?: TerminalTransport;
  degraded?: boolean;
  displayState?: "refreshing" | "failed";
}

export interface BackendCapabilities {
  tmux: { available: boolean; supported?: boolean; version?: string };
}

export interface WindowPresentation {
  mode: "sidebar" | "window";
  canDetach: boolean;
  canMaximize: boolean;
  transitioning: boolean;
}

export interface BackendOptions {
  backend?: TerminalBackendType;
  backendSessionId?: string;
  transport?: TerminalTransport;
  createdAt?: number;
  updatedAt?: number;
}
