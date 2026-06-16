/**
 * Flashcard tool.
 *
 * The model calls `propose_flashcard` when it wants to draft a
 * flashcard for the user. Crucially, this tool does NOT persist the
 * card — the user sees it in the chat, optionally reveals the
 * answer, and then clicks "Save" to write it to disk.
 *
 * The proposal carries everything the save service needs: the Q/A
 * text, the source note (so we can show a backlink), the test name
 * (for the target file name), and a `proposalId` for de-duplication
 * if the model emits the same card twice in a row.
 *
 * The tool returns a short status string for the model. The full
 * proposal object is captured by closure and surfaced to the chat
 * UI via the `pendingProposals` array — the chat modal reads from
 * there when the user clicks Save.
 */

import { Tool } from "../toolRegistry.js";

export interface FlashcardProposal {
  /** Stable id, minted at proposal time. Used for de-duplication. */
  proposalId: string;
  /** Card front (the question). */
  question: string;
  /** Card back (the answer). */
  answer: string;
  /** Source note path if known, e.g. "Calculus - Limits.md". */
  sourceNote: string;
  /** Test name the card is associated with, e.g. "Math Final". */
  testName: string;
  /** UTC ms when the model proposed the card. */
  proposedAt: number;
}

/**
 * Captured proposals from the current chat turn. The chat modal
 * reads from this array when rendering flashcard UI. The model
 * cannot see it — it just sees the tool's return string.
 */
export const pendingProposals: FlashcardProposal[] = [];

export function mintId(): string {
  // crypto.randomUUID is available in Obsidian's renderer (Electron
  // has it). Fall back to a timestamp-based id in the unlikely
  // event it isn't.
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `fc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createFlashcardTools(): Tool[] {
  return [
    {
      name: "propose_flashcard",
      description:
        "Propose a flashcard for the user. The card is shown in the chat with a 'Save' button — it is NOT saved to disk until the user explicitly saves it. Call this tool once per card you want to draft. Always include a test name (use 'General' if the card is not tied to a specific test) and the source note when known. Do not propose cards that duplicate content the user has already seen. Do not propose cards from notes you have not read with read_note or surfaced via search_notes. IMPORTANT: after calling this tool, do NOT repeat the question or answer in your final prose response — keep your reply to a short framing sentence.",
      parameters: {
        type: "OBJECT",
        description: "Propose a flashcard to the user",
        properties: {
          question: {
            type: "STRING",
            description: "The card front — what the user is asked. Keep it short, one sentence.",
          },
          answer: {
            type: "STRING",
            description: "The card back — the correct answer. Can be a few sentences.",
          },
          source_note: {
            type: "STRING",
            description: "Vault-relative path of the note the card is based on, e.g. 'Calculus - Limits.md'. Use '' if the card is general knowledge.",
          },
          test_name: {
            type: "STRING",
            description: "The name of the test the card belongs to, e.g. 'Math Final'. Use 'General' if not tied to a specific test.",
          },
        },
        required: ["question", "answer"],
      },
      async execute(args) {
        const question = typeof args.question === "string" ? args.question : "";
        const answer = typeof args.answer === "string" ? args.answer : "";
        const sourceNote = typeof args.source_note === "string" ? args.source_note : "";
        const testName = typeof args.test_name === "string" && args.test_name.trim().length > 0
          ? args.test_name.trim()
          : "General";

        if (!question.trim() || !answer.trim()) {
          return "Error: 'question' and 'answer' are required and must be non-empty.";
        }

        // De-dupe against the current turn's proposals. If the same
        // Q/A pair is proposed twice, we collapse it to one.
        const dup = pendingProposals.find(
          (p) => p.question === question && p.answer === answer,
        );
        if (dup) {
          return `Card already proposed this turn (id=${dup.proposalId}).`;
        }

        const proposal: FlashcardProposal = {
          proposalId: mintId(),
          question,
          answer,
          sourceNote,
          testName,
          proposedAt: Date.now(),
        };
        pendingProposals.push(proposal);
        return `Proposed flashcard (id=${proposal.proposalId}). The user can save it from the chat UI.`;
      },
    },
  ];
}
