const RESOURCE_TYPES = [
  "text/uri-list",
  "application/vnd.code.resources",
  "resourceurls",
  "codefiles",
  "codeeditors",
];

/** Read path-bearing drag formats without opening or uploading file contents. */
export function installTerminalDrop(
  host: HTMLElement,
  onDrop: (resources: unknown[], names: string[]) => void,
) {
  const listeners = new AbortController();
  const options = { signal: listeners.signal };
  const accepts = (event: DragEvent) =>
    event.dataTransfer &&
    [...event.dataTransfer.types].some(
      (type) => type === "Files" || RESOURCE_TYPES.includes(type.toLowerCase()),
    );
  const accept = (event: DragEvent) => {
    if (!accepts(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer!.dropEffect = "copy";
  };
  host.addEventListener("dragenter", accept, options);
  host.addEventListener("dragover", accept, options);
  host.addEventListener(
    "drop",
    (event) => {
      if (!accepts(event)) return;
      accept(event);
      const transfer = event.dataTransfer!;
      const resources: unknown[] = [];
      for (const type of transfer.types) {
        const format = type.toLowerCase();
        if (!RESOURCE_TYPES.includes(format)) continue;
        const data = transfer.getData(type);
        if (format === "text/uri-list") {
          resources.push(
            ...data
              .split(/\r?\n/)
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
      }
      const files = [...transfer.files];
      for (const file of files) {
        const filePath = (file as File & { path?: string }).path;
        if (filePath) resources.push(filePath);
      }
      onDrop(
        resources,
        files.map((file) => file.name),
      );
    },
    options,
  );
  return () => listeners.abort();
}
