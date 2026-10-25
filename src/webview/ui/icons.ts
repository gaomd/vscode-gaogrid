import add from "@vscode/codicons/src/icons/add.svg";
import copy from "@vscode/codicons/src/icons/copy.svg";
import ellipsis from "@vscode/codicons/src/icons/ellipsis.svg";
import splitHorizontal from "@vscode/codicons/src/icons/split-horizontal.svg";
import splitVertical from "@vscode/codicons/src/icons/split-vertical.svg";

const sources = {
  add,
  copy,
  ellipsis,
  "split-horizontal": splitHorizontal,
  "split-vertical": splitVertical,
};

export type IconName = keyof typeof sources;

const templates = new Map<IconName, SVGSVGElement>();

/** Center Codicons' artwork within its original scale, independently of fonts. */
export function createIcon(name: IconName): SVGSVGElement {
  let template = templates.get(name);
  if (!template) {
    const parsed = new DOMParser().parseFromString(
      sources[name],
      "image/svg+xml",
    );
    template = document.importNode(
      parsed.documentElement,
      true,
    ) as unknown as SVGSVGElement;
    template.classList.add("control__icon");
    template.dataset.icon = name;
    template.setAttribute("aria-hidden", "true");
    template.setAttribute("focusable", "false");

    // Measure each bundled asset once in SVG coordinates, including its own
    // asymmetric whitespace. Preserve the viewBox size to avoid scaling changes.
    template.style.cssText =
      "position:fixed;visibility:hidden;pointer-events:none";
    document.body.append(template);
    const bounds = template.getBBox();
    const { width, height } = template.viewBox.baseVal;
    template.setAttribute(
      "viewBox",
      `${bounds.x + bounds.width / 2 - width / 2} ${bounds.y + bounds.height / 2 - height / 2} ${width} ${height}`,
    );
    template.remove();
    template.removeAttribute("style");
    templates.set(name, template);
  }
  return template.cloneNode(true) as SVGSVGElement;
}
