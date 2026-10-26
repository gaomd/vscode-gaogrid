interface ShortcutEvent {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
}

interface ShortcutAction {
  action: string;
  index?: number;
}

/** Shared webview shortcut resolution, including the shifted '+' key. */
export function resolveShortcut(
  event: ShortcutEvent,
): ShortcutAction | undefined {
  if (event.isComposing) return;
  if (event.altKey && event.shiftKey && !event.metaKey && !event.ctrlKey) {
    // On macOS, Option changes event.key to a glyph. Use the physical letter
    // key so both shortcut families work without inserting terminal text.
    const key = event.code?.startsWith("Key")
      ? event.code.slice(3).toLowerCase()
      : event.key.toLowerCase();
    const action = (
      {
        arrowup: "splitUp",
        arrowdown: "splitDown",
        arrowleft: "splitLeft",
        arrowright: "splitRight",
        t: "splitUp",
        d: "splitDown",
        l: "splitLeft",
        r: "splitRight",
      } as Record<string, string>
    )[key];
    return action ? { action } : undefined;
  }
  if (event.altKey || (event.metaKey && event.ctrlKey)) return;
  const key = event.key.toLowerCase();
  if (event.metaKey) {
    if (key === "+" || key === "=") return { action: "increaseFontSize" };
    if (key === "-") return { action: "decreaseFontSize" };
    if (key === "0" && !event.shiftKey) return { action: "resetFontSize" };
    if (event.shiftKey) {
      if (key === "[" || key === "{") return { action: "previousTab" };
      if (key === "]" || key === "}") return { action: "nextTab" };
      return;
    }
    const action = (
      {
        n: "newWorkspace",
        t: "newTab",
        w: "closeTab",
        d: "toggleWindow",
        x: "toggleSidebarSize",
      } as Record<string, string>
    )[key];
    if (action) return { action };
    if (/^[1-9]$/.test(key)) return { action: "switchTab", index: Number(key) };
  } else if (event.ctrlKey && !event.shiftKey && /^[1-9]$/.test(key)) {
    return { action: "switchWorkspace", index: Number(key) };
  }
}
