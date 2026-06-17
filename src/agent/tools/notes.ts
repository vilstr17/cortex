/**
 * Note tools: search_notes, read_note, list_notes.
 *
 * These three tools expose the user's vault to the LLM. The LLM is
 * instructed (in the system prompt) to use search_notes first to
 * find relevant chunks, then read_note to pull the full text of any
 * specific note it wants to quote or summarize.
 *
 * The tools are constructed by a factory that takes the live
 * dependencies (vault, knowledge base) at registration time. The
 * `KnowledgeBase` interface is the only seam between the tool and
 * the rest of the plugin — main.ts builds the real one (vector
 * index + embedding provider) and passes it in.
 */

import { App, TFile } from "obsidian";
import { Tool } from "../toolRegistry.js";
import { NoteChunk } from "../vectorIndex/chunker.js";
import { SearchHit, VectorIndex } from "../vectorIndex/index.js";
import { EmbeddingProvider } from "../vectorIndex/embeddings.js";

/**
 * The minimum surface a tool needs to search the vault. Defined
 * here so the tools file doesn't have to import the concrete
 * `InMemoryCosineIndex` (which would make testing harder and
 * tightly couple the agent layer to the storage layer).
 */
export interface KnowledgeBase {
  /** Lazy embedding provider. Throws on unrecoverable failure. */
  embedder: EmbeddingProvider;
  /** The index. May be empty (size === 0) before the first reindex. */
  index: VectorIndex;
  /**
   * True if the index is populated and ready to search. Tools
   * return a friendly error when false so the model can ask the
   * user to trigger a reindex.
   */
  isReady(): boolean;
}

