/**
 * Markdown rendering helpers for the Cortex chat UI.
 *
 * The chat modal uses Obsidian's `MarkdownRenderer` so assistant replies
 * are displayed as real headings, lists, bold text, code blocks, tables,
 * and wikilinks instead of raw Markdown syntax.
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
}
