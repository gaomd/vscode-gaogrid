import { createIcon, type IconName } from "./icons";

export interface ControlOptions {
  label: string;
  icon?: IconName;
  text?: string;
  className?: string;
  onClick?: (event: MouseEvent) => void;
}

/** Shared geometry and accessible labels for tabs, rail labels, and actions. */
export function createControl(options: ControlOptions): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className =
    `control ${options.icon && !options.text ? "control--icon" : "control--label"} ${options.className || ""}`.trim();
  button.title = options.label;
  button.setAttribute("aria-label", options.label);
  if (options.icon) button.append(createIcon(options.icon));
  if (options.text) {
    const label = document.createElement("span");
    label.className = "control__label";
    label.textContent = options.text;
    button.append(label);
  }
  if (options.onClick) button.addEventListener("click", options.onClick);
  return button;
}

/** Keep existing DOM nodes, their focus, and double-click targets intact. */
export function reconcileChildren(
  parent: HTMLElement,
  children: HTMLElement[],
) {
  children.forEach((child, index) => {
    const current = parent.children[index];
    if (current !== child) parent.insertBefore(child, current || null);
  });
  while (parent.children.length > children.length)
    parent.lastElementChild?.remove();
}
