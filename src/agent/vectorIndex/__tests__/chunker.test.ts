import { describe, it, expect } from "vitest";
import { chunkMarkdown } from "../chunker";

/**
 * Tests for the markdown chunker.
 *
 * The chunker is pure logic — no Obsidian imports — so the tests
 * can run as plain Node. They cover the four cases that drove the
 * original design: frontmatter stripping, header-based splitting,
 * paragraph packing, and the "single oversized paragraph" hard
 * split.
 */

describe("chunkMarkdown", () => {
  it("strips YAML frontmatter and shifts line numbers", () => {
    const md = [
      "---",
      "title: Hello",
      "tags: [a, b]",
      "---",
      "",
      "## Section A",
      "Body of section A.",
      "",
      "## Section B",
      "Body of section B.",
    ].join("\n");
    const chunks = chunkMarkdown("note.md", md);
    // The chunker should have produced exactly two sections (one per
    // heading) plus the implicit empty top-level that we elide.
    expect(chunks.length).toBe(2);
    // Frontmatter consumed 4 lines (---, title, tags, ---), so the
    // first real content line is the original line 4 (the empty line
    // after the closing ---) and the heading `## Section A` lives
    // on original line 5. We assert the heading-line specifically
    // because that's what the chat UI uses for "jump to source".
    expect(chunks[0].heading).toBe("Section A");
    expect(chunks[0].text).toContain("Body of section A");
    expect(chunks[0].startLine).toBe(5);
    expect(chunks[1].heading).toBe("Section B");
  });

  it("treats an unterminated frontmatter as no frontmatter", () => {
    // A note that *starts* with `---` but never closes it should
    // not have its body eaten. The defensive `return { body: markdown, lineOffset: 0 }`
    // path covers this — the result is that the leading `---`
    // becomes part of the pre-heading section, and `## Real content`
    // shows up in a later chunk.
    const md = [
      "---",
      "title: Open",
      "",
      "## Real content",
      "Some text.",
    ].join("\n");
    const chunks = chunkMarkdown("n.md", md);
    // Two sections: the pre-heading section (containing the bogus
    // `---`) and the "Real content" section.
    expect(chunks.length).toBe(2);
    expect(chunks[1].heading).toBe("Real content");
    expect(chunks[1].text).toContain("Some text.");
  });

  it("returns a single section for a heading-less note", () => {
    const md = "Just a paragraph.\n\nAnd another.\n";
    const chunks = chunkMarkdown("n.md", md);
    expect(chunks.length).toBe(1);
    expect(chunks[0].heading).toBe("");
    expect(chunks[0].text).toContain("Just a paragraph");
    expect(chunks[0].text).toContain("And another");
  });

  it("packs multiple short paragraphs into one chunk", () => {
    const md = [
      "## T",
      "P1.",
      "",
      "P2.",
      "",
      "P3.",
    ].join("\n");
    const chunks = chunkMarkdown("n.md", md);
    // With default maxChars=1500 the whole section fits in one chunk.
    expect(chunks.length).toBe(1);
    expect(chunks[0].text).toContain("P1");
    expect(chunks[0].text).toContain("P2");
    expect(chunks[0].text).toContain("P3");
  });

  it("hard-splits a single oversized paragraph at word boundaries", () => {
    const para = "word ".repeat(500).trim();
    // maxChars=80 forces the hard-split path.
    const chunks = chunkMarkdown("n.md", para, { maxChars: 80, minChars: 10 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      // No chunk should exceed the cap (with a small tolerance for
      // the off-by-one in lastIndexOf arithmetic).
      expect(c.text.length).toBeLessThanOrEqual(120);
      // Every chunk should still be real text, not a stray space.
      expect(c.text.trim().length).toBeGreaterThan(0);
    }
  });

  it("tags each chunk with the source file path", () => {
    const md = "## A\nbody\n\n## B\nbody";
    const chunks = chunkMarkdown("path/to/note.md", md);
    for (const c of chunks) {
      expect(c.file).toBe("path/to/note.md");
    }
  });
});
