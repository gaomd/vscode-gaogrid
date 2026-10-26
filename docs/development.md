# Development

Use VS Code, Node.js 20 or later, and npm.

```sh
npm ci
npm run compile
npm run typecheck
npm test
npm run format:check
```

Open the project in VS Code and press `F5` using the **Run GaoGrid Extension**
launch configuration. This opens an Extension Development Host with GaoGrid
loaded.

Run `npm run watch` to rebuild changes automatically. Use **Developer: Reload
Webviews** in the development window to load updated webview code while keeping
the extension host and terminal processes running. Restart the debugging session
to load changes to extension host code.

The tests exercise cwd fallback and traversal permissions, passive OSC parsing,
close-time task detection, cancelled and aggregate close operations, layout
mutations, and real zsh/bash PTYs. The PTY tests require process inspection and
process directory queries; restricted sandboxes must allow these operations.
They also check conservative residual cleanup.

## Packaging And Releases

Packaging and publishing require Node.js 22 or later. The commands use a pinned
version of `@vscode/vsce` through `npx`; npm downloads the tool on first use.

```sh
npm run package
```

This runs the existing `vscode:prepublish` build and creates
`gaogrid-<version>.vsix` in the project root, using the version from `package.json`.
Relative documentation links in the packaged README point to the `main` branch.
To choose another output path, use `npm run package -- --out /path/to/gaogrid.vsix`.

Before a release, run the development checks above, update `CHANGELOG.md`, and
choose a version that has not been published. For example:

```sh
npm version patch --no-git-tag-version
npm run package
```

Install the generated VSIX to review the release, then commit the version and
changelog changes. When ready, publish the current version:

```sh
npm run release
```

The release command rebuilds and publishes to the VS Code Marketplace using
vsce's configured publisher credentials. It does not increment the version,
create a Git tag, or push commits. Publishing requires authentication for the
`gaomd` publisher.

## Webview Architecture And UI

The manifest declares the same GaoGrid container in `secondarySidebar` first and
`activitybar` second. Editors register the first supported location for a
container ID: current VS Code uses the Secondary Sidebar, while older versions
and Cursor use the Primary Sidebar fallback. Keep that declaration order and
container ID so supported editors retain their default location and users can
move the fallback container using the editor's native layout controls.

The webview has three layers:

- `main.ts` connects VS Code messages, focus, and shortcuts.
- `workspace-controller.ts` owns workspace mutations and requests persistence.
- `ui/` renders reusable controls, the workspace rail, panes, splits, and menus.

`terminal-frontend.ts` owns xterm instances, output buffers, fitting, and input
focus. It does not read or persist workspace layout. `layout.ts` contains the
recursive tree helpers. `terminal-theme.ts` translates VS Code terminal settings.

The sidebar and floating `WebviewPanel` share one extension-host backend. Moving
between them drains pending layout mutations, saves state, and recreates only
the frontend. Each frontend has a client ID so messages from a replaced webview
cannot change the active layout. VS Code's native editor move command opens the
floating window; closing its panel returns GaoGrid to the sidebar. Title-bar menu
actions, rail buttons, and shortcuts use the same handoff.

Terminal creation resolves cwd through an asynchronous host request before adding
the tab. Lifecycle mutations are serialized, while tab/workspace selection stays
immediate. Tab, pane, and workspace closure share `TerminalLifecycle` in the
extension host. The webview removes layout and xterm surfaces only after that
operation succeeds; cancellation leaves the view unchanged.

`CwdResolver` resolves directories on demand using recent passive OSC 7 reports,
process inspection, and the last known directory. `OscCwdParser` only reads OSC 7
without changing output. Each tab stores one `cwd`; the host merges known session
directories when saving the layout. Directory reports checkpoint host metadata and update the webview without changing layout.
`hasActiveTask` checks a single OS snapshot when closing or promoting. For a protected tab it inspects tmux's pane shell PID, rather than the attach client. `PtyManager` starts the
shell normally, sends SIGHUP on closure, then reinspects and cleans up confirmed
surviving PIDs individually. It never signals process groups.
Saved layouts are validated on recovery, with a fallback to the original v1 storage key. Layout recovery is separate from output snapshots; application commands are never rerun.

### UI Rules

- Use `createControl` for tab labels, workspace labels, and icon actions.
- Controls are 20px high, with 12px workspace/tab labels and 14px icons. Pane headers
  grow naturally from their controls and 4px bottom padding; the rail grows from
  its labels and inline padding. Do not calculate header heights or rail widths.
- Icons use SVG assets from `@vscode/codicons` in shared 14px boxes. `ui/icons.ts`
  centers each asset's visible bounds in its original viewBox without changing
  scale, then caches the template. Buttons use flex alignment; do not center
  icons with per-button pixel offsets or font baseline adjustments.
- The application shell owns the outer right and bottom 4px gutters. HTML
  generation must not add inline root resets that override the stylesheet.
- Top spacing belongs to the workspace stage and split structure. The stage
  gives the first tab row a 4px top gutter; individual panes have no top padding.
- Header controls align with the terminal surface's outer left and right edges.
  Terminal text keeps its own 4px inner padding.
- Chrome colors use the editor's `--vscode-*` theme variables in both VS Code and
  compatible editors such as Cursor. Controls have a subtle theme-relative
  resting background; hover, selection, menus, and focus use native theme tokens.
  High-contrast themes also supply control borders. Workspace and pane boundaries
  have no permanent separators.
