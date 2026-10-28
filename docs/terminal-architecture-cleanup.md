# Terminal architecture cleanup

This document establishes the baseline for the DeepSeek V4.1 Flash 1017
refactor of the Codex-authored protected terminal implementation. It records
requirements before behavior changes so each later change can be reviewed
against the same contract.

## Baseline

- Direct terminals use node-pty.
- Protected terminals use tmux control mode and render snapshots and live
  `%output` records through xterm.
- tmux 3.8 is the continuously tested version. The minimum supported version is
  3.2a; older versions continue to support direct terminals.
- The full test suite currently has one known TODO for a UTF-8 code point split
  across a cold control-mode attachment.
- Existing Codex commits are retained. Cleanup is appended as separate commits.

## Product contract

- A protected terminal keeps up to 10,000 lines and exposes them through normal
  xterm scrolling.
- A snapshot may grow to 10 million UTF-16 code units. It is stored as plain
  JSON, saved every 30 seconds and once more during orderly extension shutdown.
- Recovery renders progressively rather than blocking on one large write.
- Control mode is the default. A control-mode initialization or protocol failure
  falls back automatically to ordinary tmux attach. The fallback is per VS Code
  process, shows a yellow shield, and is retried only when the user activates
  that shield.
- tmux absence, permissions, ownership, and protocol-integrity failures are not
  downgraded silently.

## UI settings

The controls above the detach button use grouped buttons and persist in user
settings:

- New terminals are unprotected by default; protection can become the default.
- Control mode is the default; attach mode remains available.
- Mouse policy defaults to application priority. Terminal priority and complete
  application takeover are also available.

Settings affect new terminals except mouse routing, which applies immediately.
Attach mode uses tmux's native mouse handling and disables the GaoGrid mouse
policy controls. The settings remain visible when tmux is unavailable but the
dependent options are disabled.

## Interaction baseline

- Normal-screen wheel input scrolls GaoGrid history.
- Alternate-screen wheel input reaches the application when it requested mouse
  events.
- Shift-wheel forces GaoGrid history. macOS Option-drag continues to force text
  selection.
- Discrete wheel scrolling is aligned with libghostty at approximately three
  lines per step.

## Resource limits

- Unconsumed output may grow to 32 MiB per terminal and 128 MiB globally.
- At the global limit, background tmux panes pause first; the visible terminal
  remains responsive. Paused output is resumed rather than dropped.
- Large pasted input may temporarily grow the input queue without an additional
  hard cap.

## Out of scope

- Configurable application shortcuts and AI notifications.
- Visual parity for SIXEL or iTerm inline images.
- OSC 52 clipboard writes, which remain tracked as a TODO.
- A complete terminal-state mirror. Only low-complexity state exposed natively
  by tmux is restored.
