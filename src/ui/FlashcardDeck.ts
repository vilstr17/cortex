/**
 * Interactive flashcard deck renderer for the Cortex chat UI.
 *
 * Replaces the old static reveal-list with a card component that supports
 * front/back flipping, previous/next navigation, progress indication,
 * and a save-all action.
 */

import { FlashcardProposal } from "../agent/tools/flashcards.js";
import { SaveResult } from "../services/flashcardSaveService.js";

export interface FlashcardDeckOptions {
  testName: string;
  /**
   * Save handler. Returns the save result on success, or `null`
   * if the user cancelled the save dialog (or if there was
   * nothing to save). The deck shows "✓ Saved" on a non-null
   * result and resets the button to its initial label on a null.
   */
  onSave: () => Promise<SaveResult | null>;
}

/**
 * Render an interactive deck for a single group of flashcard proposals.
 */
export function renderFlashcardDeck(
  parent: HTMLElement,
  proposals: FlashcardProposal[],
  options: FlashcardDeckOptions,
): void {
  if (proposals.length === 0) return;

  const deck = parent.createDiv({ cls: "cortex-flashcard-deck" });

  const header = deck.createDiv({ cls: "cortex-flashcard-deck-header" });
  const title = header.createDiv({ cls: "cortex-flashcard-deck-title" });
  const progress = header.createDiv({ cls: "cortex-flashcard-deck-progress" });

  const stage = deck.createDiv({ cls: "cortex-flashcard-stage" });
  const cardInner = stage.createDiv({ cls: "cortex-flashcard-inner" });
  const front = cardInner.createDiv({ cls: "cortex-flashcard-face cortex-flashcard-front" });
  const back = cardInner.createDiv({ cls: "cortex-flashcard-face cortex-flashcard-back" });

  const questionEl = front.createDiv({ cls: "cortex-flashcard-question" });
  const answerEl = back.createDiv({ cls: "cortex-flashcard-answer" });
  const sourceEl = back.createDiv({ cls: "cortex-flashcard-source" });

  const controls = deck.createDiv({ cls: "cortex-flashcard-controls" });
  const prevBtn = controls.createEl("button", {
    cls: "cortex-flashcard-control-btn",
    text: "← Prev",
  });
  const flipBtn = controls.createEl("button", {
    cls: "cortex-flashcard-control-btn cortex-flashcard-flip-btn",
    text: "Flip",
  });
  const nextBtn = controls.createEl("button", {
    cls: "cortex-flashcard-control-btn",
    text: "Next →",
  });

  const footer = deck.createDiv({ cls: "cortex-flashcard-footer" });
  const saveBtn = footer.createEl("button", {
    cls: "mod-cta cortex-flashcard-save-btn",
    text: `💾 Save ${proposals.length} to “${options.testName}”`,
  });

  let current = 0;
  let revealed = false;

  function updateCard() {
    const card = proposals[current];
    questionEl.setText(card.question);
    answerEl.setText(card.answer);
    sourceEl.setText(card.sourceNote ? `Source: ${card.sourceNote}` : "");
    sourceEl.style.display = card.sourceNote ? "" : "none";

    progress.setText(`${current + 1} / ${proposals.length}`);
    title.setText(`Flashcards — ${options.testName}`);

    prevBtn.disabled = current === 0;
    nextBtn.disabled = current === proposals.length - 1;

    revealed = false;
    cardInner.removeClass("flipped");
    flipBtn.setText("Show answer");
  }

  function toggleFlip() {
    revealed = !revealed;
    cardInner.toggleClass("flipped", revealed);
    flipBtn.setText(revealed ? "Hide answer" : "Show answer");
  }

  stage.addEventListener("click", () => toggleFlip());
  flipBtn.addEventListener("click", () => toggleFlip());

  prevBtn.addEventListener("click", () => {
    if (current > 0) {
      current--;
      updateCard();
    }
  });

  nextBtn.addEventListener("click", () => {
    if (current < proposals.length - 1) {
      current++;
      updateCard();
    }
  });

  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    saveBtn.setText("Saving…");
    try {
      const result = await options.onSave();
      if (result === null) {
        // User cancelled the save dialog (or there was nothing
        // to save). Reset the button so they can try again.
        saveBtn.disabled = false;
        saveBtn.setText(`💾 Save ${proposals.length} to “${options.testName}”`);
        return;
      }
      saveBtn.setText("✓ Saved");
      // Visually mark the deck as saved.
      deck.addClass("is-saved");
    } catch (err) {
      console.error("Cortex: failed to save flashcards:", err);
      saveBtn.disabled = false;
      saveBtn.setText(`💾 Save ${proposals.length} to “${options.testName}”`);
    }
  });

  updateCard();
}
