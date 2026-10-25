# GaoGrid webview

The webview has three layers:

- `main.ts` connects VS Code messages, focus, and shortcuts.
- `workspace-controller.ts` owns workspace mutations and requests persistence.
- `ui/` renders reusable controls, the workspace rail, panes, splits, and menus.

`terminal-frontend.ts` owns xterm instances, output buffers, fitting, and input
focus. It does not read or persist workspace layout. `layout.ts` contains the
recursive tree helpers. `terminal-theme.ts` translates VS Code terminal settings.

Terminal creation resolves cwd through an asynchronous host request before adding
the tab. Lifecycle mutations are serialized, while tab/workspace selection stays
immediate. Tab, pane, and workspace closure share `TerminalLifecycle` in the
extension host. The webview removes layout and xterm surfaces only after that
operation succeeds; cancellation leaves the view unchanged.

`CwdResolver` resolves directories on demand using recent passive OSC 7 reports,
process inspection, and the last known directory. `OscCwdParser` only reads OSC 7
without changing output. Each tab stores one `cwd`; the host merges known session
directories when saving the layout. Directory reports checkpoint host metadata and update the webview without changing layout.
`hasActiveTask` checks a single OS snapshot when closing. `PtyManager` starts the
shell normally, sends SIGHUP on closure, then reinspects and cleans up confirmed
surviving PIDs individually. It never signals process groups.
Saved layouts are validated on recovery, with a fallback to the original v1 storage key. Only metadata is recovered; application commands are never replayed.

## UI rules

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
- Every control has a very light resting background; hover and selection use
  shared surface tokens. Workspace and pane boundaries have no permanent
  separators.
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
no trailing newline. VS Code resource drags and file URI lists resolve directly.
If a sandboxed external file drag exposes only names, a native picker resolves
the absolute paths before insertion; file contents are never read or uploaded.

Planned shortcut configuration and session restore work is tracked in the
[project TODO](../../README.md#todo).
