# xterm 6 compatibility audit

This audit accompanies GaoGrid 0.5.0. It checks the browser and headless terminals
at 6.0.0, fit addon 0.11.0, serialize addon 0.14.0, and Unicode 11 addon 0.9.0.
These are the versions tested for this release; dependency declarations use
compatible `^` ranges.

## How the old baseline happened

The AI-generated initial commit, `056df08` on 2026-10-25, introduced xterm 5.5.0,
Codicons 0.0.36, TypeScript 5.5, and esbuild 0.21.5. It documented no compatibility
constraint or review of current upstream releases for that selection. Later
headless-history and addon work followed the same xterm generation.

The project accumulated fixes for terminal input, Unicode widths, layout, and
recovery before revisiting that initial dependency choice. Starting from stale
AI-generated defaults made the investigation harder: each fix needed to be
checked again against current upstream behavior. This was avoidable work, and it
should be visible in the release history rather than buried in a routine version
bump.

The audit also establishes the limits of that conclusion. An old starting point
does not prove that every issue was caused by the old version or that upgrading
allows every workaround to be removed.

## Results

| GaoGrid behavior                                  | xterm 6 evidence                                                                                                                                                                    | Decision                                                                                           |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Unicode 11 in browser and history terminals       | A real headless terminal still defaults to Unicode 6. Writing `🐍📦` advances two columns; enabling Unicode 11 advances the expected four.                                          | Keep the addon and explicit activation in both terminals.                                          |
| Browser-committed macOS punctuation               | Exercising xterm 6's keydown handler with an ordinary comma sends ASCII `,` and cancels the event. Its input handling still does not wait for the browser's punctuation conversion. | Keep native committed-text handling. Real IME behavior also needs browser validation.              |
| Distinct Shift+Enter input                        | The same handler encodes Shift+Enter as carriage return, rather than GaoGrid's CSI-u sequence.                                                                                      | Keep GaoGrid's input mapping for applications such as Codex.                                       |
| Full-width grid with an overlay scrollbar         | The stock fit addon reserves 14 pixels when scrollback is enabled. With an 800-pixel host and 10-pixel cells it proposes 78 columns; GaoGrid's fit addon proposes 80.               | Keep the fit override for the existing overlay-scrollbar design.                                   |
| CJK punctuation width alignment                   | The DOM renderer still measures runs of 32 repeated glyphs. Its stylesheet does not set `text-spacing-trim`; the browser-dependent compression path remains.                        | Keep `text-spacing-trim: space-all`. This audit does not claim a fresh visual or IME verification. |
| Snapshot mouse encoding and cursor visibility     | With mouse tracking, SGR encoding, and a hidden cursor enabled, serialize 0.14.0 preserves tracking but omits `?1006h` and `?25l`.                                                  | Keep explicit encoding-mode and cursor-state serialization.                                        |
| Parsed recovery snapshots and output backpressure | These coordinate PTYs, disk storage, extension-host messages, and frontend parse acknowledgments across GaoGrid's process boundaries.                                               | Keep the integration. An xterm upgrade does not replace it.                                        |
| Sidebar focus and tmux session recovery           | These depend on VS Code view visibility and GaoGrid-owned backend sessions.                                                                                                         | Keep the integration.                                                                              |

## Validation and limits

All 133 existing tests passed against the updated dependencies, including real
zsh/bash PTYs, protected tmux sessions, snapshot recovery, Unicode widths, binary
mouse input, and delayed frontend acknowledgments.

Additional diagnostic experiments exercised real xterm 6 headless parsing and
serialization. The keydown and fit comparisons used the actual upstream
implementations with minimal environment stubs. Upstream source was inspected
from the published packages' embedded source maps. These checks establish the
specific results above; they do not replace a browser rendering, WebGL, or macOS
IME check in the Extension Development Host.
