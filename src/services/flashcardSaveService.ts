/**
 * Flashcard save service.
 *
 * Persists a list of `FlashcardProposal` objects to a markdown
 * note named after the test. Three save target kinds are supported:
 *  - `default`  — write to the folder configured in settings
 *  - `folder`   — write to an ad-hoc folder chosen for this save
 *  - `existing` — append to an existing flashcard note
 *
 * For `default` and `folder`, the file behaviour is:
 *  - If the file doesn't exist, create it with YAML frontmatter
 *    and the proposed cards.
 *  - If the file exists, append a new dated section to it.
 *
 * For `existing`, the same append behaviour runs against the
 * supplied `TFile` directly (no filename derivation, no folder
 * creation).
 *
 * Card markdown format:
 *   ## Q: <question>
 *   **Source:** [[SourceNote]]
 *
 *   > <answer>
 *
 *   <!-- proposedAt: 2026-06-14T10:42:00.000Z -->
 *
 * The module also exports `parseSavedCardsFromMarkdown`, the
 * inverse of `renderCardsBlock` — it walks a saved note and
 * reconstructs the `FlashcardProposal[]` so the Study view can
 * display saved cards in the same interactive deck the chat uses.
 */

import { App, Notice, TFile } from "obsidian";
import { localISODate } from "../utils/dateUtils.js";
import { FlashcardProposal, mintId } from "../agent/tools/flashcards.js";

export interface SaveResult {
  file: TFile;
  cardsAppended: number;
}

/**
 * Where to write the cards. The chat-deck save modal resolves
 * one of these from user input; the service does the I/O.
 *
 *   default  → use the supplied `folder` (the resolved setting
 *              value, may be empty for vault root)
 *   folder   → use the supplied ad-hoc `folder`
 *   existing → append to the supplied `file`
 *
 * The modal is responsible for resolving "default" to a concrete
 * folder path so the service stays storage-agnostic.
 */
export type SaveTarget =
  | { kind: "default"; folder: string }
  | { kind: "folder"; folder: string }
  | { kind: "existing"; file: TFile };

/**
 * Save a list of proposals using the legacy "string folder"
 * signature. Kept as a thin wrapper so older call sites and
 * tests keep working unchanged.
 */
export async function saveProposalsToNote(
  app: App,
  proposals: FlashcardProposal[],
  testName: string,
  flashcardFolder: string,
): Promise<SaveResult | null> {
  return saveProposalsToTarget(
    app,
    proposals,
    testName,
    { kind: "folder", folder: flashcardFolder },
  );
}

/**
 * Save a list of proposals to a markdown note, dispatching on the
 * kind of `target`. Returns the file the cards were written to. If
 * `proposals` is empty, no I/O is performed and the function
 * returns null.
 */
export async function saveProposalsToTarget(
  app: App,
  proposals: FlashcardProposal[],
  testName: string,
  target: SaveTarget,
): Promise<SaveResult | null> {
  if (proposals.length === 0) return null;

  if (target.kind === "existing") {
    return appendToExistingFile(app, proposals, testName, target.file);
  }

  // `default` and `folder` both go through the create-or-append
  // path; the only difference is *which* folder they use.
  return createOrAppendInFolder(app, proposals, testName, target.folder);
}

/**
 * Append a dated section to an existing flashcard note. Used by
 * the `existing` save target.
 */
async function appendToExistingFile(
  app: App,
  proposals: FlashcardProposal[],
  testName: string,
  file: TFile,
): Promise<SaveResult> {
  const body = renderCardsBlock(proposals, testName);
  await app.vault.process(file, (current) => {
    const header = `\n## Saved ${localISODate(new Date())} (${proposals.length} card${proposals.length === 1 ? "" : "s"})\n\n`;
    return current.replace(/\n*$/, "") + "\n" + header + body + "\n";
  });
  new Notice(`Cortex: appended ${proposals.length} card(s) to ${file.name}.`);
  return { file, cardsAppended: proposals.length };
}

