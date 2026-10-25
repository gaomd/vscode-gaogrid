# GaoGrid - VS Code Extension (gaomd.gaogrid)

A terminal-first workspace manager in VS Code's Secondary Sidebar. Each workspace
owns a recursive split layout, and each pane has its own terminal tabs.

Inspired by [cmux](https://cmux.com/) and [herdr](https://herdr.dev/).

## Usage

Open GaoGrid in the Secondary Sidebar to create workspaces, split panes, and open
terminal tabs. Start with the [terminal usage guide](docs/terminal-usage.md) or
explore [tab movement and drag and drop](docs/tab-movement.md).

## Session Recovery

GaoGrid saves terminal output, workspace layout, and session metadata in VS Code
storage. For long-running processes, you can opt into tmux-backed protected
sessions from a tab's context menu when tmux is available. See the
[session recovery guide](docs/session-recovery.md) for recovery behavior,
protection, and compatibility details.

## Development

See the [development guide](docs/development.md) for setup, build, test, webview
architecture, and UI conventions.

## TODO

Next steps:

- [ ] **Pane switching shortcuts:** Add configurable shortcuts to move focus
      between panes and focus the destination pane's active terminal tab.
- [ ] **Split pane shortcuts:** Add configurable shortcuts to split the focused
      pane vertically or horizontally and focus the new pane's terminal.
- [ ] **Distribute panes evenly:** Add an action to balance split ratios so
      panes share the available space evenly within the recursive layout.
- [ ] **Configurable keyboard shortcuts:** Respect user-defined VS Code
      keybindings across extension commands and webview keyboard handling. Keep
      shortcuts scoped to GaoGrid focus and update displayed shortcut labels.
- [ ] **[AI agent notifications](docs/terminal-notifications.md):** Plan notifications when agents finish or need
      input, with attention indicators for the relevant workspace and pane,
      similar to cmux and herdr.

## License

GaoGrid's original source code is licensed under the [MIT License](LICENSE).

Third-party components retain their own licenses; see the
[third-party notices](THIRD_PARTY_NOTICES.md).
