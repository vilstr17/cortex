import { describe, it, expect, beforeEach } from "vitest";
import { createQuizTools, pendingQuizzes } from "../quizzes";

describe("createQuizTools", () => {
  beforeEach(() => {
    pendingQuizzes.length = 0;
  });

  it("proposes a valid quiz", async () => {
    const tools = createQuizTools();
    const result = await tools[0].execute(
      {
        test_name: "History",
        questions: [
          {
            prompt: "When did WW2 end?",
            options: ["1943", "1945", "1950"],
            correct_index: 1,
            explanation: "Germany surrendered in May and Japan in September 1945.",
          },
        ],
      },
      { plugin: null },
    );

    expect(result).toMatch(/Proposed 1-question quiz/);
    expect(pendingQuizzes).toHaveLength(1);
    expect(pendingQuizzes[0].testName).toBe("History");
    expect(pendingQuizzes[0].questions[0].correct_index).toBe(1);
  });

  it("returns an error for a question with too few options", async () => {
    const tools = createQuizTools();
    const result = await tools[0].execute(
      {
        questions: [
          {
            prompt: "Yes?",
            options: ["yes"],
            correct_index: 0,
          },
        ],
      },
      { plugin: null },
    );

    expect(result).toMatch(/must have at least 2 non-empty 'options'/);
    expect(pendingQuizzes).toHaveLength(0);
  });

  it("returns an error for an out-of-range correct_index", async () => {
    const tools = createQuizTools();
    const result = await tools[0].execute(
      {
        questions: [
          {
            prompt: "Pick one",
            options: ["a", "b"],
            correct_index: 5,
          },
        ],
      },
      { plugin: null },
    );

    expect(result).toMatch(/invalid 'correct_index'/);
    expect(pendingQuizzes).toHaveLength(0);
  });

  it("defaults test_name to General when missing", async () => {
    const tools = createQuizTools();
    await tools[0].execute(
      {
        questions: [
          { prompt: "Q", options: ["a", "b"], correct_index: 0 },
        ],
      },
      { plugin: null },
    );

    expect(pendingQuizzes[0].testName).toBe("General");
  });
});
