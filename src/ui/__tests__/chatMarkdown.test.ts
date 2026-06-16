/**
 * Tests for `src/ui/chatMarkdown.ts`.
 *
 * `wireLinkClicks` is a 3-line DOM walker — not worth a test on its own
 * (and would need jsdom, which isn't installed). The behaviour we care
 * about is `resolveLinkClick`, which encodes:
 *   - which `data-href` / `textContent` / `href` we extract, and
 *   - the newLeaf decision (Ctrl/Cmd-click).
 *
 * External hrefs must return `null` so the browser handles them.
 */

import { describe, it, expect } from "vitest";
import { resolveLinkClick } from "../chatMarkdown.js";

/** Tiny stand-in for an `<a>` element with just what resolveLinkClick reads. */
function anchor(opts: {
  href?: string;
  dataHref?: string;
  text?: string;
}): Pick<HTMLAnchorElement, "getAttribute" | "textContent"> {
  return {
    getAttribute(name: string): string | null {
      if (name === "href") return opts.href ?? null;
      if (name === "data-href") return opts.dataHref ?? null;
      return null;
    },
    textContent: opts.text ?? "",
  };
}

/** Minimal MouseEvent stand-in. */
function ev(modifier: "none" | "ctrl" | "meta"): Pick<MouseEvent, "ctrlKey" | "metaKey"> {
  return { ctrlKey: modifier === "ctrl", metaKey: modifier === "meta" };
}

describe("resolveLinkClick", () => {
  it("returns null for external http(s) hrefs", () => {
    expect(
      resolveLinkClick(
        anchor({ href: "https://example.com", dataHref: "X", text: "X" }),
        ev("none"),
      ),
    ).toBeNull();
    expect(
      resolveLinkClick(
        anchor({ href: "http://example.com" }),
        ev("none"),
      ),
    ).toBeNull();
  });

  it("returns null for file:// and mailto: hrefs", () => {
    expect(
      resolveLinkClick(anchor({ href: "file:///Users/me/note.md" }), ev("none")),
    ).toBeNull();
    expect(
      resolveLinkClick(anchor({ href: "mailto:a@b.com" }), ev("none")),
    ).toBeNull();
  });

  it("prefers data-href over textContent and href", () => {
    // The Obsidian renderer puts the resolved [[Note#Heading|Alias]] in
    // data-href, the alias in textContent, and a file:// path in href.
    // We want data-href so headings and aliases both resolve.
    const r = resolveLinkClick(
      anchor({
        href: "app://obsidian.md/note.md",
        dataHref: "Note#Heading",
        text: "Heading",
      }),
      ev("none"),
    );
    expect(r).toEqual({ linktext: "Note#Heading", newLeaf: false });
  });

  it("falls back to textContent when data-href is missing", () => {
    const r = resolveLinkClick(
      anchor({ href: "app://obsidian.md/Note.md", text: "Note" }),
      ev("none"),
    );
    expect(r).toEqual({ linktext: "Note", newLeaf: false });
  });

  it("uses textContent over href when both are present", () => {
    // With no data-href, textContent wins (this is the alias path).
    const r = resolveLinkClick(
      anchor({ href: "app://obsidian.md/Note.md", text: "Note" }),
      ev("none"),
    );
    expect(r).toEqual({ linktext: "Note", newLeaf: false });
  });

  it("returns null when no usable linktext can be derived", () => {
    // Empty href, no data-href, empty text — nothing to open.
    const r = resolveLinkClick(anchor({ text: "" }), ev("none"));
    expect(r).toBeNull();
  });

  it("sets newLeaf true on Ctrl-click", () => {
    const r = resolveLinkClick(
      anchor({ dataHref: "Note", text: "Note" }),
      ev("ctrl"),
    );
    expect(r).toEqual({ linktext: "Note", newLeaf: true });
  });

  it("sets newLeaf true on Cmd-click (macOS modifier)", () => {
    const r = resolveLinkClick(
      anchor({ dataHref: "Note", text: "Note" }),
      ev("meta"),
    );
    expect(r).toEqual({ linktext: "Note", newLeaf: true });
  });

  it("sets newLeaf false when no modifier is pressed", () => {
    const r = resolveLinkClick(
      anchor({ dataHref: "Note", text: "Note" }),
      ev("none"),
    );
    expect(r).toEqual({ linktext: "Note", newLeaf: false });
  });
});
