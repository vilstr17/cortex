/**
 * Study Flashcards Modal.
 *
 * A wrapper around `renderFlashcardDeck` that opens a saved
 * flashcard note as an interactive deck. The user can flip
 * through the cards with prev/next/show-answer exactly the same
 * way the chat-deck works.
 *
 * This modal is opened by the workspace click delegate registered
 * in `main.ts` when the user clicks the "▶ Study flashcards"
 * button that the Cortex markdown post-processor injects into
 * notes whose frontmatter has `flashcards: true`.
 */

import { App, Modal } from "obsidian";
import { FlashcardProposal } from "../agent/tools/flashcards";
import { renderFlashcardDeck } from "../ui/FlashcardDeck";
import type CortexPlugin from "../main";

export class StudyFlashcardsModal extends Modal {
  private plugin: CortexPlugin;
  private cards: FlashcardProposal[];
  private testName: string;

  constructor(
    app: App,
    plugin: CortexPlugin,
    cards: FlashcardProposal[],
    testName: string,
  ) {
    super(app);
    this.plugin = plugin;
    this.cards = cards;
    this.testName = testName;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("cortex-study-flashcards-modal");

    contentEl.createEl("h2", {
      text: `Study — ${this.testName}`,
    });

    if (this.cards.length === 0) {
      contentEl.createEl("p", {
        text: "This note has no Q/A cards. Add some via the chat, or open the raw markdown to check the format.",
      });
      const footer = contentEl.createDiv({ cls: "cortex-save-fc-footer" });
      const closeBtn = footer.createEl("button", { text: "Close" });
      closeBtn.addEventListener("click", () => this.close());
      return;
    }

    // Reuse the same interactive deck component the chat uses.
    // The Save button is a no-op in study mode — there's nothing
    // new to save; the cards are already on disk.
    renderFlashcardDeck(contentEl, this.cards, {
      testName: this.testName,
      onSave: async () => null,
    });

    const footer = contentEl.createDiv({ cls: "cortex-save-fc-footer" });
    const closeBtn = footer.createEl("button", { text: "Close" });
    closeBtn.addEventListener("click", () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
