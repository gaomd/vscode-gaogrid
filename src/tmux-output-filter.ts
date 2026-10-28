import { parse } from "@ansi-tools/parser";

type Control = ReturnType<typeof parse>[number];

/**
 * Route terminal queries to their correct owner. tmux answers direct queries;
 * DCS passthrough remains opaque and reaches xterm.
 */
export class TmuxOutputFilter {
  private pending = "";
  private highSurrogate = "";
  private inDcs = false;
  private previousWasEscape = false;

  write(data: string): string {
    let input = this.highSurrogate + data;
    this.highSurrogate = "";
    if (input.length && isHighSurrogate(input.charCodeAt(input.length - 1))) {
      this.highSurrogate = input.slice(-1);
      input = input.slice(0, -1);
    }
    input = this.pending + input;
    this.pending = "";
    if (!input) return "";

    const parsed = parse(input);
    const output: string[] = [];
    let incompleteIndex = parsed.length;
    const knownOsc = parsed.findIndex(
      (token) => token.type === "OSC" && incomplete(token),
    );
    if (knownOsc >= 0) incompleteIndex = knownOsc;
    else if (parsed.length && incomplete(parsed[parsed.length - 1]))
      incompleteIndex = parsed.length - 1;
    if (incompleteIndex < parsed.length)
      this.pending = input.slice(parsed[incompleteIndex].pos);
    for (let index = 0; index < incompleteIndex; index++) {
      const token = parsed[index];
      if (token.type === "DCS") this.inDcs = true;
      if (!this.inDcs && tmuxAnswers(token)) continue;
      output.push(token.raw);
      if (
        this.inDcs &&
        token.type === "ESC" &&
        (token.raw === "\x1b\\" || token.raw === "\u009c") &&
        !this.previousWasEscape
      )
        this.inDcs = false;
      this.previousWasEscape = token.type === "ESC" && token.raw === "\x1b";
    }
    if (
      incompleteIndex < parsed.length &&
      parsed[incompleteIndex].type === "DCS"
    )
      this.inDcs = true;
    return output.join("");
  }

  flush(): string {
    const output = this.pending + this.highSurrogate;
    this.pending = "";
    this.highSurrogate = "";
    return output;
  }
}

function tmuxAnswers(token: Control): boolean {
  const introducer = token.raw.startsWith("\x1b[") ? "\x1b[" : "\u009b";
  if (token.type === "CSI") {
    if (
      token.command === "n" &&
      (token.params[0] === "5" || token.params[0] === "6")
    )
      return token.params.length === 1;
    if (token.command === "c") {
      const body = token.raw.slice(introducer.length, -1);
      return body === "" || body === "0" || body === ">" || body === ">0";
    }
  }
  if (token.type === "OSC")
    return (
      (token.command === "10" || token.command === "11") &&
      token.params.length === 1 &&
      token.params[0] === "?"
    );
  if (token.type === "PRIVATE" && token.command === ">c")
    return token.params.length === 0 || token.params[0] === "0";
  return false;
}

function incomplete(token: Control): boolean {
  if (token.type === "CSI") return token.command === "";
  if (token.type === "PRIVATE") return token.command === ">";
  if (token.type === "OSC") {
    const complete = token.raw.endsWith("\x07") || token.raw.endsWith("\x1b\\");
    return (
      !complete &&
      (token.command === "" ||
        token.command === "1" ||
        token.command === "10" ||
        token.command === "11" ||
        token.params.join(";").startsWith("?"))
    );
  }
  if (token.type === "DCS") return token.raw.includes("tmux;");
  if (token.type === "ESC") return token.raw === "\x1b";
  return false;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
