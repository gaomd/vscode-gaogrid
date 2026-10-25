# Protected session compatibility

Protection is explicit opt-in. Direct tabs run the shell through node-pty;
protected tabs run an isolated tmux attach client through node-pty. GaoGrid owns
all workspaces, split trees, panes, and tabs. No tmux layout is exposed.

## Recovery and history

- Live protected sessions survive VS Code quit and Extension Host termination.
  Metadata is kept in VS Code workspace storage, outside the project repository.
- Reloading just the webview keeps the attach client alive. After a host restart,
  tmux history and the current screen are authoritative. No disk output snapshot
  is replayed over a surviving session.
- Protection retains the direct terminal's existing frontend history for that
  live view. Output from before promotion is not imported into tmux and is not
  recovered after a host restart. V1 does not keep disk scrollback snapshots.
- A missing session starts a new protected shell, with a clear notice. Nothing
  reruns or resumes the previous application. OS reboot ends tmux processes.
- Explicit tab/pane/workspace closure destroys the corresponding owned sessions
  after the existing task confirmation. VS Code shutdown only detaches clients.
- Idle detection requires a known shell and an inspectable process snapshot.
  Unknown state cannot be promoted. Foreground jobs and attached background jobs
  block promotion. Fully detached daemons and long-running shell builtins without
  child processes remain outside existing process-based task detection.

## Protocols

The automated integration suite uses real node-pty clients and tmux 3.8 on macOS,
with bash and zsh. This is the tested environment, not a minimum version claim.
Options unavailable in older tmux versions are optional; upgrade tmux when a
particular passthrough or extended-key feature is required.

| Feature                | Validation and limitations                                                                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| True color / 256 color | Automated capture verifies RGB and palette values.                                                                                                       |
| Unicode / Chinese      | Automated text round-trip verifies preservation.                                                                                                         |
| Nerd Font glyphs       | Code point preserved in capture; rendering still requires an installed font.                                                                             |
| Mouse interaction      | Automated application SGR mouse event round-trip. tmux's own mouse UI is disabled.                                                                       |
| Bracketed paste        | Automated payload and delimiter round-trip.                                                                                                              |
| Shift+Enter            | Automated modified Enter round-trip on tmux 3.8 (CSI-u input, application-requested xterm extended keys). Older tmux support varies.                     |
| Alternate screen / vim | Real vim edit/save and resize test.                                                                                                                      |
| OSC 7 cwd              | Existing OSC parser plus tmux pane cwd inspection; tmux may consume the OSC itself.                                                                      |
| Clipboard / OSC 52     | Passthrough enabled where supported; the existing xterm frontend does not implement OSC 52 clipboard writes.                                             |
| SIXEL                  | Depends on tmux build/version or application passthrough. Not verified for visual parity.                                                                |
| iTerm inline images    | Requires application tmux passthrough; not verified for visual parity.                                                                                   |
| Kitty graphics         | The current xterm ImageAddon does not provide native Kitty graphics rendering, including in direct tabs.                                                 |
| nvim / htop            | Not available in the automated test environment; interactive validation remains manual.                                                                  |
| Codex / Claude Code    | General task persistence and modified-key transport are tested. Full application UI/restart scenarios remain manual. GaoGrid never runs resume commands. |
| ssh                    | Process ownership/persistence follows the same tmux path. A connection can still fail independently; live remote-session validation remains manual.      |

`allow-passthrough` is enabled when tmux supports it. Terminal applications must
use their tmux-aware passthrough mode for protocols tmux does not understand.
Passing bytes does not establish image rendering parity. Use Direct Sessions
when graphics compatibility is essential.

## Validation

`npm test` verifies environment-local capability detection, direct sessions with
no tmux, same-tab promotion, busy-task rejection, direct protected creation,
creation/attach failure rollback, reconnect retry, missing-session fallback,
metadata recovery, workspace cancellation/confirmation, session ownership and
server isolation, task survival after graceful detach and force-killed host,
process identity on reattach, explicit destruction, resizing, and protocols above.

For release validation in a VS Code Extension Development Host:

1. Protect an idle tab after `cd`, then run Codex or Claude Code. Reload the
   window, restart the Extension Host, and quit/reopen VS Code. Verify the same
   process, tab, pane, cwd and interactive application state.
2. Try protection while an application or background job runs; cancel, then use
   **Open Protected Tab** and check the original task remains untouched.
3. Close a busy protected tab or workspace, cancel, then confirm. Verify only the
   confirmed GaoGrid sessions are destroyed and normal tmux sessions remain.
4. Exercise mouse, paste, alternate screen, ssh, nvim, htop, clipboard and each
   graphics protocol on the target OS and installed tmux version.
5. Destroy one test session externally to simulate its loss, then reopen GaoGrid.
   Verify the fresh-shell notice and that the previous application is not rerun.
6. Repeat without tmux, and in Remote SSH / Dev Containers, to verify capabilities
   follow the terminal execution environment.
