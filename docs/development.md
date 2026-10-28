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

Packaging and publishing require Node.js 22 or later. The commands use a compatible
4.x version of `@vscode/vsce` through `npx`; npm downloads the tool on first use.

```sh
npm run package
```

This runs the existing `vscode:prepublish` build and creates
`gaogrid-<version>.vsix` in the project root, using the version from `package.json`.
Relative documentation links in the packaged README point to the `main` branch.
To choose another output path, use `npm run package -- --out /path/to/gaogrid.vsix`.
The prepublish hook repairs the node-pty helper's executable bit before
packaging; the running extension never mutates files under `node_modules`.

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

`terminal-frontend.ts` owns xterm instances, output subscriptions, fitting, and input
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
- Controls are 20px high, with 12px workspace/tab labels. Pane headers
  grow naturally from their controls and 4px bottom padding; the rail grows from
  its labels and inline padding. Do not calculate header heights or rail widths.
- Terminal tabs size to their contents with 6px horizontal padding on each side.
- Icons use SVG assets from `@vscode/codicons` in shared 14px boxes. `ui/icons.ts`
  centers each asset's visible bounds in its original viewBox without changing
  scale, then caches the template. Protected-session shields inside terminal tabs
  use 12px boxes. Buttons use flex alignment; do not center icons with per-button
  pixel offsets or font baseline adjustments.
- The application shell owns the outer right and bottom 4px gutters. HTML
  generation must not add inline root resets that override the stylesheet.
- Top spacing belongs to the workspace stage and split structure. The stage
  gives the first tab row a 4px top gutter; individual panes have no top padding.
- Header controls align with the terminal surface's outer left and right edges.
  Terminal text keeps its own 4px inner padding.
- Chrome colors use the editor's `--vscode-*` theme variables in both VS Code and
  compatible editors such as Cursor. Buttons have transparent resting backgrounds;
  inactive tabs keep a subtle theme-relative fill. Hover uses the toolbar hover
  color with a theme-relative fallback. Selected tabs retain their selection
  colors on hover and are the only controls with an inset border. Their border
  uses `contrastActiveBorder`, falling back to `focusBorder`; Cursor Dark High
  Contrast uses `contrastBorder` because its focus border is transparent. Menus
  and focus use native theme tokens. Workspace and pane boundaries have no
  permanent separators.
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
- Terminal hosts observe their own size and refit after fonts load. Use xterm's
  built-in scrollbar with a slim, rounded 6px thumb. `terminal-fit.ts` reserves
  a matching 6px gutter so the scrollbar does not cover the final text column;
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

