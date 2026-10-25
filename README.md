# GaoGrid - VS Code Extension

A terminal-first workspace manager in VS Code's Secondary Sidebar. Each workspace
owns a recursive split layout, and each pane has its own terminal tabs.

Inspired by [cmux](https://cmux.com/) and [herdr](https://herdr.dev/).

Extension ID: `gaomd.gaogrid`. Commands, views, and settings use the `gaogrid`
prefix.

## Usage

Open GaoGrid in the Secondary Sidebar. Use the workspace rail to switch between
workspaces, and each pane's controls to add terminal tabs or split the layout.
Double-click a tab or workspace to close it. You can create up to nine workspaces,
with up to nine terminal tabs per pane.

Keyboard shortcuts apply while GaoGrid has focus:

| Shortcut    | Action                                    |
| ----------- | ----------------------------------------- |
| `⌘N`        | New workspace                             |
| `⌘T`        | New tab in the focused pane               |
| `⌘W`        | Close the focused pane's active tab       |
| `Ctrl+1–9`  | Switch workspace                          |
| `⌘1–9`      | Switch tab in the focused pane            |
| `⌘⇧[`       | Previous tab in the focused pane          |
| `⌘⇧]`       | Next tab in the focused pane              |
| `⌘+` / `⌘-` | Adjust the focused terminal's font size   |
| `⌘0`        | Restore the configured terminal font size |

Tab cycling wraps at the first and last tabs.

Inside a terminal, `Shift+Enter` sends a distinct key sequence so Codex can insert
a newline without submitting the prompt.

Terminal fonts and colors follow VS Code's terminal settings and current theme.

## Current persistence

GaoGrid restores workspaces, split layouts, pane sizes, tabs, and working
directories. Terminal processes stay alive while the extension is running;
restarting VS Code recreates the shells in their saved directories.

## Development

Use VS Code, Node.js 20 or later, and npm.

```sh
npm ci
npm run compile
npm run typecheck
npm run format:check
```

Open this directory in VS Code and press `F5` using the **Run GaoGrid Extension**
launch configuration. This opens an Extension Development Host with GaoGrid
loaded.

Run `npm run watch` to rebuild changes automatically. Use **Developer: Reload
Webviews** in the development window to load updated webview code while keeping
the extension host and terminal processes running. Restart the debugging session
to load changes to extension host code.

## TODO

Next steps:

- [ ] **Session restore:** Plan terminal state restoration and
      reconnection to surviving sessions. Define behavior across extension reloads
      and VS Code restarts, keeping session ownership separate from workspace
      layout.
- [ ] **Move tabs between panes and workspaces:** Move terminal tabs to another
      pane, to a new workspace, or to a pane in another workspace, preserving
      their live terminal sessions.
- [ ] **Pane switching shortcuts:** Add configurable shortcuts to move focus
      between panes and focus the destination pane's active terminal tab.
- [ ] **Split pane shortcuts:** Add configurable shortcuts to split the focused
      pane vertically or horizontally and focus the new pane's terminal.
- [ ] **Distribute panes evenly:** Add an action to balance split ratios so
      panes share the available space evenly within the recursive layout.
- [ ] **Configurable keyboard shortcuts:** Respect user-defined VS Code
      keybindings across extension commands and webview keyboard handling. Keep
      shortcuts scoped to GaoGrid focus and update displayed shortcut labels.
- [ ] **AI agent notifications:** Plan notifications when agents finish or need
      input, with attention indicators for the relevant workspace and pane,
      similar to cmux and herdr.

See the [webview development notes](src/webview/README.md) for architecture and UI
conventions.

## License

GaoGrid's original source code is licensed under the [MIT License](LICENSE).
Third-party components retain their own licenses; see
[third-party notices](THIRD_PARTY_NOTICES.md), including Codicons assets under
CC BY 4.0.