export function createNoteTools(deps: {
  app: App;
  knowledge: KnowledgeBase;
}): Tool[] {
  const { app, knowledge } = deps;

  return [
    {
      name: "search_notes",
      description:
        "Semantic search across the user's Obsidian vault. Returns up to `k` ranked chunks of note text that are most relevant to the query. Use this whenever the user asks about their notes, study material, or a topic that might be in their vault. Never invent note contents — if the search returns no results, say so plainly. Always cite the source note (file basename) when you quote or summarize.",
      parameters: {
        type: "OBJECT",
        description: "Semantic search over the vault",
        properties: {
          query: {
            type: "STRING",
            description:
              "Natural-language question or topic to search for. Examples: 'Calvin cycle steps', 'derivatives of inverse trig functions', 'Czech Republic history'.",
          },
          k: {
            type: "INTEGER",
            description:
              "How many chunks to return. Default 8, max 20. Smaller k is more focused; larger k is broader.",
          },
        },
        required: ["query"],
      },
      async execute(args) {
        if (!knowledge.isReady()) {
          return (
            "The vault knowledge index is empty. Ask the user to open " +
            "Chronote settings and click 'Reindex vault' to build it."
          );
        }
        const query = typeof args.query === "string" ? args.query : "";
        if (!query.trim()) {
          return "Error: 'query' is required and must be a non-empty string.";
        }
        const k = clampK(args.k);
        let queryVec: Float32Array;
        try {
          const [vec] = await knowledge.embedder.embed([query]);
          queryVec = vec;
        } catch (err) {
          return `Error: failed to embed the search query: ${describeError(err)}`;
        }
        if (queryVec.length !== knowledge.index.dim) {
          return (
            `Error: embedding dimension mismatch. The active embedding model returns ${queryVec.length}-dimensional vectors, ` +
            `but the knowledge index was built with ${knowledge.index.dim}-dimensional vectors. ` +
            `Open Chronote settings and click 'Reindex vault' to rebuild the index for the current model.`
          );
        }
        const hits: SearchHit[] = filterByRelevance(
          knowledge.index.search(queryVec, k),
        );
        if (hits.length === 0) {
          return `No sufficiently relevant notes found for: "${query}". Try rephrasing, or use list_notes to see what notes exist. Do not guess — tell the user nothing relevant was found.`;
        }
        return formatHits(hits);
      },
    },

    {
      name: "read_note",
      description:
        "Read the full contents (or a single section) of a note by its file path. Use this when the user asks for a specific note, or after search_notes has identified a relevant note that you want to summarize in full. Pass the file path as it appears in the vault, including the .md extension. Very long notes are still truncated at a generous cap; if that happens, call again with a `heading` argument to fetch just that section.",
      parameters: {
        type: "OBJECT",
        description: "Read a note by path, optionally scoped to a heading",
        properties: {
          path: {
            type: "STRING",
            description:
              "Vault-relative file path, e.g. 'Calculus - Limits.md' or 'notes/cell biology.md'.",
          },
          heading: {
            type: "STRING",
            description:
              "Optional. If set, return only the section under this heading (e.g. '## The Calvin Cycle' → 'The Calvin Cycle'). Case-sensitive exact match.",
          },
        },
        required: ["path"],
      },
      async execute(args) {
        const path = typeof args.path === "string" ? args.path : "";
        const heading = typeof args.heading === "string" ? args.heading : "";
        if (!path) return "Error: 'path' is required.";

        const file = app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) {
          // Helpful hint if the model forgot the extension.
          const hint =
            path.endsWith(".md") || path.includes("/")
              ? ""
              : ` (did you forget the .md extension?)`;
          return `Error: file not found: ${path}${hint}`;
        }

        let text: string;
        try {
          text = await app.vault.cachedRead(file);
        } catch (err) {
          return `Error: failed to read ${path}: ${describeError(err)}`;
        }

        // Optional heading filter: extract just that section.
        if (heading) {
          const section = extractSection(text, heading);
          if (section === null) {
            return `Error: no section with heading "${heading}" found in ${path}. Read the full note to see all headings.`;
          }
          text = section;
        }

        // Modern hosted models (Kimi, Gemini, Claude, GPT-4 class) have
        // context windows in the hundreds of thousands of tokens, so we
        // return a large note in one shot rather than forcing the model to
        // burn tool-call rounds reading it section by section. The heading
        // argument is still available for genuinely huge files.
        const MAX_CHARS = 100_000;
        const truncated = text.length > MAX_CHARS;
        const body = truncated ? text.slice(0, MAX_CHARS) : text;
        const footer = truncated
          ? `\n\n[... truncated at ${MAX_CHARS.toLocaleString()} chars. Call read_note again with a 'heading' argument to fetch a specific section.]`
          : "";
        return `Contents of ${path}:\n\n${body}${footer}`;
      },
    },

    {
      name: "list_notes",
      description:
        "Enumerate notes in the vault, optionally filtered by folder path or frontmatter tag. Returns up to 50 results. Use this when the user asks 'what notes do I have about X?' or when search_notes returns nothing and you need to know what exists.",
      parameters: {
        type: "OBJECT",
        description: "List notes in the vault",
        properties: {
          folder: {
            type: "STRING",
            description:
              "Optional folder prefix, e.g. 'notes/' or 'daily/'. Matches files whose path starts with this string. Use '' for the vault root.",
          },
          tag: {
            type: "STRING",
            description:
              "Optional frontmatter tag, including the leading '#', e.g. '#biology'. Matches the `tags` field in the note's frontmatter.",
          },
        },
        required: [],
      },
      async execute(args) {
        const folder = typeof args.folder === "string" ? args.folder : "";
        const tag = typeof args.tag === "string" ? args.tag : "";
        const files = app.vault.getMarkdownFiles();
        const tagFilter = tag.startsWith("#") ? tag.slice(1) : tag;

        const matches: Array<{ path: string; title: string }> = [];
        for (const file of files) {
          if (folder && !file.path.startsWith(folder)) continue;
          if (tagFilter) {
            const cache = app.metadataCache.getFileCache(file);
            const tags: unknown = cache?.frontmatter?.tags;
            const tagList = Array.isArray(tags)
              ? tags.map(String)
              : typeof tags === "string"
                ? tags.split(/,\s*/)
                : [];
            if (!tagList.includes(tagFilter)) continue;
          }
          matches.push({ path: file.path, title: file.basename });
          if (matches.length >= 50) break;
        }

        if (matches.length === 0) {
          return `No notes found${folder ? ` under "${folder}"` : ""}${
            tagFilter ? ` tagged ${tag}` : ""
          }.`;
        }
        const list = matches.map((m) => `- ${m.title} (${m.path})`).join("\n");
        return `Found ${matches.length} note(s):\n${list}`;
      },
    },
  ];
}

