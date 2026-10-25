import { createIcon, type IconName } from "./icons";

export interface MenuItem {
  label: string;
  icon: IconName;
  shortcut?: string;
  disabled?: boolean;
  separatorBefore?: boolean;
  run(): void;
}

type MenuPosition = { anchor: HTMLElement } | { x: number; y: number };

/** One portal and one dismissal lifecycle for toolbar and context menus. */
export class MenuController {
  private element?: HTMLElement;
  private listeners?: AbortController;
  private returnFocus?: HTMLElement;

  open(items: MenuItem[], position: MenuPosition) {
    this.close();
    const menu = document.createElement("div");
    menu.id = "gaogrid-pane-menu";
    menu.className = "action-menu";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "Pane actions");
    this.element = menu;
    this.returnFocus = "anchor" in position ? position.anchor : undefined;
    this.returnFocus?.setAttribute("aria-expanded", "true");

    const buttons = items.map((item) => {
      if (item.separatorBefore) {
        const separator = document.createElement("div");
        separator.className = "action-menu__separator";
        separator.setAttribute("role", "separator");
        menu.append(separator);
      }
      const button = document.createElement("button");
      button.type = "button";
      button.className = "action-menu__item";
      button.setAttribute("role", "menuitem");
      button.disabled = !!item.disabled;
      const label = document.createElement("span");
      label.className = "action-menu__label";
      label.textContent = item.label;
      button.append(createIcon(item.icon), label);
      if (item.shortcut) {
        const shortcut = document.createElement("kbd");
        shortcut.className = "action-menu__shortcut";
        shortcut.textContent = item.shortcut;
        button.append(shortcut);
      }
      button.addEventListener("click", () => {
        this.close();
        item.run();
      });
      menu.append(button);
      return button;
    });

    document.body.append(menu);
    const spacing = Number.parseFloat(
      getComputedStyle(menu).getPropertyValue("--gg-space"),
    );
    const gutter = Number.isFinite(spacing) ? spacing : 0;
    const anchor =
      "anchor" in position
        ? position.anchor.getBoundingClientRect()
        : undefined;
    const header =
      "anchor" in position
        ? position.anchor.closest(".pane-header")?.getBoundingClientRect()
        : undefined;
    const x = anchor
      ? anchor.right - menu.offsetWidth
      : "x" in position
        ? position.x
        : 0;
    const y = anchor
      ? (header?.bottom ?? anchor.bottom + gutter)
      : "y" in position
        ? position.y
        : 0;
    menu.style.left = `${Math.max(gutter, Math.min(x, innerWidth - menu.offsetWidth - gutter))}px`;
    menu.style.top = `${Math.max(gutter, Math.min(y, innerHeight - menu.offsetHeight - gutter))}px`;

    const listeners = new AbortController();
    this.listeners = listeners;
    const options = { capture: true, signal: listeners.signal };
    document.addEventListener(
      "pointerdown",
      (event) => {
        if (!menu.contains(event.target as Node)) this.close();
      },
      options,
    );
    window.addEventListener("blur", () => this.close(), {
      signal: listeners.signal,
    });
    window.addEventListener("resize", () => this.close(), {
      signal: listeners.signal,
    });
    menu.addEventListener("keydown", (event) => {
      const enabled = buttons.filter((button) => !button.disabled);
      const current = enabled.indexOf(
        document.activeElement as HTMLButtonElement,
      );
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.close(true);
      } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? enabled.length - 1
              : (current +
                  (event.key === "ArrowDown" ? 1 : -1) +
                  enabled.length) %
                enabled.length;
        enabled[next]?.focus();
      }
    });
    buttons.find((button) => !button.disabled)?.focus();
  }

  close(restoreFocus = false) {
    this.listeners?.abort();
    this.element?.remove();
    this.returnFocus?.setAttribute("aria-expanded", "false");
    if (restoreFocus) this.returnFocus?.focus();
    this.element = undefined;
    this.listeners = undefined;
    this.returnFocus = undefined;
  }
}