- A focused terminal gets an inset 1px border without changing its size.
- Terminal surfaces, toolbar popovers, and context menus all use the shared
  `--gg-terminal-radius` token.
- Splits reserve a shared 4px structural gutter before distributing the pane
  ratio. Horizontal sashes fill the gap between an upper terminal and the next
  tab row without adding extra spacing. Vertical sashes begin level with tab
  labels. Both keep a 10px transparent pointer target and 4px hover line.
- Sash highlights and resize cursors appear after 200ms of hover. Leaving cancels
  the delay; dragging starts immediately and keeps the highlight visible. Hover
  and drag colors use VS Code's `sash.hoverBorder` theme color.
- Terminal hosts observe their own size and refit after fonts load. A 6px native
  scrollbar overlays the grid and synchronizes through xterm's scrollback API.
  `terminal-fit.ts` fits full-width columns without xterm's scrollbar reservation;
  the character grid can still leave less than one character of unused width.
- Both menu entry points use `MenuController`, including viewport positioning,
  keyboard navigation, focus return, and dismissal cleanup. Toolbar menus align
  with the header's actual bottom edge; viewport clearance reads the CSS spacing
  token rather than maintaining a separate hardcoded offset.
- Keep keyed DOM elements when updating. Terminal mounts are stable, tab clicks
  activate immediately, and double-click closing uses the same button node.

File names use kebab-case; classes and interfaces use PascalCase.

`⌘+` / `⌘-` change the focused terminal tab's font size in 1px steps. `⌘0`
restores `terminal.integrated.fontSize`. These overrides stay with the live tab
when switching panes or workspaces, and theme updates preserve them. The UI
controls keep their original size.

Terminal font settings come from `terminal.integrated`; an unset font family
inherits `editor.fontFamily`, as in VS Code's terminal. Colors follow VS Code's
terminal theme variables, including `workbench.colorCustomizations`. Live theme
updates preserve each tab's temporary font-size override.

Rendering follows `terminal.integrated.gpuAcceleration`: `auto`/`on` use WebGL
when available, while `off` uses xterm's DOM renderer. Glyphs use an opaque
background for antialiasing; inline images keep their own transparent overlay.
Font loading clears glyph textures before refitting so fallback glyphs are not
cached after the configured font becomes available.

File and folder drops insert shell-quoted paths through xterm's paste API, with
no trailing newline. Drop payload formats are read synchronously in the drop
handler; VS Code's `resourceurls` format is preferred to preserve multi-file
and folder selections. Webviews can only handle Explorer drops that the
workbench forwards, so Explorer's **Copy Path** command is the fallback when a
VS Code build suppresses a drag. When macOS exposes only names, `native-drop.ts`
reads file URLs from the drag pasteboard using AppKit and checks the complete
name list.
Other unresolved drops use a native picker. File contents are never read or
uploaded, and the general clipboard is never accessed.

Planned work is tracked in the [project TODO](../README.md#todo).

### Protected Sessions

`TerminalTab.backend` distinguishes `direct` and `tmux`; backend identifiers and
creation/update timestamps live in VS Code workspace storage. `TmuxBackend` owns
capability detection, controlled server configuration, ownership verification,
history capture, and session creation/destruction. Every protected tab owns one
tmux session/window/pane, independently of the GaoGrid split tree.

The controller serializes protection with existing creation and close mutations.
Busy protection can create a separate tab in the original pane using the original
tab's cwd, even if another tab becomes active while the dialog is open. Idle
promotion prepares and attaches the candidate backend before a final idle/input
revision check. Input during that check is buffered. Failure leaves the direct
PTY usable; successful promotion keeps the existing xterm and tab identity.

On host recovery, tmux history (excluding its live screen) precedes attach's
screen redraw. Reattachment resets the frontend before that replay; existing
GaoGrid snapshots are not overlaid on a surviving tmux session. Webview recreation
replays the existing client buffer without detaching it. Hidden tabs receive the
visible terminal's pane dimensions. Normal extension shutdown detaches protected
clients; only the explicit lifecycle close path destroys their tmux sessions.

Tab context menus use the shared menu controller and support Shift+F10. Protection
controls are absent without tmux. Disconnected protected tabs retain identifiers
and offer reconnection. Owned orphan sessions are logged and left running.
**Remove Protection** is available from the tab context menu. It is refused
while a task is active; after confirmation on an idle shell, it destroys the
protected session and starts a fresh direct shell in the same tab, restoring the
captured terminal output before the new shell prompt.

### Output Recovery

`TerminalHistory` uses headless xterm plus SerializeAddon to maintain rendered
cells, colors and up to 10,000 lines of scrollback. It excludes protocol queries
and application input modes from saved output. Live webview replay separately
preserves the application's alternate screen and input/mouse modes. An old alternate application
screen becomes normal text history before starting a fresh direct shell.

`TerminalOutputStore` saves bounded snapshots atomically with same-user file
permissions under VS Code storage. `PtyManager` checkpoints direct tabs while
output arrives and flushes on shutdown. Explicit close deletes their snapshots.
Protected reattachment continues to use tmux as its authoritative recovery source.

Host-to-webview data is published after its headless parse completes. Snapshot
callbacks form a replay barrier: output before the barrier is included once in
replay; later output follows as live data. Saved dimensions are applied before
replay and fitting resumes after the serialized output has been parsed. This
avoids truncating a raw escape stream or losing output during the handshake.
