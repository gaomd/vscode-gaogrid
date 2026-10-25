const RESOURCE_TYPES = [
  // Prefer VS Code's full Explorer selection before compatibility formats.
  "resourceurls",
  "codeeditors",
  "codefiles",
  "application/vnd.code.uri-list",
  "application/vnd.code.resources",
  "text/uri-list",
  "text/plain",
];

/** Read path-bearing drag formats without opening or uploading file contents. */
export function installTerminalDrop(
  host: HTMLElement,
  onDrop: (resources: unknown[], names: string[]) => void,
  onDrag?: (names: string[]) => void,
) {
  const listeners = new AbortController();
  // Handle drops at the terminal host before xterm or child elements can act
  // on them. This applies once the workbench delivers the drag into the webview.
  const options = { signal: listeners.signal, capture: true };
  let lastPathRead = 0;
  const accepts = (event: DragEvent) =>
    event.dataTransfer &&
    [...event.dataTransfer.types].some(
      (type) =>
        type.toLowerCase() === "files" ||
        RESOURCE_TYPES.includes(type.toLowerCase()),
    );
  const accept = (event: DragEvent) => {
    if (!accepts(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer!.dropEffect = "copy";
  };
  host.addEventListener("dragenter", accept, options);
  const prewarmPaths = (event: DragEvent) => {
    if (!accepts(event)) return;
    const now = Date.now();
    if (now - lastPathRead < 500) return;
    const names = getFileNames(event.dataTransfer!);
    if (!names.length) return;
    lastPathRead = now;
    onDrag?.(names);
  };
  host.addEventListener(
    "dragenter",
    (event) => prewarmPaths(event as DragEvent),
    options,
  );
  host.addEventListener(
    "dragover",
    (event) => {
      accept(event as DragEvent);
      prewarmPaths(event as DragEvent);
    },
    options,
  );
  host.addEventListener(
    "drop",
    (event) => {
      if (!accepts(event)) return;
      accept(event);
      const transfer = event.dataTransfer!;
      const resources: unknown[] = [];
      for (const format of RESOURCE_TYPES) {
        const type = [...transfer.types].find(
          (type) => type.toLowerCase() === format,
        );
        if (!type) continue;
        const data = transfer.getData(type);
        if (format.endsWith("uri-list") || format === "text/plain") {
          resources.push(
            ...data
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter((line) => line && !line.startsWith("#")),
          );
        } else {
          try {
            const entries: unknown = JSON.parse(data);
            if (Array.isArray(entries)) resources.push(...entries);
          } catch {
            // A drag can advertise a format without making its payload available.
          }
        }
        // These formats describe the same selection. Mixing them can duplicate
        // folders whose URI has a trailing slash but whose native path does not.
        if (resources.length) break;
      }
      const files = [...transfer.files];
      if (!resources.length)
        for (const file of files) {
          const filePath = (file as File & { path?: string }).path;
          if (filePath) resources.push(filePath);
        }
      // Some Chromium versions expose dropped directories only through items.
      onDrop(resources, getFileNames(transfer));
    },
    options,
  );
  return () => listeners.abort();
}

function getFileNames(transfer: DataTransfer): string[] {
  const names: string[] = [];
  for (const item of transfer.items) {
    if (item.kind !== "file") continue;
    const entry = item.webkitGetAsEntry?.();
    const name = entry?.name || item.getAsFile()?.name;
    if (name) names.push(name);
  }
  if (!names.length)
    names.push(...[...transfer.files].map((file) => file.name));
  return names;
}
