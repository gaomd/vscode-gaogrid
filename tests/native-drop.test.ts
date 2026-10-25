import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MACOS_DRAG_PATHS_SCRIPT,
  nativeDroppedPaths,
} from "../src/native-drop";
import { quoteShellPaths } from "../src/shell-paths";

const exec = promisify(execFile);

test("Finder paths must match every dropped name and retain drop order", async () => {
  const paths = [
    "/tmp/one/report's 中文.txt",
    "/tmp/two/folder",
    "/tmp/three/report's 中文.txt",
  ];
  assert.deepEqual(
    await nativeDroppedPaths(
      ["folder", "report's 中文.txt", "report's 中文.txt"],
      "darwin",
      async () => paths,
    ),
    [paths[1], paths[0], paths[2]],
  );
  assert.deepEqual(
    await nativeDroppedPaths(["café.txt"], "darwin", async () => [
      "/tmp/cafe\u0301.txt",
    ]),
    ["/tmp/cafe\u0301.txt"],
  );
  for (const payload of [
    [],
    [paths[0]],
    [paths[0], "/tmp/unrelated"],
    [paths[0], "folder"],
    [paths[0], "/tmp/bad\0/folder"],
    [paths[0], null],
    { paths },
  ])
    assert.deepEqual(
      await nativeDroppedPaths(
        ["report's 中文.txt", "folder"],
        "darwin",
        async () => payload,
      ),
      [],
    );
});

test("native lookup failures and unsupported platforms allow the picker fallback", async () => {
  assert.deepEqual(
    await nativeDroppedPaths(["file"], "darwin", async () => {
      throw new Error("Pasteboard unavailable");
    }),
    [],
  );
  for (const [names, platform] of [
    [[], "darwin"],
    [["file"], "linux"],
    [["file"], "win32"],
  ] as [string[], NodeJS.Platform][])
    assert.deepEqual(
      await nativeDroppedPaths(names, platform, async () => {
        assert.fail("Must not query a pasteboard without a macOS file drop");
      }),
      [],
    );
});

test("AppKit reads multiple file URLs with spaces and Unicode without reading their contents", async (t) => {
  if (process.platform !== "darwin") return t.skip("macOS AppKit test");
  const root = await mkdtemp(join(tmpdir(), "gaogrid-drop-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = [join(root, "it's $file 中文.txt"), join(root, "a folder")];
  await writeFile(paths[0], "");
  await mkdir(paths[1]);
  // Exercise the actual Objective-C bridge on an isolated pasteboard. Leave
  // both the live drag pasteboard and general clipboard untouched.
  const readScript = MACOS_DRAG_PATHS_SCRIPT.replace(
    "$.NSPasteboard.pasteboardWithName('NSDragPboard')",
    "fixtureBoard",
  );
  const { stdout } = await exec(
    "/usr/bin/osascript",
    [
      "-l",
      "JavaScript",
      "-e",
      `
      ObjC.import('AppKit');
      var fixtureBoard = $.NSPasteboard.pasteboardWithUniqueName;
      try {
        fixtureBoard.clearContents;
        var fixtureURLs = $.NSMutableArray.alloc.init;
        fixtureURLs.addObject($.NSURL.fileURLWithPath(${JSON.stringify(paths[0])}));
        fixtureURLs.addObject($.NSURL.fileURLWithPathIsDirectory(${JSON.stringify(paths[1])}, true));
        fixtureBoard.writeObjects(fixtureURLs);
        var result = eval(${JSON.stringify(readScript)});
      } finally {
        fixtureBoard.releaseGlobally;
      }
      result;
      `,
    ],
    { timeout: 5000 },
  );
  assert.deepEqual(JSON.parse(stdout), paths);
});

for (const shell of ["/bin/zsh", "/bin/bash"]) {
  test(`${shell}: dropped paths remain literal shell arguments`, async (t) => {
    if (process.platform === "win32") return t.skip("POSIX shell test");
    const paths = [
      "/tmp/a folder",
      "/tmp/it's 中文.txt",
      "/tmp/$(echo unexpected);&`echo unexpected`!",
    ];
    const quoted = quoteShellPaths(paths, shell);
    assert.ok(!quoted.includes("\n"), "Drop must not submit the command");
    const { stdout } = await exec(shell, [
      "-f",
      "-c",
      `printf '%s\\0' ${quoted}`,
    ]);
    assert.deepEqual(stdout.split("\0").slice(0, -1), paths);
  });
}
