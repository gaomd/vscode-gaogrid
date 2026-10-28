# Protected terminal control-mode validation

The regular attach client's screen redraws could omit earlier output during a
burst. A five-batch `ls` test retained all 400 entries in tmux but only 31 in the
rendered terminal. This also occurred in v0.4.0 with xterm 5.5.

Protected terminals now receive pane output through tmux's control protocol.
An initial capture restores the pane's normal history, visible screen and
supported input modes, followed by the ordered live stream. Input goes to the
owned pane as literal bytes. Direct terminals continue to use node-pty.

## Automated checks

The final isolated suite run recorded 159 passing tests, zero unexpected
failures, and one executable TODO for the UTF-8 cold-attachment case below.

- Five batches containing 400 distinct file names must render exactly once in
  the live terminal, after alternate-screen entry/exit, and after reattachment.
  Checking tmux's capture alone is insufficient.
- Initial snapshots reconstruct both buffers, cursor positions, scroll regions,
  bracketed paste and the supported mouse modes. Literal backslash-octal text
  must remain text when capture output is decoded.
- Control records are tested across chunk boundaries, including split UTF-8,
  octal escapes, data resembling protocol markers, malformed initialization,
  and byte-safe keyboard input.
- Captured incomplete escape prefixes are kept next to the first live
  continuation, so a cold attachment can complete that pending control sequence.
- Both transports withhold frontend acknowledgments, then resume more than
  12 MiB of UTF-8/Emoji output with exact ordering and content hashes. This
  measures application pending bytes, not tmux server queue memory.
- Direct queries already answered by tmux produce one reply. A wrapped
  passthrough query still reaches xterm and produces its own reply.
- Native attach selection, explicit transport persistence, automatic fallback,
  manual control refresh, tmux 3.2a gating, and libghostty-style mouse routing
  have focused regression coverage.

## Browser comparison

The isolated browser harness used Chrome 155 on macOS, the DOM renderer, a 14px
monospace font and an 80-by-24 grid. Test applications requested either no mouse
events or SGR all-motion mouse events; these reproduce the relevant terminal
modes without claiming to test an application's own UI selection logic.

| Check                                          | Direct           | Protected control client |
| ---------------------------------------------- | ---------------- | ------------------------ |
| Five `ls` batches visible in terminal history  | 400/400          | 400/400                  |
| Native scrolling through that history          | Works            | Works                    |
| Full-screen application without mouse requests | Alternate buffer | Alternate buffer         |
| Wheel key fallback for that application        | Delivered        | Delivered                |
| Application-requested mouse wheel reports      | Delivered        | Delivered                |
| Option-drag native selection on macOS          | Works            | Works                    |
| Visible scrollbar count                        | One              | One                      |

The xterm 6 small-wheel damping remains a separate issue: the controlled
30-by-1px input sequence generated no wheel report in either transport. The
transport change aligns Protected with Direct; it does not change xterm's wheel
sensitivity policy or introduce a beta dependency.

## Manual release checks

Use the installed Codex version in both Direct and Protected tabs. Verify normal
and Option-drag selection, slow and fast trackpad scrolling, keyboard input,
several `ls` batches before and after the application, resizing, tab switching,
and window reload. Restart the Extension Host and confirm process identity and
visible state. Application-specific selection, clipboard, graphics and complex
terminal-state restoration still require interactive validation before release.

Recovery restores the displayed cells and the explicitly captured mode fields,
including cursor shape and a hexadecimal cursor colour when tmux exposes them.
Dynamic OSC palette/default-color changes are not included in that snapshot;
applications may need to repaint those settings after reattachment.

An executable TODO records the cold-attach case where an application pauses
halfway through a UTF-8 character before the new client connects. The control
stream can supply only the remaining byte, while `capture-pane -P` exposes no
prefix for that character. The current adapter can render a replacement
character in this case. After output settles, the user can activate the tab
shield or refresh indicator to read the authoritative tmux screen again. Normal
split UTF-8 within an existing control stream is covered and passes.
