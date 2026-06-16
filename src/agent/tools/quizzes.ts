/**
 * Quiz tool.
 *
 * The model calls `propose_quiz` to draft an interactive multiple-choice
 * quiz for the user. The quiz is rendered as an interactive component in
 * the chat; answers are tracked in the UI and are not persisted to disk
 * unless the user explicitly saves them.
 */

import { Tool } from "../toolRegistry.js";

export interface QuizQuestion {
  type: "multiple_choice";
  /** The question text. */
  prompt: string;
  /** Answer options. Must contain at least two items. */
  options: string[];
  /** Zero-based index of the correct option. */
  correct_index: number;
  /** Optional explanation shown after the user answers. */
  explanation?: string;
}

export interface QuizProposal {
  /** Stable id, minted at proposal time. */
  proposalId: string;
  /** Name of the test / topic the quiz is for. */
  testName: string;
  /** Questions in the quiz. */
  questions: QuizQuestion[];
  /** UTC ms when the model proposed the quiz. */
  proposedAt: number;
}

/**
 * Captured quizzes from the current chat turn. The chat modal reads from
 * this array when rendering quiz UI.
 */
export const pendingQuizzes: QuizProposal[] = [];

function mintId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `quiz-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateQuestions(raw: unknown): { valid: boolean; error?: string; questions?: QuizQuestion[] } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { valid: false, error: "'questions' must be a non-empty array." };
  }
  const out: QuizQuestion[] = [];
  for (let i = 0; i < raw.length; i++) {
    const q = raw[i];
    if (!isPlainObject(q)) {
      return { valid: false, error: `Question ${i + 1} is not an object.` };
    }
    const prompt = typeof q.prompt === "string" ? q.prompt.trim() : "";
    if (!prompt) {
      return { valid: false, error: `Question ${i + 1} is missing a non-empty 'prompt'.` };
    }
    const options = Array.isArray(q.options)
      ? q.options.map((o) => (typeof o === "string" ? o : "")).filter((o) => o.length > 0)
      : [];
    if (options.length < 2) {
      return { valid: false, error: `Question ${i + 1} must have at least 2 non-empty 'options'.` };
    }
    const correctIndex = typeof q.correct_index === "number" ? Math.floor(q.correct_index) : NaN;
    if (Number.isNaN(correctIndex) || correctIndex < 0 || correctIndex >= options.length) {
      return {
        valid: false,
        error: `Question ${i + 1} has an invalid 'correct_index' (must be between 0 and ${options.length - 1}).`,
      };
    }
    const explanation = typeof q.explanation === "string" && q.explanation.trim().length > 0
      ? q.explanation.trim()
      : undefined;
    out.push({ type: "multiple_choice", prompt, options, correct_index: correctIndex, explanation });
  }
  return { valid: true, questions: out };
}

export function createQuizTools(): Tool[] {
  return [
    {
      name: "propose_quiz",
      description:
        "Propose an interactive multiple-choice quiz for the user. Use this when the user asks to be quizzed, tested, or challenged on a topic. Include a test_name (use 'General' if not tied to a specific test) and a non-empty list of questions. Each question needs a prompt, at least two options, and the zero-based correct_index. Keep questions grounded in notes you have read via search_notes or read_note. IMPORTANT: after calling this tool, do NOT reveal the questions, options, correct answers, or explanations in your final prose response — keep your reply to a short framing sentence.",
      parameters: {
        type: "OBJECT",
        description: "Propose an interactive quiz",
        properties: {
          test_name: {
            type: "STRING",
            description: "Name of the test or topic, e.g. 'Biology Final'. Use 'General' if not tied to a specific test.",
          },
          questions: {
            type: "ARRAY",
            description: "List of multiple-choice questions. Each question has a prompt, options, and the zero-based index of the correct option.",
            items: {
              type: "OBJECT",
              description: "A single multiple-choice question.",
              properties: {
                prompt: { type: "STRING", description: "The question text." },
                options: {
                  type: "ARRAY",
                  description: "Answer options.",
                  items: { type: "STRING", description: "One answer option." },
                },
                correct_index: {
                  type: "INTEGER",
                  description: "Zero-based index of the correct option in the options array.",
                },
                explanation: {
                  type: "STRING",
                  description: "Brief explanation shown after the user answers (optional).",
                },
              },
              required: ["prompt", "options", "correct_index"],
            },
          },
        },
        required: ["questions"],
      },
      async execute(args) {
        const testName =
          typeof args.test_name === "string" && args.test_name.trim().length > 0
            ? args.test_name.trim()
            : "General";
        const validation = validateQuestions(args.questions);
        if (!validation.valid || !validation.questions) {
          return `Error: ${validation.error}`;
        }

        const proposal: QuizProposal = {
          proposalId: mintId(),
          testName,
          questions: validation.questions,
          proposedAt: Date.now(),
        };
        pendingQuizzes.push(proposal);
        return `Proposed ${proposal.questions.length}-question quiz (id=${proposal.proposalId}). The user can take it in the chat UI.`;
      },
    },
  ];
}
