/**
 * Tests for the round-trip parser:
 *   parseSavedCardsFromMarkdown(renderCardsBlock(proposals)) ≈ proposals
 *
 * The save service writes markdown in a specific shape (## Q:, > answer,
 * optional **Source:** [[Note]]). The Study view needs to read that
 * shape back into FlashcardProposal[] so the interactive deck can
 * render saved cards. This suite locks down the parser's contract.
 */

import { describe, it, expect } from "vitest";
import { parseSavedCardsFromMarkdown } from "../flashcardSaveService.js";
import type { FlashcardProposal } from "../../agent/tools/flashcards.js";

/**
 * Build a hand-crafted saved-note string. We don't have access to
 * the (private) `renderCardsBlock` from the test, so we assemble
 * the markdown shape directly. This is the same shape the save
 * service emits — see `src/services/flashcardSaveService.ts`.
 */
function buildSavedNote(parts: {
  testName?: string;
  frontmatterExtra?: string;
  cards: Array<{ question: string; answer: string; sourceNote?: string }>;
}): string {
  const lines: string[] = ["---", "flashcards: true"];
  if (parts.testName) {
    lines.push(`test: "${parts.testName}"`);
  }
  if (parts.frontmatterExtra) {
    lines.push(parts.frontmatterExtra);
  }
  lines.push("---", "", "# Flashcards", "");

  for (const c of parts.cards) {
    lines.push(`## Q: ${c.question}`);
    lines.push("");
    if (c.sourceNote) {
      // The renderer stores the `.md` suffix on `sourceNote`, so the
      // backlink is rendered WITHOUT the suffix.
      const stem = c.sourceNote.replace(/\.md$/, "");
      lines.push(`**Source:** [[${stem}]]`);
      lines.push("");
    }
    lines.push(`> ${c.answer}`);
    lines.push("");
  }
  return lines.join("\n");
}

