# GaoGrid - VS Code Extension (gaomd.gaogrid)

A terminal multiplexer and workspace manager for VS Code and compatible editors,
inspired by [cmux](https://cmux.com/) and [herdr](https://herdr.dev/).

Organize your terminals into workspaces, split panes, and tabs in the Secondary
Sidebar.

## Installation

Available on the
[VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=gaomd.gaogrid)
and [Open VSX](https://open-vsx.org/extension/gaomd/gaogrid).

Search for and install **GaoGrid** from the Extensions view in VS Code or Cursor.

## Usage

Open it in the Secondary Sidebar to create workspaces, split panes, and open
terminal tabs. Start with the [terminal usage guide](docs/terminal-usage.md) or
explore [tab movement and drag and drop](docs/tab-movement.md).

In Cursor, if the extension appears in the Primary Side Bar, open the Command Palette and
run **View: Move View** → **GaoGrid** → **New Secondary Side Bar Entry**.

## Session Recovery

The extension saves terminal output, workspace layout, and session metadata in VS Code
storage. For long-running processes, you can opt into tmux-backed protected
sessions from a tab's context menu when tmux is available. The Transfer button
above terminal settings can move another orphaned or detached protected tmux
session into the current window by dragging it onto a pane. See the
[session recovery guide](docs/session-recovery.md) for recovery behavior,
protection, and compatibility details.

## Telemetry

**WE NEVER INCLUDE ANY OF THE FOLLOWING IN TELEMETRY:**

- terminal content or commands;
- file paths, working directories, workspace names, or tab titles;
- terminal session identifiers.

When VS Code telemetry is enabled, GaoGrid sends one usage event through the
official `@vscode/extension-telemetry` SDK each time the extension starts;
disable it from the editor's global telemetry settings.

All attached editor and environment metadata comes from official VS Code APIs
or the SDK's built-in common properties. The extension does not generate custom
tracking identifiers.

<details>
<summary>Event fields and analysis purposes</summary>

| Codename                        | Source                | Purpose                                                                    |
| ------------------------------- | --------------------- | -------------------------------------------------------------------------- |
| `common.extname`                | Official SDK built-in | Identify the extension.                                                    |
| `common.extversion`             | Official SDK built-in | Measure release adoption.                                                  |
| `common.isnewappinstall`        | Official SDK built-in | Identify aggregate events associated with a new app installation.          |
| `common.nodeArch`               | Official SDK built-in | Segment aggregate results by extension-host architecture.                  |
| `common.os`                     | Official SDK built-in | Segment aggregate results by operating system.                             |
| `common.platformversion`        | Official SDK built-in | Segment aggregate results by platform version.                             |
| `common.product`                | Official SDK built-in | Identify the editor product hosting the extension.                         |
| `common.remotename`             | Official SDK built-in | Identify remote extension-host environments.                               |
| `common.telemetryclientversion` | Official SDK built-in | Identify the official telemetry SDK version.                               |
| `common.uikind`                 | Official SDK built-in | Distinguish desktop and web UI environments.                               |
| `common.vscodecommithash`       | Official SDK built-in | Identify the exact VS Code build.                                          |
| `common.vscodemachineid`        | Official SDK built-in | Distinguish installations without counting one installation repeatedly.    |
| `common.vscodesessionid`        | Official SDK built-in | Associate the activation with its VS Code session.                         |
| `common.vscodeversion`          | Official SDK built-in | Identify editor-version compatibility.                                     |
| `appHost`                       | Official VS Code API  | Distinguish desktop, web, GitHub.dev, and Codespaces environments.         |
| `appName`                       | Official VS Code API  | Measure adoption across VS Code, Cursor, VSCodium, and compatible editors. |
| `uriScheme`                     | Official VS Code API  | Help identify compatible editor forks.                                     |

</details>

## Development

See the [development guide](docs/development.md) for setup, build, test, webview
architecture, and UI conventions.

## TODO

Next steps:

- [ ] **Configurable keyboard shortcuts:** Respect user-defined VS Code
      keybindings across extension commands and webview keyboard handling. Keep
      shortcuts scoped to the extension's focus context and update displayed
      shortcut labels.
- [ ] **[AI agent notifications](docs/terminal-notifications.md):** Plan notifications when agents finish or need
      input, with attention indicators for the relevant workspace and pane,
      similar to cmux and herdr.
- [ ] **OSC 52 clipboard writes:** Support terminal-mediated clipboard writes
      for remote applications and tmux copy-mode, with explicit permission and
      size limits. Codex's built-in selection and copy path already works
      independently.

## License

The original source code is licensed under the [MIT License](LICENSE).

Third-party components retain their own licenses; see the
[third-party notices](THIRD_PARTY_NOTICES.md).
