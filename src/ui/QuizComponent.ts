/**
 * Interactive quiz renderer for the Chronote chat UI.
 *
 * Renders a multiple-choice quiz one question at a time, with immediate
 * feedback, explanations, score tracking, and a final summary.
 */

import { QuizProposal } from "../agent/tools/quizzes.js";

export function renderQuizComponent(
  parent: HTMLElement,
  quiz: QuizProposal,
  _options?: { onComplete?: () => void },
): void {
  if (quiz.questions.length === 0) return;

  const container = parent.createDiv({ cls: "chronote-quiz" });

  const header = container.createDiv({ cls: "chronote-quiz-header" });
  header.createDiv({ cls: "chronote-quiz-title", text: `Quiz — ${quiz.testName}` });
  const scoreEl = header.createDiv({ cls: "chronote-quiz-score" });
  const progressEl = header.createDiv({ cls: "chronote-quiz-progress" });
  const progressBar = container.createDiv({ cls: "chronote-quiz-progress-bar" });
  const progressFill = progressBar.createDiv({ cls: "chronote-quiz-progress-fill" });

  const questionArea = container.createDiv({ cls: "chronote-quiz-question-area" });
  const promptEl = questionArea.createDiv({ cls: "chronote-quiz-prompt" });
  const optionsEl = questionArea.createDiv({ cls: "chronote-quiz-options" });
  const feedbackEl = questionArea.createDiv({ cls: "chronote-quiz-feedback" });

  const controls = container.createDiv({ cls: "chronote-quiz-controls" });
  const nextBtn = controls.createEl("button", {
    cls: "chronote-quiz-next-btn",
    text: "Next",
  });

  let current = 0;
  let answered = false;
  let score = 0;

  function updateHeader() {
    scoreEl.setText(`Score: ${score} / ${quiz.questions.length}`);
    progressEl.setText(`Question ${current + 1} of ${quiz.questions.length}`);
    const pct = ((current + (answered ? 1 : 0)) / quiz.questions.length) * 100;
    progressFill.style.width = `${pct}%`;
  }

  function renderQuestion() {
    answered = false;
    feedbackEl.style.display = "none";
    feedbackEl.empty();
    optionsEl.empty();

    const q = quiz.questions[current];
    promptEl.setText(q.prompt);

    q.options.forEach((option, idx) => {
      const btn = optionsEl.createEl("button", {
        cls: "chronote-quiz-option",
        text: option,
      });
      btn.addEventListener("click", () => handleAnswer(idx));
    });

    nextBtn.disabled = true;
    updateHeader();
  }

  function handleAnswer(selectedIndex: number) {
    if (answered) return;
    answered = true;

    const q = quiz.questions[current];
    const correct = selectedIndex === q.correct_index;
    if (correct) score++;

    // Disable all option buttons and mark correct / incorrect.
    const buttons = Array.from(optionsEl.querySelectorAll(".chronote-quiz-option")) as HTMLButtonElement[];
    buttons.forEach((b, idx) => {
      b.disabled = true;
      if (idx === q.correct_index) {
        b.addClass("is-correct");
      } else if (idx === selectedIndex && !correct) {
        b.addClass("is-incorrect");
      }
    });

    feedbackEl.style.display = "";
    feedbackEl.addClass(correct ? "is-correct" : "is-incorrect");
    feedbackEl.createEl("strong", {
      text: correct ? "Correct!" : "Not quite.",
    });
    if (q.explanation) {
      feedbackEl.createEl("p", { text: q.explanation });
    }

    updateHeader();
    nextBtn.disabled = false;
  }

  function finishQuiz() {
    questionArea.empty();
    controls.empty();
    header.empty();

    header.createDiv({
      cls: "chronote-quiz-title",
      text: `Quiz complete — ${quiz.testName}`,
    });

    const summary = questionArea.createDiv({ cls: "chronote-quiz-summary" });
    summary.createEl("h3", { text: `You scored ${score} / ${quiz.questions.length}` });
    const pct = quiz.questions.length === 0 ? 0 : Math.round((score / quiz.questions.length) * 100);
    summary.createEl("p", { text: `${pct}% correct` });

    progressFill.style.width = "100%";
  }

  nextBtn.addEventListener("click", () => {
    if (!answered) return;
    if (current < quiz.questions.length - 1) {
      current++;
      renderQuestion();
    } else {
      finishQuiz();
      _options?.onComplete?.();
    }
  });

  renderQuestion();
}
