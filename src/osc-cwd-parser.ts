/** Reads passive OSC 7 reports without consuming terminal output. */
export class OscCwdParser {
  private mode: "text" | "escape" | "osc" | "oscEscape" = "text";
  private payload = "";
  private overflow = false;

  constructor(private readonly emit: (uri: string) => void) {}

  write(data: string) {
    for (const char of data) {
      if (this.mode === "text") {
        if (char === "\x1b") this.mode = "escape";
        else if (char === "\x9d") this.begin();
      } else if (this.mode === "escape") {
        if (char === "]") this.begin();
        else this.mode = char === "\x1b" ? "escape" : "text";
      } else if (
        char === "\x07" ||
        char === "\x9c" ||
        (this.mode === "oscEscape" && char === "\\")
      ) {
        if (!this.overflow && this.payload.startsWith("7;"))
          this.emit(this.payload.slice(2));
        this.mode = "text";
      } else if (char === "\x1b") {
        this.mode = "oscEscape";
      } else {
        if (this.mode === "oscEscape") {
          // An interrupted OSC must not turn later plain output into metadata.
          this.mode = "text";
          continue;
        }
        if (this.payload.length < 16_384) this.payload += char;
        else this.overflow = true;
      }
    }
  }

  private begin() {
    this.mode = "osc";
    this.payload = "";
    this.overflow = false;
  }
}
