import type { TerminalBackendType } from "./model";

export interface NewTerminalOptions {
  cwd?: string;
  profile?: string;
  backend?: TerminalBackendType;
}

export type CloseScope = "terminal" | "pane" | "workspace";
export type LifecycleRequest =
  | {
      kind: "resolveCwd";
      explicitCwd?: string;
      sessionId?: string;
      lastKnownCwd?: string;
    }
  | { kind: "protect"; sessionId: string; canOpenTab: boolean }
  | { kind: "reconnect"; sessionId: string }
  | { kind: "unprotect"; sessionId: string }
  | {
      kind: "close";
      scope: CloseScope;
      title?: string;
      terminals: { sessionId: string; title: string }[];
    };

export type LifecycleResult =
  | string
  | boolean
  | TerminalMetadata
  | "openProtectedTab";

export interface TerminalMetadata {
  cwd: string;
  profile: string;
  backend: TerminalBackendType;
  backendSessionId?: string;
  createdAt?: number;
  updatedAt?: number;
  connectionState: "connected" | "disconnected";
}

export interface BackendCapabilities {
  tmux: { available: boolean; version?: string };
}

export interface BackendOptions {
  backend?: TerminalBackendType;
  backendSessionId?: string;
  createdAt?: number;
  updatedAt?: number;
}
