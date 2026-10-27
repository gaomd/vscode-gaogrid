# GaoGrid - VS Code Extension (gaomd.gaogrid)

A terminal multiplexer and workspace manager for VS Code and compatible editors,
inspired by [cmux](https://cmux.com/) and [herdr](https://herdr.dev/).

Organize your terminals into workspaces, split panes, and tabs in the Secondary
Sidebar.

## Installation

Available on the
[VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=gaomd.gaogrid)
and [Open VSX](https://open-vsx.org/extension/gaomd/gaogrid).

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
