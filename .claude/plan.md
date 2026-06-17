# Chronote Chat UI & Tool-Calling Improvements — Implementation Plan

## Goal
Deliver the five improvements from the roadmap while keeping LFM 2.5 (local / OpenAI-compatible) a reliable baseline and remaining compatible with larger models.

1. Proper Markdown rendering in chat messages.
2. Chat history persistence across modal close / reload.
3. Interactive flashcard deck UI in chat.
4. Interactive quiz UI in chat.
5. More reliable and deterministic tool calling.

## High-level approach
- Keep changes inside the existing chat modal and AI adapter architecture.
- Introduce small, testable UI helper modules so `ChronoteChatModal.ts` does not become a monolith.
- Extend the tool registry with argument validation and a local-model JSON fallback, rather than replacing the native tool-calling path.
- Persist chat history in the existing plugin `data.json` (settings) with a safe upper bound.

## File changes

### Settings / migration
- `src/settingsTypes.ts`
  - Add `chatHistory: Array<{ role: "user" | "assistant"; text: string }>` to `ChronoteSettings`.
  - Set default to `[]` in `DEFAULT_SETTINGS`.
- `src/utils/settingsMigration.ts`
  - No new migration logic required; `DEFAULT_SETTINGS` fill handles older blobs. Add a test that confirms `chatHistory` is defaulted when missing.

### Chat modal (`src/modals/ChronoteChatModal.ts`)
- Import `MarkdownRenderer` and new UI helpers.
- On open, restore `this.chatHistory` from `this.plugin.settings.chatHistory` and replay it into the DOM (skip the welcome message if history is non-empty).
- After each user/assistant exchange, trim history to a cap (e.g. 100 messages), write it back to settings, and save.
- Add a small "Clear chat" affordance (header or near input) that resets local + persisted history.
- Delegate assistant message rendering to helpers:
  - `renderAssistantMessage(parent, text)` — uses `MarkdownRenderer.render`.
  - `renderFlashcardDeck(parent, proposals, onSave)`.
  - `renderQuizComponent(parent, quiz, onComplete?)`.
- Keep the schedule-approval block as-is (it is already an interactive component).

### Markdown rendering helper (`src/ui/chatMarkdown.ts`)
- Export `renderMarkdownText(app, text, container, sourcePath, component)` wrapping `MarkdownRenderer.render`.
- Provide a small sanitizer / normalizer for code blocks (preserve Obsidian-style internal links).

### Flashcard UI helper (`src/ui/FlashcardDeck.ts`)
- Accept `FlashcardProposal[]` and a save callback.
- Render one card at a time:
  - Front face = question.
  - Back face = answer + optional source note.
  - Click card or a "Flip" button toggles a CSS 3D flip.
  - Prev / Next buttons + "Card N / M" progress.
  - A "Save all" button per test group writes the whole group to the flashcard note.
- Use CSS classes scoped under `.chronote-chat-flashcard-deck`.

### Quiz tool + UI (`src/agent/tools/quizzes.ts`, `src/ui/QuizComponent.ts`)
- New tool `propose_quiz` with schema:
  - `test_name` (optional).
  - `questions`: array of `{ type: "multiple_choice", prompt, options: string[], correct_index: number, explanation?: string }`.
  - Tool validates shape and stores in a `pendingQuizzes` queue (same pattern as `pendingProposals`).
- Register the tool in `ChronoteChatModal`.
- `QuizComponent` renders one question at a time:
  - Option buttons, immediate correct/incorrect styling.
  - Explanation reveal after answering.
  - Score and progress indicator.
  - Final summary screen with score.

### Tool-calling reliability (`src/services/ai/*`, `src/agent/toolRegistry.ts`, `src/services/geminiService.ts`)
- Tighten the general system prompt in `GeminiService.buildGeneralSystemPrompt`:
  - Add explicit MUST rules and a one-line example chain for each tool class.
  - Instruct the model to call tools before answering, never to invent note content, and to report tool errors plainly.
- Argument validation in `ToolRegistry.execute`:
  - Add a `validateArgs(schema, args)` helper that checks required fields and basic JSON-Schema types.
  - Return a clear error string when validation fails so the model can self-correct on the next round.
- OpenAI-compatible adapter manual fallback:
  - If the provider returns no native `tool_calls` but the assistant text contains `<tool_call>{...}</tool_call>` markers or a fenced JSON object with `name`/`arguments`, parse it into normalized `ToolCall`s.
  - Only fall back when the text looks intentional; otherwise treat it as prose.
- `runWithTools` fallback improvement:
  - When the first tool-bearing request fails, still drop tools and retry once, but add a concise system note and surface a one-time Notice in the chat modal so the user knows the model is falling back to text-only.

### Styles (`styles.css`)
- Add `.chat-message-text-rendered` to override `white-space: pre-wrap` for rendered markdown.
- Add flashcard deck CSS: 3D flip, progress dots, navigation layout.
- Add quiz CSS: option buttons, feedback states, progress bar.

### Tests
- `vitest.setup.ts`: add a minimal `MarkdownRenderer` mock.
- `src/utils/__tests__/settingsMigration.test.ts`: add a `chatHistory` default test.
- `src/services/__tests__/geminiService.test.ts` or new `src/services/ai/__tests__/runWithTools.test.ts`: test argument validation and manual tool-call parsing.
- Add a small unit test for quiz tool validation (`pendingQuizzes` is not populated for malformed input).

### Build / QA
- Run `npm run typecheck` and `npm run test`.
- Update the build marker in `src/main.ts`.

## Order of work (phased for easy review)
1. Foundation: Markdown rendering + chat persistence (small, user-visible wins).
2. Interactive components: flashcard deck + quiz component + quiz tool.
3. Reliability: prompt hardening, argument validation, manual tool fallback.
4. Tests + typecheck + build marker.

## Success criteria
- Assistant chat messages render bold, headings, lists, code blocks, tables, and wikilinks via Obsidian's markdown engine.
- Closing and reopening the chat modal restores the previous conversation; reloading Obsidian does the same.
- Flashcards appear as an interactive deck with flip + prev/next + progress + save.
- Quizzes appear as an interactive component with MCQ, feedback, score, and progress.
- Tool calls are validated, malformed args return errors to the model, and local models that emit JSON tool calls are handled gracefully.
- All of the above remains compatible with Gemini / Anthropic / OpenAI / local OpenAI-compatible providers.
