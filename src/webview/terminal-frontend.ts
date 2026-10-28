import { Terminal } from "@xterm/xterm";
import { TerminalFitAddon } from "./terminal-fit";
import { ImageAddon } from "@xterm/addon-image";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import type { TerminalTab } from "../model";
import type { TerminalOutputPacket } from "../terminal-protocol";
import { readTerminalOptions } from "./terminal-theme";
import { installTerminalDrop } from "./terminal-drop";
import { installTerminalInput } from "./terminal-input";
import { TERMINAL_HISTORY_LINES } from "../terminal-constants";
import type { MousePolicy, TerminalPreferences } from "../terminal-protocol";

interface TerminalSurface {
  terminal: Terminal;
  fit: TerminalFitAddon;
  host: HTMLElement;
  sessionId: string;
  transport?: "control" | "attach";
  opened: boolean;
  fontSizeOverride?: number;
  webgl?: WebglAddon;
  webglFailed?: boolean;
  replaying?: boolean;
  streamId: string;
  awaitingReplay: boolean;
  received: number;
  parsed: number;
  ackQueued?: string;
  disposeDrop(): void;
  disposeInput(): void;
}

/** Owns terminal rendering and focus; it has no layout or persistence logic. */
export class TerminalFrontend {
  private readonly surfaces = new Map<string, TerminalSurface>();
  private readonly sessionTabs = new Map<string, string>();
  private readonly pendingSnapshots = new Map<string, string>();
  private readonly pendingDimensions = new Map<
    string,
    { cols: number; rows: number }
  >();
  private readonly closedSessions = new Set<string>();
  private frame?: number;
  private focusRequest = 0;
  private useWebgl = true;
  private mousePolicy: MousePolicy = "application";
  private readonly resizeObserver = new ResizeObserver(() =>
    this.scheduleFit(),
  );

