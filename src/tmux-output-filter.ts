const ESC = "\x1b";
const CSI_QUERIES = new Set([
  `${ESC}[5n`,
  `${ESC}[6n`,
  `${ESC}[c`,
  `${ESC}[0c`,
  `${ESC}[>c`,
  `${ESC}[>0c`,
]);
const CSI_PREFIXES = [
  `${ESC}[5n`,
  `${ESC}[6n`,
  `${ESC}[c`,
  `${ESC}[0c`,
  `${ESC}[>c`,
  `${ESC}[>0c`,
];
const OSC_QUERIES = ["10;?", "11;?"];

type State =
  | "ground"
  | "escape"
  | "csi"
  | "csi-pass"
  | "osc"
  | "osc-candidate"
  | "osc-st"
  | "string";
type StringKind = "osc" | "dcs" | "apc" | "pm" | "sos";

/**
 * Suppress only direct terminal queries already answered by the tmux server.
 * String controls such as DCS passthrough remain opaque, so queries wrapped
 * inside them still reach xterm and can produce their normal replies.
 */
export class TmuxOutputFilter {
  private state: State = "ground";
  private pending = "";
  private stringKind: StringKind = "osc";
  private stringEscape = false;
  private dcsPrefixCandidate = false;
  private dcsPrefixIndex = 0;
  private dcsTmux = false;
  private highSurrogate = "";

  /** Feed a stream chunk and return the bytes/text safe to forward to xterm. */
  write(data: string): string {
    let input = this.highSurrogate + data;
    this.highSurrogate = "";
    if (input.length && isHighSurrogate(input.charCodeAt(input.length - 1))) {
      this.highSurrogate = input.slice(-1);
      input = input.slice(0, -1);
    }
    if (!input) return "";

    const output: string[] = [];
    let index = 0;
    while (index < input.length) {
      if (this.state === "ground") {
        const escape = input.indexOf(ESC, index);
        const end = escape === -1 ? input.length : escape;
        if (end > index) output.push(input.slice(index, end));
        index = end;
        if (index < input.length) {
          this.pending = ESC;
          this.state = "escape";
          index++;
        }
        continue;
      }

      if (this.state === "string" || this.state === "osc") {
        if (this.dcsPrefixCandidate) {
          this.consume(input[index++], output);
          continue;
        }
        if (this.stringEscape) {
          this.consume(input[index++], output);
          continue;
        }
        const escape = input.indexOf(ESC, index);
        const bell =
          this.stringKind === "osc" ? input.indexOf("\x07", index) : -1;
        const terminator =
          escape === -1 ? bell : bell === -1 ? escape : Math.min(escape, bell);
        const end = terminator === -1 ? input.length : terminator + 1;
        output.push(input.slice(index, end));
        if (terminator !== -1) {
          const character = input[terminator];
          if (character === "\x07") this.state = "ground";
          else this.stringEscape = true;
        }
        index = end;
        continue;
      }

      if (this.state === "csi-pass") {
        const start = index;
        while (
          index < input.length &&
          !isCsiFinal(input[index]) &&
          input[index] !== ESC
        )
          index++;
        if (index === input.length) {
          output.push(input.slice(start));
          continue;
        }
        const terminator = input[index++];
        if (isCsiFinal(terminator)) this.state = "ground";
        else {
          this.pending = ESC;
          this.state = "escape";
        }
        output.push(
          terminator === ESC
            ? input.slice(start, index - 1)
            : input.slice(start, index),
        );
        continue;
      }

      this.consume(input[index++], output);
    }
    return output.join("");
  }

  /** Emit any incomplete candidate literally when the stream is ending. */
  flush(): string {
    let output = "";
    const highSurrogate = this.highSurrogate;
    this.highSurrogate = "";
    if (
      this.state === "escape" ||
      this.state === "csi" ||
      this.state === "osc-candidate" ||
      this.state === "osc-st"
    )
      output += this.pending;
    output += highSurrogate;
    this.reset();
    return output;
  }

  private consume(character: string, output: string[]) {
    switch (this.state) {
      case "ground":
        if (character === ESC) {
          this.pending = ESC;
          this.state = "escape";
        } else output.push(character);
        return;
      case "escape":
        this.consumeEscape(character, output);
        return;
      case "csi":
        this.consumeCsi(character, output);
        return;
      case "csi-pass":
        output.push(character);
        if (isCsiFinal(character)) this.state = "ground";
        else if (character === ESC) this.state = "escape";
        return;
      case "osc-candidate":
        this.consumeOscCandidate(character, output);
        return;
      case "osc-st":
        this.consumeOscSt(character, output);
        return;
      case "osc":
      case "string":
        this.consumeString(character, output);
        return;
    }
  }

