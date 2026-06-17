/**
 * Markdown chunker for the Chronote AI knowledge index.
 *
 * The vector index needs pieces of notes that are small enough to
 * embed (a typical local model tops out at ~500 tokens of useful
 * context) and self-contained enough that a retrieved chunk makes
 * sense without its neighbours. The natural unit is a section:
 * everything between two headings. We fall back to a sliding window
 * for notes that have no headings at all (e.g. journal entries,
 * daily logs), and we always skip YAML frontmatter.
 *
 * Why header-based over a fixed token size:
 *  - Headers are intentional boundaries in the author's mind.
 *  - A note that uses `##` heavily is signalling "many small topics";
 *    we should respect that rather than over-chunking.
 *  - Sliding windows lose the heading, which makes results confusing
 *    in the chat UI.
 *
 * For notes that exceed the cap even within a section, we split
 * further on blank lines (paragraphs). If a single paragraph is
 * longer than the cap, we hard-split on a word boundary — that case
 * is rare for personal notes.
 */

/** A piece of a note, ready to be embedded. */
export interface NoteChunk {
  /** Source file path (forward-slash, relative to vault root). */
  file: string;
  /** Heading text the chunk lives under, or "" for top-level. */
  heading: string;
  /** 0-based line number where the chunk starts in the original file. */
  startLine: number;
  /** 1-based line number where the chunk ends (inclusive). */
  endLine: number;
  /** Chunk text — markdown source, no frontmatter. */
  text: string;
}

export interface ChunkerOptions {
  /** Soft target for chunk size in characters. Default 1500. */
  maxChars: number;
  /** Minimum chunk size — anything smaller is appended to the previous. */
  minChars: number;
}

/**
 * Chunk a single markdown file's content. The `file` argument is only
 * used to populate `NoteChunk.file`; pass the vault-relative path so
 * the index can answer "where did this come from?" for citations.
 */
export function chunkMarkdown(
  file: string,
  markdown: string,
  options: Partial<ChunkerOptions> = {},
): NoteChunk[] {
  const maxChars = options.maxChars ?? 1500;
  const minChars = options.minChars ?? 80;

  // Strip frontmatter so the index never embeds a wall of YAML keys.
  const { body, lineOffset } = stripFrontmatter(markdown);

  const lines = body.split("\n");
  const sections = splitByHeadings(lines);

  const chunks: NoteChunk[] = [];
  for (const section of sections) {
    const sectionChunks = packSection(
      file,
      section.heading,
      section.lines,
      section.startLine + lineOffset,
      maxChars,
      minChars,
    );
    chunks.push(...sectionChunks);
  }

  return chunks;
}

// ── Internals ──────────────────────────────────────────────────────

interface RawSection {
  heading: string;
  lines: string[];
  /** 0-based line number in the *body* (post-frontmatter). */
  startLine: number;
}

/**
 * Strip leading `--- … ---` frontmatter. Returns the body and the
 * number of lines removed from the top, so chunk line numbers can be
 * re-based to the original file.
 */
function stripFrontmatter(markdown: string): { body: string; lineOffset: number } {
  // Be liberal: only strip if the very first line is `---` AND there's
  // a closing `---` somewhere later. This avoids eating `---` from a
  // horizontal rule in a note that doesn't have frontmatter.
  const lines = markdown.split("\n");
  if (lines.length === 0 || lines[0].trim() !== "---") {
    return { body: markdown, lineOffset: 0 };
  }
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      return {
        body: lines.slice(i + 1).join("\n"),
        lineOffset: i + 1,
      };
    }
  }
  // Unterminated frontmatter — treat as no frontmatter rather than
  // eating the whole file.
  return { body: markdown, lineOffset: 0 };
}

const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

/**
 * Split the body into sections by ATX headings (`#`, `##`, …). The
 * first section is whatever appears before the first heading (often
 * an intro paragraph or just whitespace).
 */
function splitByHeadings(lines: string[]): RawSection[] {
  const sections: RawSection[] = [];
  let current: RawSection = { heading: "", lines: [], startLine: 0 };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(HEADING_RE);
    if (match) {
      // Close the previous section if it has any content.
      if (current.lines.length > 0 || current.heading) {
        sections.push(current);
      }
      current = {
        heading: match[2].trim(),
        lines: [line],
        startLine: i,
      };
    } else {
      current.lines.push(line);
    }
  }
  if (current.lines.length > 0 || current.heading) {
    sections.push(current);
  }
  return sections;
}

/**
 * Pack a single section's lines into chunks of `maxChars` characters
 * or fewer, splitting on blank-line boundaries (paragraphs) and
 * appending small trailing bits to the previous chunk.
 */
function packSection(
  file: string,
  heading: string,
  lines: string[],
  startLine: number,
  maxChars: number,
  minChars: number,
): NoteChunk[] {
  // Pre-join paragraphs (groups of lines separated by blank lines).
  const paragraphs: Array<{ text: string; line: number }> = [];
  let buffer: string[] = [];
  let bufferStart = startLine;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") {
      if (buffer.length > 0) {
        paragraphs.push({ text: buffer.join("\n"), line: bufferStart });
        buffer = [];
      }
    } else {
      if (buffer.length === 0) bufferStart = startLine + i;
      buffer.push(line);
    }
  }
  if (buffer.length > 0) {
    paragraphs.push({ text: buffer.join("\n"), line: bufferStart });
  }

  const chunks: NoteChunk[] = [];
  let currentText = "";
  let currentStart = paragraphs[0]?.line ?? startLine;

  const flush = (endLine: number) => {
    if (currentText.length === 0) return;
    chunks.push({
      file,
      heading,
      startLine: currentStart,
      endLine,
      text: currentText,
    });
    currentText = "";
  };

  for (const para of paragraphs) {
    const paraLen = para.text.length;

    // If this paragraph on its own is bigger than the cap, it
    // needs hard-splitting regardless of whether we have a current
    // buffer. This is the rare case (single huge paragraph in an
    // unheadered note), but the test suite covers it because it's
    // the path most likely to regress.
    if (paraLen > maxChars) {
      if (currentText.length > 0) {
        flush(para.line - 1);
      }
      const hardSplits = hardSplit(para.text, maxChars);
      for (let i = 0; i < hardSplits.length; i++) {
        const split = hardSplits[i];
        const isLast = i === hardSplits.length - 1;
        if (split.length >= minChars || isLast) {
          chunks.push({
            file,
            heading,
            startLine: para.line,
            endLine: para.line, // approximate; the whole para is one logical line range
            text: split,
          });
        }
      }
      currentStart = para.line + 1;
      currentText = "";
      continue;
    }

    // If adding this paragraph would overflow, flush first.
    if (currentText.length > 0 && currentText.length + 1 + paraLen > maxChars) {
      flush(para.line - 1);
      currentStart = para.line;
    }

    if (currentText.length === 0) {
      currentStart = para.line;
    } else {
      currentText += "\n";
    }
    currentText += para.text;
  }

  // Final flush.
  const lastPara = paragraphs[paragraphs.length - 1];
  flush(lastPara ? lastPara.line : startLine + lines.length - 1);

  return chunks;
}

/**
 * Split an oversized paragraph on word boundaries. The cut never
 * lands inside a word; we back off to the previous space.
 */
function hardSplit(text: string, maxChars: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf(" ", maxChars);
    if (cut <= 0) cut = maxChars; // pathological: a single huge word
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0) out.push(rest);
  return out;
}
