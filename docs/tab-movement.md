# Tab Movement And Drag And Drop

## Move Tabs And Create Splits

- Drag a terminal tab onto another pane's tab strip to move it there.
- Drag a terminal tab over a pane's terminal surface to preview a split on the
  nearest side, then drop to create the split.
- Drop a terminal tab on a workspace label to move it into that workspace.
- Drop a terminal tab between workspace labels to create a workspace at that
  position. Drop it on the workspace rail's **+** button or empty area to append
  a workspace.
- Drag workspace tabs onto another workspace tab or between workspace tabs to
  reorder them.

Dragging keeps the source tab in place until drop. A marker shows the target
position. Moving the last tab out of a workspace's only pane removes that
workspace. When splitting a pane's only tab into that same pane, GaoGrid opens a
fresh terminal in the original pane and moves the dragged tab into the new pane.

## Insert File And Folder Paths

### Terminal Drop Target

When a compatible file or folder drag reaches the GaoGrid webview, the terminal
shows a **Drop to insert paths** target. This overlay is visual feedback only:
it does not recover a drag that VS Code blocks before it reaches the webview,
and it does not provide an absolute path when the webview receives only a file
name or content.

### Explorer Context Menu

Select one or more files or folders in Explorer and use **GaoGrid: Insert File
Paths into Terminal**. This uses VS Code's selected resource URIs directly,
does not depend on drag and drop, and inserts shell-quoted paths into the most
recently focused GaoGrid terminal.

The command is also available in the Command Palette, where it opens a native
picker.

### Terminal Context Menu

Use **Insert Paths…** at the end of a terminal's context menu to open the native
picker for that pane's active terminal. The first picker opens in the terminal
cwd. Each terminal then remembers the containing directory of its last picker
selection for the current Extension Host session. The location falls back to
the terminal cwd when unavailable and is not persisted across reloads.

### External Drag Limitations

Finder can drop into a VS Code editor because the workbench receives the native
OS file drop directly. GaoGrid runs inside a sandboxed extension webview, where
absolute file paths may be stripped. If the received drag cannot be resolved to
a path, GaoGrid opens the picker described above.

Explorer-to-webview drags are less reliable in VS Code 1.140 and newer because
of an upstream Electron regression. Shift and dragging through an editor may
occasionally work, but they are timing-dependent. Use the Explorer or terminal
context-menu path actions instead. The regression is tracked in
[VS Code #339036](https://github.com/microsoft/vscode/issues/339036) and was
introduced by the cross-site iframe drag change in
[Electron #53669](https://github.com/electron/electron/pull/53669).