describe("parseSavedCardsFromMarkdown", () => {
  it("parses a single card from a saved note", () => {
    const md = buildSavedNote({
      testName: "Math Final",
      cards: [{ question: "What is 2+2?", answer: "4", sourceNote: "Math.md" }],
    });
    const cards = parseSavedCardsFromMarkdown(md, "fallback");
    expect(cards).toHaveLength(1);
    expect(cards[0].question).toBe("What is 2+2?");
    expect(cards[0].answer).toBe("4");
    expect(cards[0].sourceNote).toBe("Math.md");
    expect(cards[0].testName).toBe("Math Final");
    // proposalId is freshly minted, so we just check it exists.
    expect(cards[0].proposalId).toBeTruthy();
  });

  it("parses multiple cards in order", () => {
    const md = buildSavedNote({
      testName: "Bio",
      cards: [
        { question: "Q1", answer: "A1" },
        { question: "Q2", answer: "A2" },
        { question: "Q3", answer: "A3" },
      ],
    });
    const cards = parseSavedCardsFromMarkdown(md, "fb");
    expect(cards.map((c) => c.question)).toEqual(["Q1", "Q2", "Q3"]);
    expect(cards.map((c) => c.answer)).toEqual(["A1", "A2", "A3"]);
  });

  it("uses the test name from the frontmatter, not the fallback", () => {
    const md = buildSavedNote({
      testName: "Calculus - Limits",
      cards: [{ question: "Q", answer: "A" }],
    });
    const cards = parseSavedCardsFromMarkdown(md, "fallback-name");
    expect(cards[0].testName).toBe("Calculus - Limits");
  });

  it("falls back when there is no frontmatter at all", () => {
    const md = "## Q: only-card\n\n> only-answer\n";
    const cards = parseSavedCardsFromMarkdown(md, "No Fm");
    expect(cards).toHaveLength(1);
    expect(cards[0].testName).toBe("No Fm");
    expect(cards[0].question).toBe("only-card");
    expect(cards[0].answer).toBe("only-answer");
  });

  it("ignores `## Saved …` batch headers — only `## Q:` cards count", () => {
    const md = [
      "---",
      "flashcards: true",
      "---",
      "",
      "## Saved 2026-06-14 (2 cards)",
      "",
      "## Q: first",
      "",
      "> first answer",
      "",
      "## Saved 2026-06-15 (1 card)",
      "",
      "## Q: second",
      "",
      "> second answer",
      "",
    ].join("\n");
    const cards = parseSavedCardsFromMarkdown(md, "T");
    // The two `## Saved` headings must not be misread as card fronts.
    expect(cards).toHaveLength(2);
    expect(cards[0].question).toBe("first");
    expect(cards[1].question).toBe("second");
  });

  it("captures source note as `Note.md` even though the backlink drops the suffix", () => {
    const md = buildSavedNote({
      testName: "T",
      cards: [{ question: "Q", answer: "A", sourceNote: "Calculus - Limits.md" }],
    });
    const cards = parseSavedCardsFromMarkdown(md, "fallback");
    expect(cards[0].sourceNote).toBe("Calculus - Limits.md");
  });

  it("leaves sourceNote empty when no source line is present", () => {
    const md = buildSavedNote({
      testName: "T",
      cards: [{ question: "Q", answer: "A" }],
    });
    const cards = parseSavedCardsFromMarkdown(md, "fb");
    expect(cards[0].sourceNote).toBe("");
  });

  it("returns an empty list for an empty file", () => {
    const cards = parseSavedCardsFromMarkdown("", "fallback");
    expect(cards).toEqual([]);
  });

  it("returns an empty list for a note with no Q/A pairs", () => {
    const md = [
      "---",
      "flashcards: true",
      "---",
      "",
      "# Just a heading",
      "",
      "Some prose, but no Q/A.",
      "",
    ].join("\n");
    const cards = parseSavedCardsFromMarkdown(md, "fb");
    expect(cards).toEqual([]);
  });

  it("mints a fresh proposalId per card (de-dup safe)", () => {
    const md = buildSavedNote({
      testName: "T",
      cards: [
        { question: "Q1", answer: "A1" },
        { question: "Q2", answer: "A2" },
      ],
    });
    const cards = parseSavedCardsFromMarkdown(md, "T");
    expect(cards[0].proposalId).not.toBe(cards[1].proposalId);
  });

  it("handles multi-line answers (consecutive `> ` lines)", () => {
    // The renderer may emit multi-line answers across consecutive
    // `> ` lines — the parser should join them.
    const md = [
      "## Q: multi?",
      "",
      "> line one",
      "> line two",
      "> line three",
      "",
    ].join("\n");
    const cards = parseSavedCardsFromMarkdown(md, "fb");
    expect(cards).toHaveLength(1);
    expect(cards[0].answer).toBe("line one\nline two\nline three");
  });

  it("handles windows-style line endings", () => {
    const md = "## Q: win\r\n\r\n> ans\r\n";
    const cards = parseSavedCardsFromMarkdown(md, "fb");
    expect(cards).toHaveLength(1);
    expect(cards[0].question).toBe("win");
    expect(cards[0].answer).toBe("ans");
  });

  it("round-trips: parseSavedCardsFromMarkdown(buildSavedNote) preserves key fields", () => {
    const original: Array<FlashcardProposal> = [
      {
        proposalId: "x1",
        question: "What is photosynthesis?",
        answer: "Plants converting sunlight to energy.",
        sourceNote: "Biology.md",
        testName: "Biology Midterm",
        proposedAt: Date.UTC(2026, 5, 14, 10, 30, 0),
      },
      {
        proposalId: "x2",
        question: "Define mitosis.",
        answer: "Cell division producing two identical daughter cells.",
        sourceNote: "Biology.md",
        testName: "Biology Midterm",
        proposedAt: Date.UTC(2026, 5, 14, 10, 30, 1),
      },
    ];
    const md = buildSavedNote({
      testName: "Biology Midterm",
      cards: original.map((c) => ({
        question: c.question,
        answer: c.answer,
        sourceNote: c.sourceNote,
      })),
    });
    const parsed = parseSavedCardsFromMarkdown(md, "fallback");

    expect(parsed).toHaveLength(2);
    expect(parsed[0].question).toBe(original[0].question);
    expect(parsed[0].answer).toBe(original[0].answer);
    expect(parsed[0].sourceNote).toBe(original[0].sourceNote);
    expect(parsed[0].testName).toBe("Biology Midterm");
    expect(parsed[1].question).toBe(original[1].question);
  });
});
