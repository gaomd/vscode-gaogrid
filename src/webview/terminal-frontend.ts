import { Terminal } from "@xterm/xterm";
import { TerminalFitAddon } from "./terminal-fit";
import { ImageAddon } from "@xterm/addon-image";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import type { TerminalTab } from "../model";
import { readTerminalOptions } from "./terminal-theme";
import { TerminalScrollbar } from "./terminal-scrollbar";
import { installTerminalDrop } from "./terminal-drop";

interface TerminalSurface {
  terminal: Terminal;
  fit: TerminalFitAddon;
  host: HTMLElement;
  sessionId: string;
  opened: boolean;
  fontSizeOverride?: number;
  scrollbar?: TerminalScrollbar;
  webgl?: WebglAddon;
  webglFailed?: boolean;
  disposeDrop(): void;
}

/** Owns terminal rendering and focus; it has no layout or persistence logic. */
export class TerminalFrontend {
  private readonly surfaces = new Map<string, TerminalSurface>();
  private readonly sessionTabs = new Map<string, string>();
  private readonly pendingOutput = new Map<string, string>();
  private readonly closedSessions = new Set<string>();
  private frame?: number;
  private focusRequest = 0;
  private useWebgl = true;
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
      if (existing.host !== host) {
        this.resizeObserver.unobserve(existing.host);
        existing.disposeDrop();
        existing.disposeDrop = this.installDrop(
          host,
          existing.terminal,
          tab.sessionId,
        );
      }
      if (existing.host !== host && existing.terminal.element)
        host.append(existing.terminal.element);
      if (existing.host !== host) existing.scrollbar?.mount(host);
      existing.host = host;
      this.resizeObserver.observe(host);
      this.scheduleFit();
      return;
    }

    const terminal = new Terminal({
      ...readTerminalOptions(),
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 10000,
      // Opaque glyph rasterization keeps text edges blended against the actual
      // terminal background. Inline images have their own transparent layer.
      allowTransparency: false,
      rightClickSelectsWord: true,
    });
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
    terminal.attachCustomKeyEventHandler((event) => {
      if (
        event.key !== "Enter" ||
        !event.shiftKey ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.isComposing ||
        event.keyCode === 229
      )
        return true;
      event.preventDefault();
      // xterm maps Shift+Enter to plain Enter. CSI-u preserves the modifier so
      // applications such as Codex can insert a newline instead of submitting.
      if (event.type === "keydown") terminal.input("\x1b[13;2u");
      return false;
    });
    terminal.onResize(({ cols, rows }) =>
      this.send({ type: "resize", sessionId: tab.sessionId, cols, rows }),
    );
    this.surfaces.set(tab.id, {
      terminal,
      fit,
      host,
      sessionId: tab.sessionId,
      opened: false,
      disposeDrop: this.installDrop(host, terminal, tab.sessionId),
    });
    this.sessionTabs.set(tab.sessionId, tab.id);
    this.resizeObserver.observe(host);
    const output = this.pendingOutput.get(tab.sessionId);
    if (output) {
      terminal.write(output);
      this.pendingOutput.delete(tab.sessionId);
    }
    this.scheduleFit();
  }

  write(sessionId: string, data: string) {
    if (this.closedSessions.has(sessionId)) return;
    const tabId = this.sessionTabs.get(sessionId);
    const surface = tabId ? this.surfaces.get(tabId) : undefined;
    if (surface) surface.terminal.write(data);
    else
      this.pendingOutput.set(
        sessionId,
        ((this.pendingOutput.get(sessionId) || "") + data).slice(-512000),
      );
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
      this.resizeObserver.unobserve(surface.host);
      surface.disposeDrop();
      surface.scrollbar?.dispose();
      surface.terminal.dispose();
    }
    this.surfaces.delete(tab.id);
    this.sessionTabs.delete(tab.sessionId);
    this.pendingOutput.delete(tab.sessionId);
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
    return installTerminalDrop(host, (resources, names) => {
      terminal.focus();
      this.send({ type: "dropPaths", sessionId, resources, names });
    });
  }

  private fitVisible() {
    for (const surface of this.surfaces.values()) {
      if (!this.isVisible(surface)) continue;
      if (!surface.opened) {
        surface.terminal.open(surface.host);
        surface.opened = true;
        this.updateRenderer(surface);
        surface.scrollbar = new TerminalScrollbar(
          surface.terminal,
          surface.host,
        );
      }
      surface.fit.fit();
      surface.scrollbar?.sync();
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
}
