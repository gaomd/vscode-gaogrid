export interface NewTerminalOptions {
  cwd?: string;
  profile?: string;
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
      kind: "close";
      scope: CloseScope;
      title?: string;
      terminals: { sessionId: string; title: string }[];
    };

export type LifecycleResult = string | boolean;

export interface TerminalMetadata {
  cwd: string;
  profile: string;
}
