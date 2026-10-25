import type { LayoutNode, PaneNode, TerminalTab } from "../model";

export function getPanes(node: LayoutNode | null): PaneNode[] {
  if (!node) return [];
  return node.type === "pane"
    ? [node]
    : [...getPanes(node.first), ...getPanes(node.second)];
}

export function findNode(
  node: LayoutNode | null,
  id: string,
): LayoutNode | undefined {
  if (!node || node.id === id) return node || undefined;
  if (node.type === "pane") return undefined;
  return findNode(node.first, id) || findNode(node.second, id);
}

export function findPane(
  node: LayoutNode | null,
  id?: string,
): PaneNode | undefined {
  const match = id ? findNode(node, id) : undefined;
  return match?.type === "pane" ? match : undefined;
}

export function getTabs(node: LayoutNode | null): TerminalTab[] {
  return getPanes(node).flatMap((pane) => pane.tabs);
}

export function replaceNode(
  node: LayoutNode,
  id: string,
  replacement: LayoutNode,
): LayoutNode {
  if (node.id === id) return replacement;
  if (node.type === "pane") return node;
  return {
    ...node,
    first: replaceNode(node.first, id, replacement),
    second: replaceNode(node.second, id, replacement),
  };
}

export function removePane(
  node: LayoutNode | null,
  id: string,
): LayoutNode | null {
  if (!node) return null;
  if (node.type === "pane") return node.id === id ? null : node;
  const first = removePane(node.first, id);
  const second = removePane(node.second, id);
  if (!first) return second;
  if (!second) return first;
  return { ...node, first, second };
}

export function getNodeIds(node: LayoutNode | null): string[] {
  if (!node) return [];
  return node.type === "pane"
    ? [node.id]
    : [node.id, ...getNodeIds(node.first), ...getNodeIds(node.second)];
}
