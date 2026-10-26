import type { Terminal } from "@xterm/xterm";

/** Let the browser finish IME punctuation conversion before sending text. */
export function installTerminalInput(
  terminal: Terminal,
  host: HTMLElement,
  useNativeText = typeof navigator !== "undefined" &&
    /Mac/.test(navigator.platform),
) {
  const listeners = new AbortController();
  const options = { capture: true, signal: listeners.signal };
  let pendingText = false;
  let ownedKey: string | undefined;
  let composing = false;
  let deadKey = false;
  const committedText = (event: InputEvent) => {
    if (
      event.target !== terminal.textarea ||
      !pendingText ||
      event.isComposing ||
      event.inputType !== "insertText" ||
      !event.data
    )
      return;
    if (event.type === "beforeinput") {
      if (!event.cancelable) return;
      event.preventDefault();
    } else {
      // IMEs may emit a non-cancelable beforeinput. Consume its following
      // input once, before xterm can process the same insertion again.
      event.stopImmediatePropagation();
      terminal.textarea!.value = "";
    }
    pendingText = false;
    terminal.input(event.data, true);
  };
  host.addEventListener("beforeinput", committedText, options);
  host.addEventListener(
    "input",
    (event) => committedText(event as InputEvent),
    options,
  );
  const reset = () => {
    pendingText = false;
    ownedKey = undefined;
  };
  host.addEventListener(
    "compositionstart",
    () => {
      reset();
      composing = true;
    },
    options,
  );
  host.addEventListener(
    "compositionend",
    () => {
      composing = false;
    },
    options,
  );
  host.addEventListener(
    "blur",
    () => {
      reset();
      composing = false;
      deadKey = false;
    },
    options,
  );
  terminal.attachCustomKeyEventHandler((event) => {
    if (event.type === "keyup") {
      if ((event.code || event.key) !== ownedKey) return true;
      reset();
      return false;
    }
    if (event.type === "keypress" && (event.code || event.key) === ownedKey)
      return false;
    if (event.type !== "keydown") return true;
    reset();
    if (composing || event.isComposing || event.keyCode === 229) return true;
    if (event.key === "Dead") {
      deadKey = true;
      return true;
    }
    // Leave dead-key completion to xterm, including its internal key state.
    if (deadKey && event.key.length === 1) {
      deadKey = false;
      return true;
    }
    if (
      event.key === "Enter" &&
      event.shiftKey &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      event.preventDefault();
      terminal.input("\x1b[13;2u");
      return false;
    }
    if (
      useNativeText &&
      "onbeforeinput" in host &&
      /^[\p{P}\p{S}]$/u.test(event.key) &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      // Returning false only skips xterm's eager keydown/keypress handling.
      // Do not cancel the browser event: the IME must produce the final text.
      pendingText = true;
      ownedKey = event.code || event.key;
      return false;
    }
    return true;
  });
  return () => {
    listeners.abort();
    terminal.attachCustomKeyEventHandler(() => true);
  };
}