`terminal-input.ts` handles keyboard input through xterm's public
[`attachCustomKeyEventHandler` and `input` APIs](https://xtermjs.org/docs/api/terminal/classes/terminal/).
On macOS, ordinary punctuation waits for the browser's committed text instead
of xterm's early keydown encoding, preserving the input method's full-width or
half-width choice. A capture-phase
[`beforeinput` handler](https://developer.mozilla.org/en-US/docs/Web/API/Element/beforeinput_event)
consumes the committed text once, with `input` handling non-cancelable insertions.
Composition, dead-key completion, letters, control keys, and modifier chords stay
on xterm's existing paths. Shift+Enter retains its CSI-u encoding. The input
listeners follow the terminal host's mount and disposal lifecycle.

Terminal CSS disables contextual CJK punctuation compression with
`text-spacing-trim: space-all`. In newer Chromium versions, the DOM renderer's
repeated-glyph measurements otherwise disagree with the rendered widths of
characters such as `（）` and `，。`, shifting displayed text away from the cursor
grid and IME preview. This property also reaches xterm's width-measurement
elements through inheritance. See the
[upstream width-cache report](https://github.com/xtermjs/xterm.js/issues/6058).
When checking IME input manually, include mixed ASCII, Chinese text, full-width
brackets and punctuation, and an uncommitted composition after that text with
GPU acceleration off, so the DOM renderer is exercised.

Planned work is tracked in the [project TODO](../README.md#todo).

### Protected Sessions

`TerminalTab.backend` distinguishes `direct` and `tmux`; protected tabs also
record `transport` as `control` or `attach`. Backend identifiers and
creation/update timestamps live in VS Code workspace storage. `TmuxBackend` owns
capability detection, controlled server configuration, ownership verification,
history capture, and session creation/destruction. Every protected tab owns one
tmux session/window/pane, independently of the GaoGrid split tree.

`TmuxControlProcess` connects through tmux's control protocol when control mode
is selected, while native attach remains available as an explicit setting and
automatic startup fallback. Control framing lives in
`tmux-control-protocol.ts`. The process decodes raw
`%output` records, preserving output that an ordinary attach client's screen
redraws may coalesce. Input is encoded as literal hexadecimal bytes with
`send-keys -H`; the control client reports size changes with `refresh-client -C`.
Normal and alternate-screen escape sequences reach xterm directly.

`TmuxOutputFilter` uses `@ansi-tools/parser` to classify control sequences rather
than matching handwritten byte strings. It suppresses direct device-attribute,
status, cursor-position, and default-color queries that tmux already answers.
Queries inside tmux passthrough strings remain available to xterm.
The webview supplies its default foreground and background at startup and on
theme changes. Control clients report them with `refresh-client -r` on tmux
3.5 and newer; older versions use pane styles. This keeps tmux's OSC 10/11
answers consistent with the editor, so applications can choose matching colors.

The controller serializes protection with existing creation and close mutations.
Busy protection can create a separate tab in the original pane using the original
tab's cwd, even if another tab becomes active while the dialog is open. Idle
promotion prepares and attaches the candidate backend before a final idle/input
revision check. Input during that check is buffered. Failure leaves the direct
PTY usable; successful promotion keeps the existing xterm and tab identity.

On host recovery, an ordered control-command batch captures pane metadata,
the saved normal screen, pending parser bytes, and the active screen with up to
10,000 history lines. `tmux-snapshot.ts`
reconstructs those buffers and their supported input modes before subsequent
pane output is delivered. Pending escape prefixes are prepended to the first live
continuation. Reattachment resets the frontend before that replay;
existing GaoGrid snapshots are not overlaid on a surviving tmux session. Webview recreation
replays the existing client buffer without detaching it. Hidden tabs receive the
visible terminal's pane dimensions. Normal extension shutdown detaches protected
clients; only the explicit lifecycle close path destroys their tmux sessions.

The settings control above the detach button stores new-terminal defaults in user
settings: protected or direct, control or attach, tmux Mouse On/Off, and mouse
priority. The tmux Mouse control is always visible, defaults to On, and applies
immediately to protected sessions in either transport. Scroll Behavior applies to
Direct sessions and Control mode; its controls remain visible but disabled in
Attach mode, where tmux handles scrolling. App First is the default: applications
receive requested wheel events, while Shift-wheel uses terminal scrolling. When
an alternate screen has no scrollback, terminal scrolling sends Up/Down keys.
Option-drag retains text selection on macOS.

The section's info icon explains the xterm.js terminal, isolated tmux server and
configuration, and tmux 3.2a requirement. An unavailable or unsupported tmux leaves
the menu visible with its choices disabled; Direct sessions remain available.
The legends identify built-in defaults with ○ and recommendations with ★,
independently of the highlighted current choice.

Control-mode initialization or protocol failure automatically falls back to
native attach without destroying tmux. The per-process fallback marks the tab
shield yellow and can be retried from that shield; it is not persisted through a
VS Code restart. Missing tmux, unsupported versions, ownership failures, and
permission errors are not downgraded. tmux 3.2a is the minimum protected-session
version, while tmux 3.8 is the continuously verified version.

Tab context menus use the shared menu controller and support Shift+F10. Protection
controls are unavailable without a supported tmux. Disconnected protected tabs retain identifiers
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

Both frontend and headless terminals activate the Unicode 11 width provider
before parsing any output or replay. This keeps Emoji cell widths consistent
with shells such as macOS zsh, including right-prompt cursor movement.
Snapshots saved with the previous Unicode 6 provider are still replayed; they
are not discarded. Their old wrapping or already overwritten text cannot be
reconstructed, but the recovery notice and fresh shell start on new lines so
the old cursor position does not carry into the new prompt.

Unicode 11 is a code-point width provider, not a grapheme-cluster implementation.
Chinese characters, combining accents, and the observed single-code-point Emoji
have regression coverage. Skin-tone and ZWJ sequences such as `👍🏽` and `👩‍💻`
retain their text but currently occupy four cells, which can differ from a
shell's or tmux's width calculation. Do not patch individual symbols to conceal
that limitation.

`TerminalOutputStore` saves snapshots of up to 10 million UTF-16 code units
atomically with same-user file permissions under VS Code storage. `PtyManager`
checkpoints direct tabs every 30 seconds and flushes on shutdown. A snapshot
exceeding the limit drops the oldest scrollback and reports truncation. Explicit
close deletes their snapshots.
Protected reattachment continues to use tmux as its authoritative recovery source.

Host-to-webview data is published after its headless parse completes. Snapshot
callbacks form a replay barrier: output before the barrier is included once in
replay; later output follows as live data. Saved dimensions are applied before
replay and fitting resumes after the serialized output has been parsed. This
avoids truncating a raw escape stream or losing output during the handshake.

### Output Flow Control

Mounted terminals subscribe through `TerminalOutputStream`. A subscription starts
with a parsed live snapshot delivered in bounded chunks and then receives ordered
output. Unmounted tabs
keep only the host's parsed history; mounting requests a fresh snapshot rather
than retaining an arbitrary raw string tail. Hidden mounted terminals still
parse and acknowledge output without opening a renderer.

Each subscription has a generation ID and cumulative string-unit sequence.
The frontend acknowledges output only from xterm's `write` completion callback.
Old generations, duplicate ACKs, and future ACKs cannot release current credit.
Recreating or moving the webview clears subscriptions and their pending credit,
without restarting the PTY. Failed delivery releases credit as well.

`TerminalOutputFlow` counts pending headless parsing plus unacknowledged frontend
output. It pauses reads at 32 MiB string units per terminal and resumes at 8 MiB;
a shared 128 MiB budget pauses background terminals before the visible one.
Direct sessions pause node-pty; protected sessions pause the control client's
stdout pipe. These are watermarks, not exact memory caps: a read may cross the
threshold, and a bounded snapshot can be larger. This follows the
[xterm flow-control guide](https://xtermjs.org/docs/guides/flowcontrol/).
Both transport tests withhold ACKs to verify application pending output stops,
then check more than 12 MiB of resumed output for exact ordering and completeness.
The application pending-byte bound does not establish a memory limit for tmux's
server-side output queues while a control client is paused. Attempts to disable
or pause the pane at this layer were rejected because tmux omits output produced
while that client is paused.

Text input remains UTF-8. xterm's public `onBinary` event travels through the same
input channel with a binary flag; the host writes a Latin-1 `Buffer` to preserve
legacy mouse-report bytes such as `0x80` and `0xff`. Modern SGR reports remain on
the normal text path. See the
[xterm binary-input API](https://xtermjs.org/docs/api/terminal/classes/terminal/#onbinary).
