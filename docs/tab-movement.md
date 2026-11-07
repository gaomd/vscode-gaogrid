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

## Drop Files And Folders Into A Terminal

Drop files or folders from Finder or Explorer onto a terminal to insert
shell-quoted absolute paths without submitting the command. Explorer drops read
VS Code's resource URI payload synchronously. A webview can only handle Explorer
drops that the VS Code workbench forwards; if the workbench suppresses a drag,
use **GaoGrid: Insert File Paths into Terminal** from Explorer's context menu
or the Command Palette. VS Code 1.140 and newer currently suppress many Explorer
drags inside extension webviews, including when Shift is held. This is tracked
in [VS Code #339036](https://github.com/microsoft/vscode/issues/339036) and was
introduced by the cross-site iframe drag change in
[Electron #53669](https://github.com/electron/electron/pull/53669). If the
runtime cannot resolve a Finder drop, the file picker opens in the focused
terminal's current directory.
