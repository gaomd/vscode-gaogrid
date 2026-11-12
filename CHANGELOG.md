# Changelog

All notable changes to GaoGrid are documented here.

## [0.9.0] - 2026-11-12

### Features

- Report one privacy-focused extension usage event through the official VS Code
  telemetry SDK when editor telemetry is enabled. Terminal content, commands,
  paths, workspace names, tab titles, and session identifiers are excluded.

### Fixes

- Unify tab, workspace, and tmux transfer drag handling. The full tab strip and
  add button now accept drops, trailing drops append correctly, split moves use
  the correct insertion target, and cancelled drags clear every indicator.
- Stabilize terminal resize calculations after tab switches, avoiding transient
  two-column PTY or tmux resizes while the webview layout settles.
- Inherit the active tab's current working directory when opening a new tab,
  rather than a stale pane-level directory.
- Preserve the source workspace's focus when moving a tab to another workspace,
  and focus the destination only when the source workspace is removed.

## [0.8.0] - 2026-11-07

### Features

- Show a terminal drop target when a compatible file or folder drag reaches the
  webview. This is visual feedback only and does not bypass VS Code drag
  routing limitations.
- Add **GaoGrid: Insert File Paths into Terminal** to Explorer's context menu
  for inserting selected file and folder URIs without drag and drop.
- Add **Insert Paths…** to the terminal context menu. It opens a native picker
  for that pane's active terminal and remembers the last selected containing
  directory separately for each terminal during the current Extension Host
  session. The location falls back to the terminal cwd when unavailable and is
  not persisted across reloads.

### Fixes

- Insert shortcut-created tabs and workspaces, as well as context-menu tabs,
  after the active item while keeping toolbar add actions append-only.
- Return to the previous active tab after closing the current one without
  retaining deeper focus history.
- Keep split drop previews inside the rounded terminal surface by rounding only
  their outer corners while leaving the inner split edges square.

## [0.7.0] - 2026-11-02

### Features

- Add a Transfer panel above terminal settings for importing or moving
  GaoGrid-owned tmux sessions between Extension Host instances. Sessions are
  grouped by running, idle, or unknown state, ordered by recent focus, and can
  be dragged into a pane tab strip or split.
- Attach all running transfer sessions as tabs in a new workspace and clean up
  idle transfer sessions individually or as a group.

### Fixes

- Rebuild the terminal glyph atlas when focus, window visibility, or terminal
  settings change, preventing stale WebGL glyphs from corrupting visible text.
- Use the stable DOM renderer for automatic and off GPU-acceleration settings;
  WebGL now requires an explicit `terminal.integrated.gpuAcceleration: "on"`.
- Open replayed terminals before restoring focus so newly created tabs receive
  keyboard focus reliably.

## [0.6.2] - 2026-10-29

### Features

- Explain the built-in xterm.js terminal, isolated tmux server and configuration,
  version requirement, and unavailable settings in the settings help.
- Add default and recommended legends, and clarify Scroll Behavior options as
  App First, Terminal First, and App Only.

### Fixes

- Keep tmux Mouse visible and enabled by default in Control and Attach modes.
  Apply changes to existing protected sessions and preserve the preference
  during promotion and reconnect.
- Keep Scroll Behavior options visible but disabled in Attach Mode.

## [0.6.1] - 2026-10-29

### Fixes

- Match tmux Control Mode's color-query replies to the editor theme, fixing dark
  Codex input boxes and message backgrounds in light themes.

## [0.6.0] - 2026-10-29

### Features

- Use tmux control mode for new protected terminals by default, retaining live
  output and screen history without relying on native tmux redraws. Native
  attach remains available as an explicit transport and automatic fallback.
- Configure new terminals as direct or protected, choose control or attach
  transport, and select mouse handling from the terminal settings control.
- Restore protected terminal snapshots with their history, active screen,
  cursor, and supported input modes after an Extension Host restart.

### Fixes

- Harden protected output ordering, backpressure, reconnect, and snapshot replay
  across large and chunked terminal streams.
