/**
 * Markdown rendering helpers for the Cortex chat UI.
 *
 * The chat modal uses Obsidian's `MarkdownRenderer` so assistant replies
 * are displayed as real headings, lists, bold text, code blocks, tables,
 * and wikilinks instead of raw Markdown syntax.
 *
 * `MarkdownRenderer.render()` only *formats* links — it does not attach
 * click handlers. In a `MarkdownView`, Obsidian installs a workspace
 * click delegate that resolves `href` → `TFile` and calls
 * `app.workspace.openLinkText()`. The chat modal renders into a plain
 * `Modal` content element with no such delegate, so we wire it ourselves
 * via `wireLinkClicks()` after every render.
 */

import { App, Component, MarkdownRenderer } from "obsidian";

/**
 * Render a Markdown string into the supplied container, resolving
 * internal links against the active file (or the vault root if no file
 * is open). The parent component manages the lifecycle of any child
 * renderers created by Obsidian.
 */
export async function renderChatMarkdown(
  app: App,
  markdown: string,
  container: HTMLElement,
  component: Component,
): Promise<void> {
  const sourcePath = app.workspace.getActiveFile()?.path ?? "";
  // Obsidian's renderer appends child elements to `container`.
  container.empty();
  await MarkdownRenderer.render(app, markdown, container, sourcePath, component);
  wireLinkClicks(container, app, sourcePath, component);
}

/**
 * Selector for anchors produced by `MarkdownRenderer` that should be
 * treated as vault links. `.internal-link` is the class Obsidian adds to
 * both `[[wikilinks]]` and `[text](path.md)` links after resolution; the
 * `a[href$='.md']` fallback covers cases where the class is missing
 * (e.g. links in code blocks the renderer stripped the class on, or links
 * emitted by some custom post-processors).
 */
const INTERNAL_LINK_SELECTOR = "a.internal-link, a[href*='.md']";

/**
 * Walk `container` and attach a click handler to every internal-link
 * anchor. External (`http(s)://`, `file://`) anchors are left alone so
 * the browser handles them normally. Each anchor is wired at most once
 * via `dataset.cortexWired`.
 */
export function wireLinkClicks(
  container: HTMLElement,
  app: App,
  sourcePath: string,
  component: Component,
): void {
  const links = container.querySelectorAll<HTMLAnchorElement>(INTERNAL_LINK_SELECTOR);
  links.forEach((anchor) => {
    if (anchor.dataset.cortexWired === "1") return;
    const href = anchor.getAttribute("href") ?? "";
    if (isExternalHref(href)) return;
    anchor.dataset.cortexWired = "1";
    component.registerDomEvent(anchor, "click", (ev: MouseEvent) => {
      const resolved = resolveLinkClick(anchor, ev);
      if (!resolved) return;
      ev.preventDefault();
      ev.stopPropagation();
      void app.workspace.openLinkText(
        resolved.linktext,
        sourcePath,
        resolved.newLeaf,
      );
    });
  });
}

/**
 * Decide whether a click on `anchor` should open a vault note.
 *
 * Returns `null` for external links (the caller should leave them for
 * the browser). Otherwise returns the linktext to pass to
 * `app.workspace.openLinkText()` and whether to open in a new pane
 * (Ctrl/Cmd-click).
 *
 * Obsidian's renderer writes the resolved target into `data-href`
 * (preserving `[[Note#Heading|Alias]]` form), with `href` as a
 * file://-style path and `textContent` as the alias. We prefer
 * `data-href` and fall back to the alias / href so this works for any
 * anchor the renderer emits.
 */
export function resolveLinkClick(
  anchor: Pick<HTMLAnchorElement, "getAttribute" | "textContent">,
  ev: Pick<MouseEvent, "ctrlKey" | "metaKey">,
): { linktext: string; newLeaf: boolean } | null {
  const href = anchor.getAttribute("href") ?? "";
  if (isExternalHref(href)) return null;
  const linktext =
    anchor.getAttribute("data-href") ??
    anchor.textContent ??
    href;
  if (!linktext) return null;
  return { linktext, newLeaf: ev.ctrlKey || ev.metaKey };
}

/** True for hrefs the browser should handle (http, https, file, mailto). */
function isExternalHref(href: string): boolean {
  return /^(https?:|file:|mailto:|tel:)/i.test(href);
}