  private consumeEscape(character: string, output: string[]) {
    if (character === "[") {
      this.pending += character;
      this.state = "csi";
      return;
    }
    if (character === "]") {
      this.pending += character;
      this.stringKind = "osc";
      this.state = "osc-candidate";
      return;
    }
    const stringKind = stringIntroducer(character);
    if (stringKind) {
      output.push(this.pending, character);
      this.pending = "";
      this.stringKind = stringKind;
      this.stringEscape = false;
      this.dcsPrefixCandidate = stringKind === "dcs";
      this.dcsPrefixIndex = 0;
      this.dcsTmux = false;
      this.state = stringKind === "osc" ? "osc" : "string";
      return;
    }
    if (character === ESC) {
      output.push(this.pending);
      this.pending = ESC;
      return;
    }
    output.push(this.pending, character);
    this.reset();
  }

  private consumeCsi(character: string, output: string[]) {
    this.pending += character;
    if (CSI_QUERIES.has(this.pending)) {
      this.pending = "";
      this.state = "ground";
      return;
    }
    if (CSI_PREFIXES.some((query) => query.startsWith(this.pending))) return;

    const ended = isCsiFinal(character);
    output.push(character === ESC ? this.pending.slice(0, -1) : this.pending);
    this.pending = "";
    if (ended) this.state = "ground";
    else if (character === ESC) {
      this.pending = ESC;
      this.state = "escape";
    } else this.state = "csi-pass";
  }

  private consumeOscCandidate(character: string, output: string[]) {
    const body = this.pending.slice(2);
    const isQuery = OSC_QUERIES.includes(body);
    if (isQuery && character === "\x07") {
      this.pending = "";
      this.state = "ground";
      return;
    }
    if (isQuery && character === ESC) {
      this.pending += character;
      this.state = "osc-st";
      return;
    }

    this.pending += character;
    const nextBody = this.pending.slice(2);
    if (OSC_QUERIES.some((query) => query.startsWith(nextBody))) return;

    // This OSC is not one of the exact color queries. Release its short prefix
    // now and stream the remaining payload directly, even if it is very large.
    output.push(this.pending);
    const terminates = character === "\x07";
    const escaped = character === ESC;
    this.pending = "";
    this.stringKind = "osc";
    this.stringEscape = escaped;
    this.state = terminates ? "ground" : "osc";
  }

  private consumeOscSt(character: string, output: string[]) {
    if (character === "\\") {
      this.pending = "";
      this.state = "ground";
      return;
    }
    output.push(this.pending, character);
    this.pending = "";
    this.stringKind = "osc";
    this.stringEscape = character === ESC;
    this.state = character === "\x07" ? "ground" : "osc";
  }

  private consumeString(character: string, output: string[]) {
    output.push(character);
    if (this.dcsPrefixCandidate) {
      const prefix = "tmux;";
      if (character !== prefix[this.dcsPrefixIndex]) {
        this.dcsPrefixCandidate = false;
      } else if (++this.dcsPrefixIndex === prefix.length) {
        this.dcsPrefixCandidate = false;
        this.dcsTmux = true;
      }
    }
    if (this.stringEscape) {
      if (character === "\\") {
        this.state = "ground";
        this.stringEscape = false;
      } else if (this.dcsTmux && character === ESC) {
        // In DCS tmux passthrough, doubled ESC is payload. In particular,
        // ESC ESC \\ encodes an inner ST and does not end the outer DCS.
        this.stringEscape = false;
      } else {
        this.stringEscape = character === ESC;
      }
      return;
    }
    if (this.stringKind === "osc" && character === "\x07") {
      this.state = "ground";
      return;
    }
    if (character === ESC) this.stringEscape = true;
  }

  private reset() {
    this.state = "ground";
    this.pending = "";
    this.stringEscape = false;
    this.dcsPrefixCandidate = false;
    this.dcsPrefixIndex = 0;
    this.dcsTmux = false;
  }
}

function isCsiFinal(character: string): boolean {
  const code = character.charCodeAt(0);
  return code >= 0x40 && code <= 0x7e;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function stringIntroducer(character: string): StringKind | undefined {
  if (character === "P") return "dcs";
  if (character === "_") return "apc";
  if (character === "^") return "pm";
  if (character === "X") return "sos";
  return undefined;
}