- Avoid duplicate terminal query replies and preserve incomplete control
  sequences while protected sessions attach.
- Keep terminal settings usable in narrow editor sidebars and keep the maximize
  action below the window controls.
- Improve terminal selection and scrolling with application-first,
  terminal-first, and application-exclusive mouse policies. Shift-wheel
  scrolls history, while Option-drag selects text on macOS.

## [0.5.2] - 2026-10-28

### Fixes

- Replace overlapping terminal scrollbars with a single slim, rounded scrollbar
  that keeps the last text column visible.
- Remove the dark strip below terminal content.
- Restore text selection and scrolling in protected sessions. On macOS, hold
  Option while dragging to select terminal text when an application captures
  mouse input.

## [0.5.1] - 2026-10-28

### Fixes

- Make active workspace and terminal tabs easier to identify.
- Reduce visual clutter in toolbar buttons and inactive tabs.
- Improve terminal tab spacing and the appearance of protection indicators.

## [0.5.0] - 2026-10-27

### Dependencies

- Upgrade xterm.js 6 and matching addons, Codicons, TypeScript 7, esbuild, and
  Prettier, using compatible version ranges. See the
  [dependency history and compatibility audit](docs/xterm-6-audit.md).

### Fixes

- Change pane distribution to `Alt+Shift+M` to avoid macOS input-source
  shortcut conflicts. Press M twice while holding Alt+Shift to balance every
  split group in the workspace.
- Restore focus to the active terminal when the Secondary Sidebar is shown
  again after being hidden.
- Place the protected-session shield after the terminal tab label.

## [0.4.0] - 2026-10-27

### Features

- Split panes in all four directions with `Alt+Shift+Arrow` or
  `Alt+Shift+T/D/L/R`, focusing the new terminal in the inherited working
  directory. Limit new splits to four nesting levels while preserving existing
  deeper layouts.
- Navigate between panes with `Alt+Ctrl+Arrow`, without wrapping at workspace
  edges.
- Distribute the focused split group evenly with `Alt+Shift+Space`, or press
  Space twice to balance every split group in the workspace.

### Fixes

- Follow the editor's color scheme throughout the interface, including dark and
  high-contrast themes. Register a Primary Sidebar fallback for Cursor and older
  compatible editors.
- Keep terminal focus after maximizing or restoring the sidebar. When a pane
  closes, return focus to its surviving sibling branch; make left/right
  navigation prefer the adjacent pane sharing the longest edge.
- Use Unicode 11 widths in frontend and history terminals so Emoji such as
  `🐍` and `📦` occupy two columns and Starship right prompts leave input at the
  correct position.
- Preserve the input method's full-width punctuation on macOS and align CJK
  punctuation with the terminal grid and composition preview.
- Restore hidden and recreated terminals from parsed snapshots, preserving live
  alternate screens, input modes, mouse encoding, and cursor visibility without
  replaying stale queries or truncated escape sequences.
- Apply output backpressure through PTY pause/resume and frontend parsing
  acknowledgments to keep sustained output bounded and ordered.
- Forward binary terminal input without UTF-8 expansion, preserving legacy mouse
  reports.
- Preserve complete Explorer file selections when dropping into terminals and
  leave ordinary text and internal tab/workspace drags on their normal paths.

## [0.3.0] - 2026-10-26

### Features

- Detach GaoGrid into a floating window and attach it back to the sidebar while
  preserving workspace layouts, running terminals, and terminal output.
- Add square detach/attach and maximize/restore buttons at the bottom of the
  workspace rail, with `⌘D` and `⌘X` shortcuts. Sidebar maximization is disabled
  while detached.
- Add **Move into New Window** and **Attach to Sidebar** to VS Code's native
  title-bar menus. Closing the floating panel returns GaoGrid to the sidebar
  without terminating its terminals.
- Add README installation instructions for VS Code and compatible editors.

### Fixes

- Close ordinary terminal tabs automatically when their shells exit, including
  with `Ctrl+D`.

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