/**
 * Create-or-append logic for the `default` and `folder` targets.
 * Sanitizes the test name for the filename, ensures the folder
 * exists, and either creates a fresh note (with frontmatter) or
 * appends a dated section to an existing one.
 */
async function createOrAppendInFolder(
  app: App,
  proposals: FlashcardProposal[],
  testName: string,
  flashcardFolder: string,
): Promise<SaveResult> {
  const safeName = sanitizeForFilename(testName);
  const fileName = `Flashcards - ${safeName}.md`;
  const folder = flashcardFolder.trim() === ""
    ? ""
    : flashcardFolder.trim().replace(/\/$/, "") + "/";
  const filePath = `${folder}${fileName}`;

  // Ensure the folder exists.
  if (folder !== "" && !await app.vault.adapter.exists(folder.replace(/\/$/, ""))) {
    await app.vault.createFolder(folder.replace(/\/$/, ""));
  }

  const body = renderCardsBlock(proposals, testName);

  const existing = app.vault.getAbstractFileByPath(filePath);
  if (existing instanceof TFile) {
    // Append a dated section. Use `process` so the change is
    // undoable by the user.
    await app.vault.process(existing, (current) => {
      const header = `\n## Saved ${localISODate(new Date())} (${proposals.length} card${proposals.length === 1 ? "" : "s"})\n\n`;
      return current.replace(/\n*$/, "") + "\n" + header + body + "\n";
    });
    new Notice(`Cortex: appended ${proposals.length} card(s) to ${fileName}.`);
    return { file: existing, cardsAppended: proposals.length };
  }

  // Create the file with frontmatter.
  const frontmatter = [
    "---",
    "flashcards: true",
    `test: "${testName.replace(/"/g, '\\"')}"`,
    `created: ${localISODate(new Date())}`,
    "---",
    "",
    `# Flashcards — ${testName}`,
    "",
    "Cards are organized by save date. The most recent batch is at the bottom.",
    "",
  ].join("\n");
  const initial = frontmatter + body + "\n";
  const file = await app.vault.create(filePath, initial);
  new Notice(`Cortex: created ${fileName} with ${proposals.length} card(s).`);
  return { file, cardsAppended: proposals.length };
}

/**
 * Render a batch of proposals into a markdown block. One card per
 * section, with the source note as a backlink so Obsidian's graph
 * view picks them up.
 */
function renderCardsBlock(proposals: FlashcardProposal[], testName: string): string {
  return proposals
    .map((p) => {
      const sourceLine = p.sourceNote
        ? `**Source:** [[${p.sourceNote.replace(/\.md$/, "")}]]\n`
        : "";
      return (
        `## Q: ${escapeMarkdown(p.question)}\n` +
        sourceLine +
        `\n` +
        `> ${escapeMarkdown(p.answer)}\n` +
        `\n` +
        `<!-- proposedAt: ${new Date(p.proposedAt).toISOString()} -->\n`
      );
    })
    .join("\n");
}

/**
 * Parse a saved flashcard note back into a list of `FlashcardProposal`
 * objects. Inverse of `renderCardsBlock` — used by the Study view
 * to reconstruct cards from disk so the same interactive deck
 * component can render them.
 *
 * The parser:
 *  - Walks the markdown line-by-line.
 *  - Treats every `## Q: <text>` heading as a card front. (`## Saved …`
 *    batch headers do NOT start with `Q:` and are skipped.)
 *  - Reads the following `> <text>` block as the card back.
 *  - Captures a `**Source:** [[Note]]` line, if present, as the
 *    `sourceNote` field.
 *  - Uses the file's frontmatter `test:` value as the `testName`.
 *  - Mints a fresh `proposalId` per card.
 *
 * Returns an empty list if the file is empty or no Q/A pairs are
 * found. Throws nothing — malformed sections are skipped silently.
 */
