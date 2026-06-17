import { describe, it, expect, vi, beforeEach } from "vitest";
import type { App } from "obsidian";
import { ChronoteChatModal } from "../ChronoteChatModal.js";
import { pendingProposals } from "../../agent/tools/flashcards.js";
import { pendingQuizzes } from "../../agent/tools/quizzes.js";
import { DEFAULT_SETTINGS, ChronoteSettings } from "../../settingsTypes.js";
import type ChronotePlugin from "../../main.js";

const { mockChat, mockRenderMarkdown, mockRenderDeck, mockRenderQuiz } = vi.hoisted(() => ({
  mockChat: vi.fn(),
  mockRenderMarkdown: vi.fn(),
  mockRenderDeck: vi.fn(),
  mockRenderQuiz: vi.fn(),
}));

vi.mock("../../services/geminiService", () => ({
  GeminiService: class {
    registerTool() {
      // no-op mock
    }
    chat = mockChat;
  },
}));

vi.mock("../../ui/chatMarkdown", () => ({
  renderChatMarkdown: mockRenderMarkdown,
}));

vi.mock("../../ui/FlashcardDeck", () => ({
  renderFlashcardDeck: mockRenderDeck,
}));

vi.mock("../../ui/QuizComponent", () => ({
  renderQuizComponent: mockRenderQuiz,
}));

function fakePlugin(): ChronotePlugin {
  return {
    settings: {
      ...DEFAULT_SETTINGS,
      chatHistory: [],
      ai: {
        ...DEFAULT_SETTINGS.ai,
        provider: "gemini",
        geminiApiKey: "test-key",
        geminiModel: "gemini-2.5-flash",
      },
    } as ChronoteSettings,
    saveData: vi.fn(),
    getCalendarService: () => ({
      getEventsForDay: vi.fn().mockResolvedValue([]),
      createEvent: vi.fn().mockResolvedValue(true),
    }),
    getKnowledgeBase: () => ({
      isReady: () => true,
      chunkCount: 5,
    }),
  } as unknown as ChronotePlugin;
}

