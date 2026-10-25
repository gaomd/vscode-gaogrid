# Terminal Notifications

Status: planned. This document describes future implementation, not an existing
GaoGrid feature.

GaoGrid will react to explicit notifications from terminal applications and
scripts. The initial implementation will support OSC 9 and OSC 777, tab and
workspace unread indicators, and VS Code notifications with an action to open
the originating terminal.

Notification state will live only in Extension Host memory. Restarting VS Code
or the Extension Host will clear it. Notifications will not be included in
workspace metadata, terminal snapshots, or protected session recovery.

## Scope

V1 will provide:

- OSC 9 and OSC 777 notification input for Direct and Protected Sessions, where
  the application and tmux transport deliver those sequences.
- A subtle unread indicator on the originating tab and its workspace.
- A VS Code notification with an **Open Terminal** action.
- Focus-aware suppression, duplicate suppression, and notification rate limits.
- Notification state that follows a terminal when it moves between panes or
  workspaces.

V1 will not include screen detection, inferred agent states, a notification
history panel, native operating system notifications, a GaoGrid CLI, or automatic
changes to agent configuration. Codex, Claude Code, builds, and custom scripts
will use the same generic notification mechanism.

## Architecture

```text
Application / script
        │
        └── OSC 9 / OSC 777
                    │
              tmux, if protected
                    │
               node-pty output
                    │
        Extension Host OSC parser
                    │
          NotificationService
                    │
          ┌─────────┴──────────┐
          │                    │
    Unread indicators    VS Code notification
                         → Open Terminal
```

Parse events in the Extension Host so background terminals can notify even when
their xterm surface is not mounted or the GaoGrid webview is closed.

`TerminalHistory` already uses headless xterm to parse each PTY's output. Reuse
its OSC handler API rather than scanning rendered lines or adding a separate
notification escape parser. Keep parsing separate from notification policy and
UI rendering.

The PTY owner supplies the terminal identity. Application payloads cannot choose
another terminal, pane, or workspace as their notification target. Ignore events
from closed or replaced backend bindings.

## Event Model

The normalized event can start with:

```ts
interface TerminalNotification {
  id: string;
  terminalId: string;
  title?: string;
  body: string;
  source: "osc9" | "osc777";
  receivedAt: number;
}
```

GaoGrid assigns `id`, `terminalId`, and `receivedAt`. Resolve the current pane and
workspace from the terminal's location when displaying or opening a notification.

OSC input does not reliably identify an agent or provide a semantic category.
Do not infer `complete`, `attention`, or `error` from the text. A future explicit
API may add optional categories without changing the generic notification path.

Treat title and body as plain text. Bound payload sizes, ignore malformed input,
and never interpret notification content as HTML, commands, or executable links.

## Supported Protocols

| Protocol | Notification Form                    | Available Content |
| -------- | ------------------------------------ | ----------------- |
| OSC 9    | `OSC 9 ; message ST`                 | Body              |
| OSC 777  | `OSC 777 ; notify ; title ; body ST` | Title and body    |

Accept BEL and ST terminators and sequences split across PTY output chunks. For
OSC 777, preserve semicolons in the body after parsing the command and title.
Ignore unsupported OSC 777 commands and empty notifications.

OSC 9 also has control subprotocols, including `9;4` progress updates. These must
not become notifications. A standalone BEL is only a terminal bell; it must not
be presented as an agent completion or attention event.

Direct Session examples:

```sh
printf '\033]9;Task complete\007'
printf '\033]777;notify;Build;Build complete\007'
```

OSC 99 can be considered later if richer notification metadata is needed.

## Unread And Focus Behavior

Keep unread state and bounded duplicate/rate-limit bookkeeping in the
`NotificationService`, keyed by terminal identity. No full notification history
is needed for V1.

- When the target terminal has keyboard focus in the focused VS Code window,
  suppress the toast and do not mark it unread.
- Otherwise, mark that terminal unread and show a rate-limited VS Code toast.
- Clear a terminal's unread state when it actually receives keyboard focus.
  Selecting its workspace alone must not clear notifications on hidden tabs.
- Compute workspace unread indicators from their current member terminals.
  Moving a tab carries its unread state to the destination workspace.
- **Open Terminal** reveals GaoGrid, activates the current workspace and tab,
  and focuses that terminal. If the terminal has closed, the action does nothing.
- Closing a terminal removes its unread and notification bookkeeping.
- Webview recreation resynchronizes indicators from the existing host service
  without redisplaying notifications. Host restart starts with empty state.

Use one unread dot per tab and workspace rather than accumulating an unlimited
count. Expose unread state in accessible labels as well as visual styling. Keep
existing tab and workspace click behavior for navigation.

Coalesce repeated identical events and limit toast frequency per terminal and
across the extension. Rate limiting must not prevent unread indicators from
updating, and notification processing must not block terminal output.

Agent notification emission and GaoGrid display suppression are separate. Verify
focus reporting across terminal, tab, pane, workspace, webview, and VS Code
window changes. Reuse xterm's DECSET 1004 focus reporting where possible; verify
tmux's `focus-events` behavior for protected applications. The existing
`gaogridFocus` shortcut context alone does not describe which terminal is focused.

