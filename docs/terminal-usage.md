# Terminal Usage

## Compatible Editors

On recent VS Code versions, GaoGrid opens in the Secondary Sidebar. Editors
based on older VS Code versions, including Cursor 2.6, register GaoGrid in the
Primary Sidebar instead. Run **View: Move View** from the Command Palette, select
**GaoGrid**, then **New Secondary Side Bar Entry**. The editor remembers that
placement.

## Workspaces And Terminals

GaoGrid supports up to nine workspaces and up to nine terminal tabs per pane.
Double-click a tab or workspace to close it. Keyboard shortcuts apply while
GaoGrid has focus:

| Shortcut      | Action                                    |
| ------------- | ----------------------------------------- |
| `⌘N`          | New workspace                             |
| `⌘T`          | New tab in the focused pane               |
| `⌥⇧↑` / `⌥⇧T` | New pane above the focused pane           |
| `⌥⇧↓` / `⌥⇧D` | New pane below the focused pane           |
| `⌥⇧←` / `⌥⇧L` | New pane to the left of the focused pane  |
| `⌥⇧→` / `⌥⇧R` | New pane to the right of the focused pane |
| `⌃⌥↑` / `⌃⌥↓` | Focus the pane above / below              |
| `⌃⌥←` / `⌃⌥→` | Focus the pane to the left / right        |
| `⌘W`          | Close the focused pane's active tab       |
| `⌘D`          | Detach window / attach to sidebar         |
| `⌘X`          | Maximize / restore the secondary sidebar  |
| `Ctrl+1–9`    | Switch workspace                          |
| `⌘1–9`        | Switch tab in the focused pane            |
| `⌘⇧[`         | Previous tab in the focused pane          |
| `⌘⇧]`         | Next tab in the focused pane              |
| `⌘+` / `⌘-`   | Adjust the focused terminal's font size   |
| `⌘0`          | Restore the configured terminal font size |

Tab cycling wraps at the first and last tabs. Inside a terminal, `Shift+Enter`
sends a distinct key sequence so Codex can insert a newline without submitting
the prompt. Terminal fonts and colors follow VS Code's terminal settings and
current theme.

## Splitting Panes

Both shortcut families create a new terminal on the requested side of the focused
pane. `T`, `D`, `L`, and `R` stand for Top, Down, Left, and Right. The new pane
inherits the source terminal's cwd and receives keyboard focus. Other panes and
their running terminals stay in place.

The toolbar buttons are ordered **Split Down**, then **Split Right**. All four
directions are available in the pane's context menu and **More Pane Actions**.
Keep Shift in these shortcuts so ordinary Option/Alt word navigation and shell
bindings remain available.

Splits support at most four nesting levels, counting the initial pane as depth
zero. At the limit, split buttons and menu items are disabled, and shortcuts or
tab drops cannot add another level. Moving an existing tab is still allowed when
removing its old pane keeps the resulting layout within the limit. Older saved
layouts retain their terminals and structure; over-limit branches cannot be
split further.

## Switching Panes

Use `Alt+Ctrl+↑/↓/←/→` (`⌃⌥↑/↓/←/→` on macOS) to focus the neighboring pane
in that direction and its active terminal tab. Navigation follows the visual
layout across nested splits. At an outer edge, focus stays in place; it does not
wrap to the opposite side or move to another workspace. These four focus commands
are also available in the Command Palette and VS Code's Keyboard Shortcuts editor.

## Dedicated Window

Use the detach button at the bottom of the workspace rail, press `⌘D`, or choose
**Move into New Window** from GaoGrid's VS Code title-bar menu. GaoGrid moves to
a floating window with the same workspaces, running terminals, and output.

Use the attach button or `⌘D` to return to the sidebar. **Attach to Sidebar** is
also available in the native title-bar menus. Closing the floating GaoGrid panel
returns it to the sidebar and keeps its terminals running.

The maximize button and `⌘X` toggle VS Code's secondary sidebar size. The button
is disabled while GaoGrid is detached, and `⌘X` keeps its normal behavior there.
Floating windows require support from the editor; the detach button is hidden
when unavailable.

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