describe("ChronoteChatModal — flashcard/quiz proposal capture", () => {
  beforeEach(() => {
    pendingProposals.length = 0;
    pendingQuizzes.length = 0;
    mockChat.mockReset();
    mockRenderMarkdown.mockReset();
    mockRenderDeck.mockReset();
    mockRenderQuiz.mockReset();
  });

  it("captures flashcards proposed during the chat turn", async () => {
    const app = {
      workspace: { getActiveFile: () => null },
      vault: { getMarkdownFiles: () => [], getAbstractFileByPath: () => null },
      metadataCache: { getFileCache: () => null },
    } as unknown as App;
    const plugin = fakePlugin();
    const modal = new ChronoteChatModal(app, plugin);
    await modal.onOpen();

    mockChat.mockImplementation(async () => {
      pendingProposals.push({
        proposalId: "fc-1",
        question: "What is 2+2?",
        answer: "4",
        sourceNote: "Math.md",
        testName: "General",
        proposedAt: Date.now(),
      });
      return "Here are your flashcards.";
    });

    (modal as unknown as { inputEl: { value: string } }).inputEl.value = "make a flashcard";
    await (modal as unknown as { sendMessage: () => Promise<void> }).sendMessage();

    expect(mockRenderDeck).toHaveBeenCalledTimes(1);
    const [, group] = mockRenderDeck.mock.calls[0];
    expect(group).toHaveLength(1);
    expect(group[0].question).toBe("What is 2+2?");
  });

  it("captures quizzes proposed during the chat turn", async () => {
    const app = {
      workspace: { getActiveFile: () => null },
      vault: { getMarkdownFiles: () => [], getAbstractFileByPath: () => null },
      metadataCache: { getFileCache: () => null },
    } as unknown as App;
    const plugin = fakePlugin();
    const modal = new ChronoteChatModal(app, plugin);
    await modal.onOpen();

    mockChat.mockImplementation(async () => {
      pendingQuizzes.push({
        proposalId: "quiz-1",
        testName: "General",
        questions: [
          {
            type: "multiple_choice",
            prompt: "What is 2+2?",
            options: ["3", "4", "5"],
            correct_index: 1,
          },
        ],
        proposedAt: Date.now(),
      });
      return "Here is your quiz.";
    });

    (modal as unknown as { inputEl: { value: string } }).inputEl.value = "quiz me";
    await (modal as unknown as { sendMessage: () => Promise<void> }).sendMessage();

    expect(mockRenderQuiz).toHaveBeenCalledTimes(1);
    const [, quiz] = mockRenderQuiz.mock.calls[0];
    expect(quiz.questions).toHaveLength(1);
    expect(quiz.questions[0].prompt).toBe("What is 2+2?");
  });

  it("persists flashcards and quizzes with the assistant turn", async () => {
    const app = {
      workspace: { getActiveFile: () => null },
      vault: { getMarkdownFiles: () => [], getAbstractFileByPath: () => null },
      metadataCache: { getFileCache: () => null },
    } as unknown as App;
    const plugin = fakePlugin();
    const modal = new ChronoteChatModal(app, plugin);
    await modal.onOpen();

    mockChat.mockImplementation(async () => {
      pendingProposals.push({
        proposalId: "fc-1",
        question: "What is 2+2?",
        answer: "4",
        sourceNote: "Math.md",
        testName: "General",
        proposedAt: Date.now(),
      });
      pendingQuizzes.push({
        proposalId: "quiz-1",
        testName: "General",
        questions: [
          { type: "multiple_choice", prompt: "What is 2+2?", options: ["3", "4", "5"], correct_index: 1 },
        ],
        proposedAt: Date.now(),
      });
      return "Here is a deck and a quiz.";
    });

    (modal as unknown as { inputEl: { value: string } }).inputEl.value = "review";
    await (modal as unknown as { sendMessage: () => Promise<void> }).sendMessage();

    const lastTurn = plugin.settings.chatHistory[plugin.settings.chatHistory.length - 1];
    expect(lastTurn.role).toBe("assistant");
    expect(lastTurn.attachments?.flashcards).toHaveLength(1);
    expect(lastTurn.attachments?.quizzes).toHaveLength(1);
  });

  it("restores flashcard decks from persisted chat history", async () => {
    const app = {
      workspace: { getActiveFile: () => null },
      vault: { getMarkdownFiles: () => [], getAbstractFileByPath: () => null },
      metadataCache: { getFileCache: () => null },
    } as unknown as App;
    const plugin = fakePlugin();
    plugin.settings.chatHistory = [
      {
        role: "assistant",
        text: "Here is a deck.",
        attachments: {
          flashcards: [
            {
              proposalId: "fc-2",
              question: "Capital of France?",
              answer: "Paris",
              sourceNote: "Geography.md",
              testName: "General",
              proposedAt: Date.now(),
            },
          ],
        },
      },
    ];
    const modal = new ChronoteChatModal(app, plugin);
    await modal.onOpen();

    expect(mockRenderDeck).toHaveBeenCalledTimes(1);
    const [, group] = mockRenderDeck.mock.calls[0];
    expect(group[0].question).toBe("Capital of France?");
  });

  it("restores quizzes from persisted chat history", async () => {
    const app = {
      workspace: { getActiveFile: () => null },
      vault: { getMarkdownFiles: () => [], getAbstractFileByPath: () => null },
      metadataCache: { getFileCache: () => null },
    } as unknown as App;
    const plugin = fakePlugin();
    plugin.settings.chatHistory = [
      {
        role: "assistant",
        text: "Try this quiz.",
        attachments: {
          quizzes: [
            {
              proposalId: "quiz-2",
              testName: "General",
              questions: [
                { type: "multiple_choice", prompt: "2+2?", options: ["3", "4"], correct_index: 1 },
              ],
              proposedAt: Date.now(),
            },
          ],
        },
      },
    ];
    const modal = new ChronoteChatModal(app, plugin);
    await modal.onOpen();

    expect(mockRenderQuiz).toHaveBeenCalledTimes(1);
    const [, quiz] = mockRenderQuiz.mock.calls[0];
    expect(quiz.questions[0].prompt).toBe("2+2?");
  });
});