## Live Output And Recovery

Only live PTY output may create notification events. Suppress events while
loading saved output, initializing history, replaying a webview snapshot, or
restoring output during protection changes. Backend promotion must not publish
events from both the old and new bindings.

Recreating a webview must not parse old notifications into new service events.
Terminal output recovery and notification state remain separate.

If VS Code or the Extension Host is closed, a protected application may continue
running in tmux, but V1 does not queue notifications for later delivery. tmux
history is not a notification queue. Reattachment must not generate notifications
from old terminal output.

## Protected Session Transport

GaoGrid's private tmux configuration already enables `allow-passthrough`.
Passthrough still requires the sender to wrap the OSC sequence in tmux's DCS
format; the option does not make all plain OSC sequences pass through.

Example for a Protected Session:

```sh
printf '\033Ptmux;\033\033]777;notify;Build;Build complete\007\033\\'
```

Verify wrapped and plain application output separately. If an application emits
a sequence that tmux discards, an OSC handler after tmux cannot recover it.
Document the actual application/version behavior instead of claiming universal
Direct/Protected parity. Keep the dedicated GaoGrid tmux namespace and controlled
configuration.

## Codex Compatibility

Current official documentation describes TUI notifications, an `auto` transport
that chooses OSC 9 or falls back to BEL, and an `unfocused` emission condition by
default. The sample configuration documents notifications as enabled by default;
installed versions and user overrides still need to be checked.

Do not assume `auto` will select OSC 9 merely because GaoGrid implements it. Test
the installed Codex version in Direct and Protected Sessions, including whether
its tmux output is wrapped correctly.

For a controlled manual test, temporarily use these settings in an existing
`[tui]` section, then restore the user's previous values:

```toml
[tui]
notifications = true
notification_method = "osc9"
notification_condition = "always"
```

Then test normal `auto` / `unfocused` behavior separately. GaoGrid will not modify
`config.toml` automatically or claim zero-configuration compatibility before
these paths are verified.

## Notification Presentation

Use VS Code's notification API with an **Open Terminal** action. Include the tab
or workspace as context and preserve the application's supplied title and body.
Notification text must not steal terminal focus.

VS Code notifications are distinct from native operating system notifications.
V1 does not promise Notification Center delivery when VS Code is in the
background. A native notification adapter would require separate platform and
Remote SSH / Dev Container design.

## Implementation Order And Effort

| Work                                                              | Estimated Effort |
| ----------------------------------------------------------------- | ---------------- |
| OSC handlers, event normalization, in-memory service, rate limits | 0.5–1 day        |
| Tab/workspace indicators, read behavior, notification navigation  | 0.5–1 day        |
| Focus, tmux, recovery handling, and validation                    | 1–2 days         |

The estimated V1 total is 2–4 development days, subject to application and tmux
compatibility findings. Native notifications and CLI / hook integrations are
outside this estimate.

## Acceptance Checks

- OSC 9 and OSC 777 work with BEL and ST terminators, chunked input, Unicode,
  and semicolons in the body. Malformed, oversized, empty, and unsupported input
  does not trigger notifications or interfere with output.
- OSC 9 progress/control sequences and standalone bells do not become agent
  notifications.
- Background tabs and workspaces receive the correct indicators. Focusing the
  originating terminal clears its indicator; unrelated unread tabs stay unread.
- Moving a tab updates the workspace indicators and preserves notification
  navigation. Closing it removes state and invalidates stale actions.
- **Open Terminal** works when another workspace is selected or GaoGrid is
  hidden. Notifications do not change focus before that action is selected.
- Repeated notification bursts remain bounded while unread indicators update.
- Webview recreation preserves current unread state without repeated toasts.
  VS Code and Extension Host restarts clear all GaoGrid notification state.
- Saved-output recovery, protected reattachment, promotion, and removal of
  protection do not replay old notifications.
- Wrapped OSC works through the dedicated tmux server. Record actual Codex
  transport and focus behavior in both Direct and Protected Sessions.
- In Remote SSH / Dev Containers, parsing stays beside the PTY in the workspace
  Extension Host and notification presentation reaches the local VS Code UI.

## Future Extensions

A `gaogrid notify` CLI could feed the same service through an authenticated local
IPC endpoint, avoiding tmux OSC forwarding for hooks. It would need terminal
identity, socket lifecycle, and remote environment handling. Optional agent
integrations could use that API with explicit user installation.

Explicit agent-state reports could be added if a concrete feature needs them.
Screen manifests and inferred working/idle/blocked states are not part of this
design.

## References

- [tmux Passthrough FAQ](https://github.com/tmux/tmux/wiki/FAQ#what-is-the-passthrough-escape-sequence-and-how-do-i-use-it)
- [cmux Notifications](https://cmux.com/docs/notifications)
- [Herdr Agents](https://herdr.dev/docs/agents/)
- [Herdr Integrations](https://herdr.dev/docs/integrations/)
