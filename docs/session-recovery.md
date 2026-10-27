# Session Recovery

GaoGrid stores workspace and terminal recovery data in VS Code extension
storage, outside the project repository. It does not automatically rerun or
resume applications.

## Restored Workspace State

GaoGrid restores workspaces, split layouts, pane sizes, tab identities, cwd, and
shell metadata. Recreating only the webview reuses live PTYs and buffered output.
Tabs restore from parsed terminal snapshots before receiving live output, so
hidden-tab restoration never starts in the middle of an escape sequence or an
Emoji. Live application modes are retained during webview recreation; saved
history for a fresh shell excludes those modes and terminal queries.

After VS Code or the Extension Host restarts, a direct terminal starts a fresh
shell in its saved cwd. GaoGrid restores its saved rendered output first and
shows a message to distinguish that history from the new shell. Output, colors,
and terminal dimensions are checkpointed while the terminal runs and flushed on
graceful shutdown. Explicit tab close removes its snapshot. Each tab retains up
to 10,000 scrollback lines, within a 2 MB serialized snapshot limit. Images are
not included. A forced host termination can lose output since the last
checkpoint.

## Protected Sessions

When `tmux -V` succeeds in the terminal's execution environment, right-click a
tab and choose **Protect Session**, or use the pane's shield button. Protection
is an explicit opt-in; create it while the shell is idle, before starting Codex,
Claude Code, a server, or another long-running task. If a terminal is busy,
**Open Protected Tab** creates a separate protected tab in the same pane and
inherits its cwd, leaving the running task untouched.

The idle check uses process inspection and does not inspect shell prompt or
command state. Shell builtins without child processes (such as `read`) can be
misclassified as idle. When unsure, open a new protected tab before starting a
task. Prompt-level idle detection is deferred.

A protected tab runs inside a GaoGrid-owned tmux session. It survives VS Code
quit, reload, and Extension Host restart; GaoGrid reconnects to the same process
and uses tmux history as the recovery source. Right-click a disconnected
protected tab to reconnect. Explicitly closing a protected tab destroys its
session after any required task confirmation. Closing a workspace uses one
combined confirmation. VS Code shutdown detaches and leaves protected sessions
running.

To remove protection, choose **Remove Protection** from the tab's context menu
while no task is running. GaoGrid refuses while a task is active. After
confirmation, it destroys the tmux session and starts a fresh direct shell in
the current directory, keeping the GaoGrid tab identity and restoring captured
terminal output before the new shell prompt. This is an explicit
destroy-and-recreate operation, not a live backend downgrade.

GaoGrid uses an isolated `tmux -L gaogrid` server and its own configuration. It
does not load `~/.tmux.conf` or touch the user's normal tmux server. If tmux is
unavailable, protection controls are omitted and direct terminals work
normally. In Remote SSH and Dev Containers, capability detection and tmux run in
the workspace extension host, alongside the terminal processes.

tmux does not survive an OS reboot. If a protected session is missing, GaoGrid
keeps its tab and layout, starts a fresh protected shell in the saved cwd, and
reports that the prior session ended. It never automatically resumes Codex or
Claude. Direct sessions remain the preferred choice when maximum graphics
compatibility is needed.

For implementation and tested protocol details, see
[protected session compatibility](protected-sessions.md).
