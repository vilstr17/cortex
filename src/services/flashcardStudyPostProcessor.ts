/**
 * Flashcard study post-processor.
 *
 * A `MarkdownPostProcessor` that watches the rendered markdown of
 * notes whose YAML frontmatter has `flashcards: true` and injects
 * a "▶ Study flashcards" button at the top of the rendered view.
 *
 * The actual click handling is a workspace-level delegate
 * registered in `main.ts:onload()` so the same handler works
 * for cards the user opens with the workspace, the command
 * palette, or a `[[link]]` from another note.
 */

import { MarkdownPostProcessorContext, TFile } from "obsidian";
import type ChronotePlugin from "../main.js";
import { StudyFlashcardsModal } from "../modals/StudyFlashcardsModal.js";
import { parseSavedCardsFromMarkdown } from "./flashcardSaveService.js";

/**
 * `ctx.sourcePath` is the vault-relative path of the markdown
 * file being rendered. Returns the corresponding `TFile`, or
 * null if the file cannot be resolved.
 */
function resolveFile(plugin: ChronotePlugin, ctx: MarkdownPostProcessorContext): TFile | null {
  const path = ctx.sourcePath;
  if (!path) return null;
  const file = plugin.app.vault.getAbstractFileByPath(path);
  return file instanceof TFile ? file : null;
}

/**
 * True iff the frontmatter marks this note as a saved flashcard deck.
 *
 * The save service writes `flashcards: true` (a YAML boolean), but
 * Obsidian's metadata cache can surface the same value as the string
 * `"true"` depending on the YAML parser version, file encoding, or
 * any hand-edit. Treat both as a match so the Study button reliably
 * shows up — otherwise the deck is silently unreachable on a saved
 * file the user expected to be interactive.
 */
function isFlashcardNote(fm: unknown): boolean {
  if (!fm || typeof fm !== "object") return false;
  const flag = (fm as Record<string, unknown>).flashcards;
  return flag === true || flag === "true";
}

/**
 * The post-processor callback. Obsidian invokes this once per
 * rendered markdown block. We check the frontmatter and, if
 * this is a flashcard note, prepend a Study button to the
 * `el` element.
 */
export const chronoteStudyPostProcessor =
  (plugin: ChronotePlugin) =>
  async (el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void> => {
    // Frontmatter lives in the metadata cache, not the rendered
    // element. We can read it from the source file directly.
    const file = resolveFile(plugin, ctx);
    if (!file) return;
    const cache = plugin.app.metadataCache.getFileCache(file);
    const fm = cache?.frontmatter;
    if (!isFlashcardNote(fm)) return;

    // Build the Study button. We attach it as a sibling of the
    // first rendered child by inserting at the very top of `el`.
    const wrapper = activeDocument.createElement("div");
    wrapper.className = "chronote-flashcard-study-wrapper";

    const button = activeDocument.createElement("button");
    button.className = "mod-cta chronote-flashcard-study-btn";
    button.textContent = "▶ Study flashcards";
    button.setAttribute("data-chronote-study", file.path);

    wrapper.appendChild(button);
    el.prepend(wrapper);
  };

/**
 * Open the Study modal for a given file. Reads the file's
 * markdown, parses it back into proposals, and shows the deck.
 *
 * Called from the workspace click delegate in `main.ts`.
 */
export async function openStudyForFile(
  plugin: ChronotePlugin,
  file: TFile,
): Promise<void> {
  const content = await plugin.app.vault.cachedRead(file);
  const fallbackName = file.basename.replace(/^Flashcards\s*-\s*/, "");
  const cards = parseSavedCardsFromMarkdown(content, fallbackName);

  if (cards.length === 0) {
    new (await import("obsidian")).Notice(
      "Chronote: no flashcards found in this note.",
    );
    return;
  }

  const fm = plugin.app.metadataCache.getFileCache(file)?.frontmatter;
  const testName =
    (fm && typeof (fm as Record<string, unknown>).test === "string"
      ? ((fm as Record<string, unknown>).test as string)
      : null) ?? fallbackName;

  new StudyFlashcardsModal(plugin.app, plugin, cards, testName).open();
}
