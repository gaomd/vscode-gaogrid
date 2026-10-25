import type { CloseScope } from "./terminal-protocol";

export interface CloseRequest {
  scope: CloseScope;
  title?: string;
  terminals: { sessionId: string; title: string }[];
}

interface LifecycleBackend {
  activeTasks(sessionIds: string[]): Promise<Set<string>>;
  closeSessions(sessionIds: string[]): Promise<void>;
}

export interface CloseConfirmation {
  message: string;
  detail: string;
  action: string;
}

/** The only user-initiated termination pipeline, shared by every close scope. */
export class TerminalLifecycle {
  constructor(
    private readonly backend: LifecycleBackend,
    private readonly confirm: (
      confirmation: CloseConfirmation,
    ) => Promise<boolean>,
  ) {}

  async requestClose(request: CloseRequest): Promise<boolean> {
    const ids = [...new Set(request.terminals.map((tab) => tab.sessionId))];
    const active = await this.backend.activeTasks(ids);
    const busy = request.terminals.filter((tab) => active.has(tab.sessionId));
    if (busy.length) {
      const scope = request.scope;
      const action =
        scope === "terminal"
          ? "Close Terminal"
          : scope === "pane"
            ? "Close Pane"
            : "Close Workspace";
      const message =
        scope === "workspace"
          ? `Close workspace "${request.title || "Workspace"}"?`
          : `Close ${scope}?`;
      const detail =
        scope === "terminal"
          ? `A task is still running in "${busy[0].title}".\nClosing this tab will terminate it.`
          : `${busy.length} terminal${busy.length === 1 ? " still has a running task" : "s still have running tasks"}.\nClosing this ${scope} will terminate ${busy.length === 1 ? "it" : "them"}.`;
      if (!(await this.confirm({ message, detail, action }))) return false;
    }
    await this.backend.closeSessions(ids);
    return true;
  }
}
