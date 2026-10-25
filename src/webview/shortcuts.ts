interface ShortcutEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

interface ShortcutAction {
  action: string;
  index?: number;
}

/** Shared webview shortcut resolution, including the shifted '+' key. */
export function resolveShortcut(
  event: ShortcutEvent,
): ShortcutAction | undefined {
  if (event.altKey || (event.metaKey && event.ctrlKey)) return;
  const key = event.key.toLowerCase();
  if (event.metaKey) {
    if (key === "+" || key === "=") return { action: "increaseFontSize" };
    if (key === "-") return { action: "decreaseFontSize" };
    if (key === "0" && !event.shiftKey) return { action: "resetFontSize" };
    if (event.shiftKey) return;
    const action = (
      { n: "newWorkspace", t: "newTab", w: "closeTab" } as Record<
        string,
        string
      >
    )[key];
    if (action) return { action };
    if (/^[1-9]$/.test(key)) return { action: "switchTab", index: Number(key) };
  } else if (event.ctrlKey && !event.shiftKey && /^[1-9]$/.test(key)) {
    return { action: "switchWorkspace", index: Number(key) };
  }
}
