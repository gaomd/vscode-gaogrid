# Changelog

All notable changes to GaoGrid are documented here.

## [0.2.1] - 2026-10-26

- Add a Marketplace icon using the existing terminal artwork.
- Simplify the view title to show **GaoGrid** instead of **GaoGrid: Workspace**.
- Update the extension description and introduction to reflect support for
  VS Code and compatible editors, with inspiration from cmux and herdr.
- Add packaging and release commands with a documented publishing workflow.

## [0.2.0] - 2026-10-26

This is the first release of GaoGrid. It adds terminal workspaces to the VS Code
Secondary Sidebar, with split layouts, tab management, and recovery options for
work that needs to survive an editor restart.

### Workspaces and panes

- Create and switch between up to nine workspaces, each with a recursive,
  resizable split-pane layout.
- Open multiple terminal tabs in each pane, switch between them, and move tabs
  between panes or workspaces by dragging.
- Drag a tab onto a pane to create a split, or reorder workspaces by dragging
  them along the workspace rail.
- New tabs and split panes inherit the active terminal's working directory when
  it can be determined.

### Session recovery

- Restore workspace layouts, pane sizes, terminal tabs, working directories, and
  saved terminal output after the webview or Extension Host restarts.
- Protect a session with tmux so its running process survives VS Code quit,
  reload, and Extension Host restarts. Reconnect to the same process when GaoGrid
  returns.
- Turn protection on or off from a tab's context menu while preserving the tab
  identity and captured terminal output.
- When tmux is unavailable, ordinary terminal workspaces and direct sessions
  remain available.

### Terminal controls

- Use keyboard shortcuts to create workspaces and tabs, close tabs, switch
  workspaces and tabs, cycle between tabs, and adjust terminal font size.
- Send `Shift+Enter` as a distinct key sequence for applications such as Codex.
- Drag files and folders into a terminal to insert their shell-quoted absolute
  paths without running the command.
- Confirm before closing terminals with detected running tasks. Closing a
  protected session also removes its GaoGrid-owned tmux session.

### Compatibility and fixes

- Keep mouse interaction and modified key sequences working inside protected
  tmux sessions, including Codex's `Shift+Enter` behavior.
- Use an isolated tmux server and GaoGrid-owned configuration so protected
  sessions do not load or alter the user's regular tmux configuration.
- Close a protected tab automatically when its shell exits.