// ── Helpers ────────────────────────────────────────────────────────

/** Coerce a `k` argument into the allowed [1, 20] range with a default of 8. */
function clampK(raw: unknown): number {
  const n = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : 8;
  return Math.max(1, Math.min(20, n));
}

/**
 * Drop hits that sit far below the best match.
 *
 * `search()` returns the top-k by cosine similarity with no quality
 * gate, so a query with only one or two on-topic chunks gets its
 * remaining slots filled with loosely-related filler — which a small
 * chat model happily blends into a confidently-wrong answer (e.g.
 * folding "Hayek's economic cycles" into a question about Karel
 * Čapek). Empirically, nomic-embed-text scores on-topic chunks ~0.7
 * and off-topic ~0.5, so we keep only the cluster near the top:
 *   - within REL_MARGIN of the best score, and
 *   - above an absolute floor (guards the "nothing relevant" case).
 * Hits arrive in descending score order, so hits[0] is the best.
 */
const REL_MARGIN = 0.15;
const ABS_FLOOR = 0.4;
function filterByRelevance(hits: SearchHit[]): SearchHit[] {
  if (hits.length === 0) return hits;
  const top = hits[0].score;
  const cutoff = Math.max(ABS_FLOOR, top - REL_MARGIN);
  return hits.filter((h) => h.score >= cutoff);
}

/** Format a list of search hits into a compact, citation-friendly string. */
function formatHits(hits: SearchHit[]): string {
  const blocks = hits.map((hit, i) => {
    const { chunk, score } = hit;
    const snippet = chunk.text.length > 240 ? chunk.text.slice(0, 240) + "…" : chunk.text;
    const heading = chunk.heading ? ` / ${chunk.heading}` : "";
    return `[${i + 1}] ${chunk.file}${heading} (score=${score.toFixed(3)}, lines ${chunk.startLine}-${chunk.endLine})\n${snippet}`;
  });
  return `Found ${hits.length} matching chunk(s):\n\n${blocks.join("\n\n")}`;
}

/** Extract a section by heading text. Returns null if not found. */
function extractSection(markdown: string, heading: string): string | null {
  const lines = markdown.split("\n");
  // Find the first line whose stripped text equals the heading (after `#`s).
  const headingRe = /^#{1,6}\s+(.*?)\s*#*\s*$/;
  let startIdx = -1;
  let startLevel = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(headingRe);
    if (m && m[1].trim() === heading.trim()) {
      startIdx = i;
      // Infer the heading level by counting the leading #s on the line
      // (the regex already stripped them, so count from the original).
      const leading = lines[i].match(/^#+/);
      startLevel = leading ? leading[0].length : 1;
      break;
    }
  }
  if (startIdx === -1) return null;

  // Find the end: the next line whose heading is at the same or higher
  // (smaller number of #s) level, or end of file.
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const m = lines[i].match(headingRe);
    if (m) {
      const leading = lines[i].match(/^#+/);
      const level = leading ? leading[0].length : 1;
      if (level <= startLevel) {
        endIdx = i;
        break;
      }
    }
  }
  return lines.slice(startIdx, endIdx).join("\n");
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Re-export the chunk type so consumers don't have to reach into the chunker. */
export type { NoteChunk };