export function parseSavedCardsFromMarkdown(
  markdown: string,
  fallbackTestName: string,
): FlashcardProposal[] {
  const lines = markdown.split(/\r?\n/);
  const cards: FlashcardProposal[] = [];
  let testName = fallbackTestName;
  let i = 0;

  // Pull `test:` from YAML frontmatter so parsed cards carry the
  // original test name even if the file was saved by a different
  // build.
  i = consumeFrontmatter(lines, i, (key, value) => {
    if (key === "test" && value) testName = value;
  });

  while (i < lines.length) {
    const line = lines[i];
    // A card front is a `## Q:` heading — strict prefix so that
    // `## Saved 2026-06-15 (3 cards)` is ignored.
    if (/^##\s+Q:\s*/.test(line)) {
      const parsed = readCard(lines, i, testName);
      cards.push(parsed.card);
      i = parsed.nextIndex;
      continue;
    }
    i++;
  }
  return cards;
}

interface CardReadResult {
  card: FlashcardProposal;
  nextIndex: number;
}

function readCard(
  lines: string[],
  startIndex: number,
  testName: string,
): CardReadResult {
  const frontLine = lines[startIndex];
  const question = frontLine.replace(/^##\s+Q:\s*/, "").trim();
  let sourceNote = "";
  const answerLines: string[] = [];
  let i = startIndex + 1;

  // Optional `**Source:** [[Note]]` line(s). The renderer only
  // emits one, so we look for the first match and stop.
  while (i < lines.length && !/^##\s/.test(lines[i])) {
    const line = lines[i];
    const sourceMatch = line.match(/^\*\*Source:\*\*\s*\[\[([^\]]+)\]\]/);
    if (sourceMatch) {
      sourceNote = `${sourceMatch[1]}.md`;
      i++;
      continue;
    }
    // A `> ` line (blockquote) starts the answer.
    if (line.startsWith("> ")) {
      answerLines.push(line.slice(2));
      i++;
      // Consume contiguous `> ` lines — the renderer may emit
      // multi-line answers in a single blockquote.
      while (i < lines.length && lines[i].startsWith("> ")) {
        answerLines.push(lines[i].slice(2));
        i++;
      }
      break;
    }
    // Blank or unrelated line — skip and keep scanning.
    i++;
  }

  return {
    card: {
      proposalId: mintId(),
      question,
      answer: answerLines.join("\n").trim(),
      sourceNote,
      testName,
      proposedAt: Date.now(),
    },
    nextIndex: i,
  };
}

/**
 * Walk a leading YAML frontmatter block. For each `key: value`
 * line, fire `onField`. Returns the new index — the first line
 * after the closing `---`. If no frontmatter is present, returns
 * the original index untouched.
 *
 * Tolerant: this is a one-line-key scanner, not a full YAML
 * parser. It only handles the `key: "value"` and `key: value`
 * shapes the save service emits. Anything else is ignored.
 */
function consumeFrontmatter(
  lines: string[],
  startIndex: number,
  onField: (key: string, value: string) => void,
): number {
  if (lines[startIndex]?.trim() !== "---") return startIndex;
  let i = startIndex + 1;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "---") return i + 1;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (match) {
      let value = match[2].trim();
      // Strip a single pair of surrounding quotes — the save
      // service writes double-quoted strings.
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      onField(match[1], value);
    }
    i++;
  }
  // Unterminated frontmatter — treat the rest as body.
  return startIndex;
}

/**
 * Convert arbitrary text into a vault-safe filename stem. The rules:
 *  - strip leading/trailing whitespace
 *  - replace any of `/\:*?"<>|` with `-`
 *  - collapse runs of `-` and spaces
 *  - fall back to "Untitled" if the result is empty
 */
export function sanitizeForFilename(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return cleaned || "Untitled";
}

/**
 * Light-touch escape: avoid clobbering Obsidian-flavoured markdown
 * the user is likely to paste into the answer. We only neutralize
 * the characters that would break the `## Q:` / `> ...` template.
 */
function escapeMarkdown(s: string): string {
  // Newlines in a single-line answer get rendered as soft breaks
  // by the markdown processor. We keep them as-is and rely on
  // the `> ...` quote to render the whole answer as a blockquote.
  return s.replace(/\r\n/g, "\n");
}