  constructor(private readonly send: (message: unknown) => void) {
    const refreshFonts = () => {
      for (const surface of this.surfaces.values())
        if (surface.opened) surface.terminal.clearTextureAtlas();
      this.scheduleFit();
    };
    void document.fonts.ready.then(refreshFonts);
    document.fonts.addEventListener("loadingdone", refreshFonts);
    // VS Code can inject theme variables after the configuration message arrives.
    const themeObserver = new MutationObserver(() => this.applySettings());
    themeObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ["class", "style", "data-vscode-theme-id"],
    });
  }

  mount(tab: TerminalTab, host: HTMLElement) {
    const existing = this.surfaces.get(tab.id);
    if (existing) {
      existing.transport = tab.transport;
      if (existing.host !== host) {
        this.resizeObserver.unobserve(existing.host);
        existing.disposeDrop();
        existing.disposeInput();
        existing.disposeInput = installTerminalInput(existing.terminal, host);
        existing.disposeDrop = this.installDrop(
          host,
          existing.terminal,
          tab.sessionId,
        );
      }
      if (existing.host !== host && existing.terminal.element)
        host.append(existing.terminal.element);
      existing.host = host;
      this.resizeObserver.observe(host);
      this.scheduleFit();
      return;
    }

    const terminal = new Terminal({
      ...readTerminalOptions(),
      ...this.pendingDimensions.get(tab.sessionId),
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: TERMINAL_HISTORY_LINES,
      // Opaque glyph rasterization keeps text edges blended against the actual
      // terminal background. Inline images have their own transparent layer.
      allowTransparency: false,
      rightClickSelectsWord: true,
      macOptionClickForcesSelection: true,
    });
    terminal.loadAddon(new Unicode11Addon());
    terminal.unicode.activeVersion = "11";
    const fit = new TerminalFitAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(
      new WebLinksAddon((_event, uri) => this.send({ type: "openUrl", uri })),
    );
    try {
      terminal.loadAddon(new ImageAddon());
    } catch {
      // Keep the terminal usable when this runtime cannot load the image addon.
    }
    terminal.onData((data) =>
      this.send({ type: "input", sessionId: tab.sessionId, data }),
    );
    terminal.onBinary((data) =>
      this.send({
        type: "input",
        sessionId: tab.sessionId,
        data,
        binary: true,
      }),
    );
    terminal.onResize(({ cols, rows }) =>
      this.send({ type: "resize", sessionId: tab.sessionId, cols, rows }),
    );
    const surface: TerminalSurface = {
      terminal,
      fit,
      host,
      sessionId: tab.sessionId,
      transport: tab.transport,
      opened: false,
      streamId: "",
      awaitingReplay: true,
      received: 0,
      parsed: 0,
      disposeDrop: this.installDrop(host, terminal, tab.sessionId),
      disposeInput: installTerminalInput(terminal, host),
    };
    this.surfaces.set(tab.id, surface);
    terminal.attachCustomWheelEventHandler((event) =>
      this.handleWheel(surface, event),
    );
    this.sessionTabs.set(tab.sessionId, tab.id);
    this.resizeObserver.observe(host);
    this.pendingDimensions.delete(tab.sessionId);
    const output = this.pendingSnapshots.get(tab.sessionId);
    if (output !== undefined) {
      const surface = this.surfaces.get(tab.id)!;
      surface.replaying = true;
      terminal.write(output, () => {
        surface.replaying = false;
        this.scheduleFit();
      });
      this.pendingSnapshots.delete(tab.sessionId);
      this.pendingDimensions.delete(tab.sessionId);
    }
    this.subscribe(this.surfaces.get(tab.id)!);
    this.scheduleFit();
  }

  updateTab(tab: TerminalTab) {
    const surface = this.surfaces.get(tab.id);
    if (surface) surface.transport = tab.transport;
  }

  write(sessionId: string, data: string) {
    if (this.closedSessions.has(sessionId)) return;
    const tabId = this.sessionTabs.get(sessionId);
    const surface = tabId ? this.surfaces.get(tabId) : undefined;
    if (surface) surface.terminal.write(data);
    else this.pendingSnapshots.delete(sessionId);
  }

  receiveOutput(packet: TerminalOutputPacket) {
    const tabId = this.sessionTabs.get(packet.sessionId);
    const surface = tabId ? this.surfaces.get(tabId) : undefined;
    if (!surface || surface.streamId !== packet.streamId) return;
    if (packet.sequence <= surface.received) return;
    if (
      (packet.type === "data" && surface.awaitingReplay) ||
      packet.sequence !== surface.received + Math.max(1, packet.data.length)
    ) {
      this.subscribe(surface);
      return;
    }
    surface.received = packet.sequence;
    const streamId = surface.streamId;
    const parsed = () => {
      if (
        surface.streamId !== streamId ||
        this.surfaces.get(tabId!) !== surface
      )
        return;
      surface.parsed = packet.sequence;
      if (surface.ackQueued === streamId) return;
      surface.ackQueued = streamId;
      queueMicrotask(() => {
        if (surface.ackQueued === streamId) surface.ackQueued = undefined;
        if (
          surface.streamId === streamId &&
          this.surfaces.get(tabId!) === surface
        )
          this.send({
            type: "outputParsed",
            sessionId: packet.sessionId,
            streamId,
            sequence: surface.parsed,
          });
      });
    };
    if (packet.type === "replay") {
      surface.awaitingReplay = false;
      this.replay(
        packet.sessionId,
        packet.data,
        packet.cols,
        packet.rows,
        parsed,
      );
    } else surface.terminal.write(packet.data, parsed);
  }

  outputError(sessionId: string, streamId: string, message: string) {
    const tabId = this.sessionTabs.get(sessionId);
    const surface = tabId ? this.surfaces.get(tabId) : undefined;
    if (!surface || surface.streamId !== streamId) return;
    surface.replaying = false;
    surface.awaitingReplay = false;
    surface.terminal.write(
      `\r\n[GaoGrid] Could not restore terminal output: ${message}\r\nReload GaoGrid to retry.\r\n`,
    );
    this.scheduleFit();
  }

  private subscribe(surface: TerminalSurface) {
    surface.streamId = crypto.randomUUID();
    surface.awaitingReplay = true;
    surface.replaying = true;
    surface.received = 0;
    surface.parsed = 0;
    surface.ackQueued = undefined;
    this.send({
      type: "subscribeOutput",
      sessionId: surface.sessionId,
      streamId: surface.streamId,
    });
  }

  replay(
    sessionId: string,
    data: string,
    cols?: number,
    rows?: number,
    parsed?: () => void,
  ) {
    if (this.closedSessions.has(sessionId)) return;
    const tabId = this.sessionTabs.get(sessionId);
    const surface = tabId ? this.surfaces.get(tabId) : undefined;
    if (surface) {
      const streamId = surface.streamId;
      surface.replaying = true;
      surface.terminal.write("", () => {
        surface.terminal.reset();
        if (cols && rows) surface.terminal.resize(cols, rows);
      });
      surface.terminal.write(data, () => {
        if (surface.streamId === streamId) {
          surface.replaying = false;
          this.scheduleFit();
        }
        parsed?.();
      });
    } else {
      if (cols && rows) this.pendingDimensions.set(sessionId, { cols, rows });
      this.pendingSnapshots.set(sessionId, data);
    }
  }

  reset(sessionId: string) {
    this.pendingSnapshots.delete(sessionId);
    this.pendingDimensions.delete(sessionId);
    const tabId = this.sessionTabs.get(sessionId);
    const surface = tabId ? this.surfaces.get(tabId) : undefined;
    if (surface) this.subscribe(surface);
  }

  paste(sessionId: string, text: string) {
    const tabId = this.sessionTabs.get(sessionId);
    const surface = tabId ? this.surfaces.get(tabId) : undefined;
    if (!surface) return;
    surface.terminal.paste(text);
    if (this.isVisible(surface)) surface.terminal.focus();
  }

  focus(tabId: string) {
    const request = ++this.focusRequest;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (request !== this.focusRequest) return;
        const surface = this.surfaces.get(tabId);
        if (!surface || !this.isVisible(surface)) return;
        this.fitVisible();
        surface.terminal.focus();
        surface.terminal.textarea?.focus({ preventScroll: true });
      }),
    );
  }

  adjustFontSize(tabId: string, change: number) {
    const surface = this.surfaces.get(tabId);
    if (!surface) return;
    const current = surface.terminal.options.fontSize || 12;
    surface.fontSizeOverride = Math.max(6, Math.min(72, current + change));
    surface.terminal.options.fontSize = surface.fontSizeOverride;
    this.scheduleFit();
  }

  resetFontSize(tabId: string) {
    const surface = this.surfaces.get(tabId);
    if (!surface) return;
    surface.fontSizeOverride = undefined;
    surface.terminal.options.fontSize = readTerminalOptions().fontSize;
    this.scheduleFit();
  }

  disposeTab(tab: TerminalTab) {
    this.closedSessions.add(tab.sessionId);
    const surface = this.surfaces.get(tab.id);
    if (surface) {
      this.send({
        type: "unsubscribeOutput",
        sessionId: surface.sessionId,
        streamId: surface.streamId,
      });
      this.resizeObserver.unobserve(surface.host);
      surface.disposeDrop();
      surface.disposeInput();
      surface.terminal.dispose();
    }
    this.surfaces.delete(tab.id);
    this.sessionTabs.delete(tab.sessionId);
    this.pendingSnapshots.delete(tab.sessionId);
    this.pendingDimensions.delete(tab.sessionId);
  }

  scheduleFit() {
    if (this.frame !== undefined) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = undefined;
      this.fitVisible();
    });
  }

  private isVisible(surface: TerminalSurface) {
    return (
      surface.host.isConnected &&
      !surface.host.hidden &&
      surface.host.clientWidth > 0 &&
      surface.host.clientHeight > 0
    );
  }

  private installDrop(
    host: HTMLElement,
    terminal: Terminal,
    sessionId: string,
  ) {
    return installTerminalDrop(
      host,
      (resources, names) => {
        terminal.focus();
        this.send({ type: "dropPaths", sessionId, resources, names });
      },
      (names) => {
        if (names.length)
          this.send({ type: "nativeDropCandidate", sessionId, names });
      },
    );
  }

  private fitVisible() {
    for (const surface of this.surfaces.values()) {
      if (!this.isVisible(surface) || surface.replaying) continue;
      if (!surface.opened) {
        surface.terminal.open(surface.host);
        surface.opened = true;
        this.updateRenderer(surface);
      }
      surface.fit.fit();
      for (const hidden of this.surfaces.values()) {
        if (
          hidden !== surface &&
          hidden.host.hidden &&
          hidden.host.parentElement === surface.host.parentElement
        )
          hidden.terminal.resize(surface.terminal.cols, surface.terminal.rows);
      }
      surface.terminal.refresh(0, surface.terminal.rows - 1);
    }
  }

  private updateRenderer(surface: TerminalSurface) {
    if (!surface.opened) return;
    if (!this.useWebgl) {
      surface.webgl?.dispose();
      surface.webgl = undefined;
      return;
    }
    if (surface.webgl || surface.webglFailed) return;
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => {
      surface.webgl = undefined;
      surface.webglFailed = true;
      webgl.dispose();
      this.scheduleFit();
    });
    try {
      surface.terminal.loadAddon(webgl);
      surface.webgl = webgl;
    } catch {
      webgl.dispose();
      surface.webglFailed = true;
      // Keep xterm's DOM renderer when the GPU is unavailable.
    }
  }

  applySettings(settings?: Record<string, unknown>) {
    if (settings) {
      const useWebgl = settings.gpuAcceleration !== "off";
      if (useWebgl !== this.useWebgl) {
        this.useWebgl = useWebgl;
        for (const surface of this.surfaces.values()) {
          surface.webglFailed = false;
          this.updateRenderer(surface);
        }
      }
      const values: Record<string, unknown> = {
        "--terminal-font-family": settings.fontFamily || "monospace",
        "--terminal-font-size": settings.fontSize || 12,
        "--terminal-font-weight": settings.fontWeight || "normal",
        "--terminal-font-weight-bold": settings.fontWeightBold || "bold",
        "--terminal-line-height": settings.lineHeight || 1,
        "--terminal-letter-spacing": settings.letterSpacing || 0,
        "--terminal-minimum-contrast": settings.minimumContrastRatio || 1,
      };
      for (const [key, value] of Object.entries(values))
        document.documentElement.style.setProperty(key, String(value));
    }
    const options = readTerminalOptions();
    for (const { terminal, fontSizeOverride } of this.surfaces.values()) {
      terminal.options.theme = options.theme;
      terminal.options.fontFamily = options.fontFamily;
      terminal.options.fontSize = fontSizeOverride ?? options.fontSize;
      terminal.options.fontWeight = options.fontWeight;
      terminal.options.fontWeightBold = options.fontWeightBold;
      terminal.options.lineHeight = options.lineHeight;
      terminal.options.letterSpacing = options.letterSpacing;
      terminal.options.minimumContrastRatio = options.minimumContrastRatio;
    }
    this.scheduleFit();
  }

  setPreferences(preferences: TerminalPreferences) {
    this.mousePolicy = preferences.mousePolicy;
  }

  private handleWheel(surface: TerminalSurface, event: WheelEvent) {
    if (
      surface.transport === "attach" ||
      this.mousePolicy === "exclusive" ||
      surface.terminal.modes.mouseTrackingMode === "none"
    )
      return true;
    if (this.mousePolicy !== "terminal" && !event.shiftKey) return true;
    event.preventDefault();
    const direction = event.deltaY < 0 ? -1 : 1;
    if (surface.terminal.buffer.active.baseY > 0)
      surface.terminal.scrollLines(direction * 3);
    else if (surface.terminal.buffer.active.type === "alternate")
      surface.terminal.input(direction < 0 ? "\x1b[A" : "\x1b[B", false);
    return false;
  }
}
