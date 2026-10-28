# Protected Session Compatibility

Protection is opt-in by default. Direct tabs run the shell through node-pty;
protected tabs use tmux control mode with piped input and output, or native tmux
attach when selected. GaoGrid owns all workspaces, split trees, panes, and tabs.
No tmux layout is exposed.

The control-mode transport is currently a validation build. The
[validation report](protected-control-mode-validation.md) records the checks and
remaining recovery limits before release.

## Recovery and History

- Live protected sessions survive VS Code quit and Extension Host termination.
  Metadata is kept in VS Code workspace storage, outside the project repository.
- Reloading just the webview keeps the attach client alive. After a host restart,
  tmux history and the current screen are authoritative. No disk output snapshot
  is replayed over a surviving session.
- Live pane output reaches xterm before screen updates can coalesce it. Normal
  terminal scrollback retains output up to its configured 10,000-line limit.
  Applications enter and leave xterm's actual alternate screen normally.
- Protection retains the direct terminal's existing frontend history for that
  live view. Output from before promotion is not imported into tmux and is not
  recovered after a host restart. Direct tabs now checkpoint rendered output to
  disk; those snapshots are never replayed over a surviving tmux session.
- A missing session starts a new protected shell, with a clear notice. Nothing
  reruns or resumes the previous application. OS reboot ends tmux processes.
- Explicit tab/pane/workspace closure destroys the corresponding owned sessions
  after the existing task confirmation. VS Code shutdown only detaches clients.
- Idle checking requires a known shell and an inspectable process snapshot.
  Foreground jobs and attached background jobs block promotion. The detector does
  not verify that the shell is at a prompt: builtin tasks without children, such
  as `read`, can be misclassified as idle. Protection replaces the original shell,
  so use a new protected tab when the state is uncertain. Prompt/command state
  integration is deferred. Fully detached daemons are outside task detection.

Direct-session snapshots preserve rendered text and colors, not raw protocol
traffic. A previously active alternate application screen is recovered as text in
normal scrollback, so its old input/mouse modes cannot affect the new shell.
Snapshots may contain up to 10 million UTF-16 code units. Direct snapshots are
checkpointed every 30 seconds and flushed on graceful
shutdown. An abrupt host termination can lose output since the last checkpoint.
Explicit close removes the snapshot; ordinary host shutdown retains it.

## Protocols

The protected-session minimum is tmux 3.2a. The automated integration suite uses
real terminal processes and tmux 3.8 on macOS with bash and zsh; 3.8 is the
continuously verified version. Older tmux installations continue to support direct
terminals, but protection is disabled.

The tmux Mouse On/Off setting is always visible and defaults to On. It applies
immediately to protected sessions in both Control and Attach modes, independently
of the selected transport.
Scroll Behavior applies to Direct sessions and Control mode. Its choices remain
visible but disabled in Attach mode, where tmux handles scrolling.

| Feature                | Validation and limitations                                                                                                                                                                                                                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| True color / 256 color | Automated capture verifies RGB and palette values.                                                                                                                                                                                                                                                          |
| Unicode / Chinese      | Automated text round-trip verifies preservation.                                                                                                                                                                                                                                                            |
| Nerd Font glyphs       | Code point preserved in capture; rendering still requires an installed font.                                                                                                                                                                                                                                |
| Mouse interaction      | Control mode follows the selected application-first, terminal-first, or application-exclusive policy. Shift-wheel forces history; Option-drag forces selection on macOS. Native attach delegates mouse handling to tmux by default; `gaogrid.tmuxMouse` can be disabled for ordinary local xterm selection. |
| Bracketed paste        | Automated payload and delimiter round-trip.                                                                                                                                                                                                                                                                 |
| Shift+Enter            | GaoGrid forwards CSI-u input unchanged to the application.                                                                                                                                                                                                                                                  |
| Alternate screen / vim | Real vim edit/save and resize test.                                                                                                                                                                                                                                                                         |
| OSC 7 cwd              | The existing OSC parser receives pane output; tmux pane cwd inspection remains authoritative for protected sessions.                                                                                                                                                                                        |
| Clipboard / OSC 52     | Codex's built-in selection and copy path works independently. Passthrough is enabled where supported; terminal-mediated OSC 52 writes for remote applications and tmux copy-mode remain a TODO.                                                                                                             |
| SIXEL                  | Depends on tmux build/version or application passthrough. Not verified for visual parity.                                                                                                                                                                                                                   |
| iTerm inline images    | Requires application tmux passthrough; not verified for visual parity.                                                                                                                                                                                                                                      |
| Kitty graphics         | The current xterm ImageAddon does not provide native Kitty graphics rendering, including in direct tabs.                                                                                                                                                                                                    |
| nvim / htop            | Not available in the automated test environment; interactive validation remains manual.                                                                                                                                                                                                                     |
| Codex / Claude Code    | General task persistence and modified-key transport are tested. Full application UI/restart scenarios remain manual. GaoGrid never runs resume commands.                                                                                                                                                    |
| ssh                    | Process ownership/persistence follows the same tmux path. A connection can still fail independently; live remote-session validation remains manual.                                                                                                                                                         |

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
It also renders five batches of 80 files and requires every row exactly once
before and after screen transitions and reconnection. Direct and protected
output tests withhold frontend acknowledgments, then verify ordered, lossless
resumption of more than 12 MiB of text. Additional tests cover native attach,
automatic fallback, manual control refresh, version gating, chunked replay,
global output pressure, and the persistent terminal settings contract.

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
