import { execFile } from "child_process";
import * as path from "path";
import { promisify } from "util";

const exec = promisify(execFile);

// Sandboxed webviews cannot access Electron's webUtils.getPathForFile. Read
// only the drag pasteboard, never the user's general clipboard or file contents.
export const MACOS_DRAG_PATHS_SCRIPT = `
ObjC.import('AppKit');
var board = $.NSPasteboard.pasteboardWithName('NSDragPboard');
var options = $.NSDictionary.dictionaryWithObjectForKey(
  $.NSNumber.numberWithBool(true), $.NSPasteboardURLReadingFileURLsOnlyKey);
var classes = $.NSArray.arrayWithObject($.NSURL);
var urls = board.readObjectsForClassesOptions(classes, options);
var paths = [];
if (urls) {
  for (var i = 0; i < urls.count; i++) {
    paths.push(ObjC.unwrap(urls.objectAtIndex(i).path));
  }
}
JSON.stringify(paths);
`;

async function readMacOSDragPaths(): Promise<unknown> {
  const { stdout } = await exec(
    "/usr/bin/osascript",
    ["-l", "JavaScript", "-e", MACOS_DRAG_PATHS_SCRIPT],
    { timeout: 2000, maxBuffer: 1024 * 1024 },
  );
  return JSON.parse(stdout);
}

/** Resolve names against the current native drag, rejecting unrelated payloads. */
export async function nativeDroppedPaths(
  names: string[],
  platform = process.platform,
  readPaths = readMacOSDragPaths,
): Promise<string[]> {
  if (platform !== "darwin" || !names.length) return [];
  try {
    const paths = await readPaths();
    if (
      !Array.isArray(paths) ||
      paths.length !== names.length ||
      !paths.every(
        (value): value is string =>
          typeof value === "string" &&
          path.posix.isAbsolute(value) &&
          !value.includes("\0"),
      )
    )
      return [];
    // Match the complete name multiset, including repeated names, before using
    // any native paths. Keep the webview's drop order when AppKit differs.
    const remaining = [...paths];
    const ordered: string[] = [];
    for (const name of names) {
      const index = remaining.findIndex(
        (value) =>
          path.posix.basename(value).normalize("NFC") === name.normalize("NFC"),
      );
      if (index < 0) return [];
      ordered.push(...remaining.splice(index, 1));
    }
    return ordered;
  } catch {
    return [];
  }
}
