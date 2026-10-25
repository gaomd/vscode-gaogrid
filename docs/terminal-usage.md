# Terminal Usage

## Workspaces And Terminals

GaoGrid supports up to nine workspaces and up to nine terminal tabs per pane.
Double-click a tab or workspace to close it. Keyboard shortcuts apply while
GaoGrid has focus:

| Shortcut    | Action                                    |
| ----------- | ----------------------------------------- |
| `⌘N`        | New workspace                             |
| `⌘T`        | New tab in the focused pane               |
| `⌘W`        | Close the focused pane's active tab       |
| `Ctrl+1–9`  | Switch workspace                          |
| `⌘1–9`      | Switch tab in the focused pane            |
| `⌘⇧[`       | Previous tab in the focused pane          |
| `⌘⇧]`       | Next tab in the focused pane              |
| `⌘+` / `⌘-` | Adjust the focused terminal's font size   |
| `⌘0`        | Restore the configured terminal font size |

Tab cycling wraps at the first and last tabs. Inside a terminal, `Shift+Enter`
sends a distinct key sequence so Codex can insert a newline without submitting
the prompt. Terminal fonts and colors follow VS Code's terminal settings and
current theme.

## Working Directory

New tabs and split panes start in the active terminal's current directory. If it
is unavailable, GaoGrid tries the pane's last known directory, the current VS Code
workspace folder, then your home directory. Deleted or inaccessible directories
are skipped. The `gaogrid.newTab` command also accepts `{ cwd, profile }` options;
a valid explicit directory takes precedence.

Directories are resolved on demand using recent OSC 7 reports, if your shell
already sends them, or the shell process's directory on macOS and Linux. GaoGrid
uses your normal shell startup configuration without injecting prompt hooks.

## Closing Terminals

Idle shells close immediately. Closing a terminal with a running task asks for
confirmation; cancelling keeps its process, output, layout, and selection intact.
Closing a workspace checks all its terminals and shows one combined confirmation.
**GaoGrid: Close Terminal Pane** uses the same check for every tab in a pane.

On macOS and Linux, closing queries a fresh process snapshot to protect programs
and background jobs still attached to the terminal, such as `npm run dev &`.
Fully detached daemons and long-running shell builtins without child processes
are not detected. Close warnings are unavailable when process inspection is
denied, including on Windows.

See the [session recovery guide](session-recovery.md) for restore behavior and
protected sessions.
