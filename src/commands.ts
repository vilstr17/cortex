import { TFile } from "obsidian";
import CortexPlugin from "./main";
import { ReviewScoreModal } from "./modals/ReviewScoreModal";
import { AddToTestModal } from "./modals/AddToTestModal";
import { MarkTestDoneModal } from "./modals/MarkTestDoneModal";
import { calculateNextReview } from "./utils/srsLogic";
import { cortexNotice } from "./utils/notice";

export default class Commands {
  plugin: CortexPlugin;

  constructor(plugin: CortexPlugin) {
    this.plugin = plugin;
  }

  addCommands() {
    const plugin = this.plugin;

    plugin.addCommand({
      id: "log-cortex-review",
      name: "Log Cortex Review",
      checkCallback: (checking: boolean) => {
        const activeFile = plugin.app.workspace.getActiveFile();
        if (checking) {
          return activeFile !== null && activeFile.extension === "md";
        }
        if (activeFile && activeFile.extension === "md") {
          new ReviewScoreModal(plugin.app, async (score: number) => {
            try {
              const result = await applyReviewToFrontmatter(activeFile, score, plugin);
              if (result.lastReviewBeforeExam) {
                cortexNotice(`Crush it! Last review done for ${activeFile.name} — good luck on the exam!`);
              } else {
                cortexNotice(`Logged review score: ${score} for ${activeFile.name}`);
              }
            } catch (error) {
              console.error("Cortex: Error logging review:", error);
              cortexNotice(`Failed to log review for ${activeFile.name}`);
            }
          }).open();
        }
      },
    });

    plugin.addCommand({
      id: "add-file-to-test",
      name: "Add current file to Test",
      checkCallback: (checking: boolean) => {
        const activeFile = plugin.app.workspace.getActiveFile();
        if (checking) {
          return activeFile !== null;
        }
        if (activeFile) {
          new AddToTestModal(plugin.app, plugin, activeFile.path).open();
        }
      },
    });

    plugin.addCommand({
      id: "mark-test-done",
      name: "Mark test as done",
      callback: () => {
        new MarkTestDoneModal(plugin.app, plugin).open();
      },
    });
  }
}

interface ReviewResult {
  lastReviewBeforeExam: boolean;
}

/**
 * Calculate the next review interval and date based on a 1-5 quality score,
 * then write the result into the note's YAML frontmatter.
 *
 * Fields written:
 *   - confidence  (number 1-5) — the review score logged by the user
 *   - interval    (number of days until next review)
 *   - next_review (ISO date string YYYY-MM-DD)
 *
 * The confidence field is always set to the provided score value.
 * If a note has never been reviewed, it will have no confidence field,
 * which the progress calculator treats as score = 0.
 *
 * Returns a ReviewResult indicating whether this was the last review before an exam.
 */
async function applyReviewToFrontmatter(
  file: TFile,
  score: number,
  plugin: CortexPlugin
): Promise<ReviewResult> {
  const app = plugin.app;
  // Let's first calculate the basic next review date
  let nextInterval = 0;
  let nextReviewDate = "";
  let lastReviewBeforeExam = false;

  const rawMaxInterval = plugin.settings.maxReviewIntervalDays;
  const maxReviewIntervalDays =
    typeof rawMaxInterval === "number" && Number.isFinite(rawMaxInterval)
      ? Math.max(1, Math.min(365, Math.floor(rawMaxInterval)))
      : null;

  await app.fileManager.processFrontMatter(file, (frontmatter) => {
    // Ensure exam_date exists in frontmatter so Obsidian Properties UI shows it.
    // Do NOT overwrite an existing value.
    if (frontmatter.exam_date === undefined || frontmatter.exam_date === null) {
      frontmatter.exam_date = null;
    }

    // Read current interval (default to 0 for first review)
    const currentInterval: number =
      typeof frontmatter.interval === "number"
        ? frontmatter.interval
        : frontmatter.interval === "number"
        ? Number(frontmatter.interval)
        : 0;

    // Read exam date if present (used by SRS algorithm to compress intervals near exam)
    const examDateStr: string | undefined =
      typeof frontmatter.exam_date === "string"
        ? frontmatter.exam_date
        : undefined;

    // Check if this is the last review before the exam
    if (examDateStr) {
      const examDate = new Date(examDateStr);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      if (examDate.getTime() <= today.getTime()) {
        lastReviewBeforeExam = true;
      }
    }

    // Calculate next review using the SRS algorithm
    const srResult = calculateNextReview(
      currentInterval,
      score,
      examDateStr,
      maxReviewIntervalDays,
    );
    nextInterval = srResult.nextInterval;
    nextReviewDate = srResult.nextReviewDate;
  });

  // Check for daily overflow limits
  const configuredMax = plugin.settings.dailyLimitMax;
  const maxPerDay = configuredMax !== null ? Math.max(1, Math.min(20, configuredMax)) : null;

  const getNotesScheduledFor = (dateStr: string) => {
    let count = 0;
    const files = app.vault.getMarkdownFiles();
    for (const f of files) {
      if (f.path === file.path) continue; // Skip the currently updated file
      const cache = app.metadataCache.getFileCache(f);
      if (cache?.frontmatter) {
        if (cache.frontmatter.next_review === dateStr) {
          count++;
        }
      }
    }
    return count;
  };

  if (maxPerDay !== null) {
    let overflowDate = new Date(nextReviewDate);

    while (getNotesScheduledFor(nextReviewDate) >= maxPerDay) {
      // overflow to the next day
      overflowDate.setDate(overflowDate.getDate() + 1);
      const newStr = overflowDate.toISOString().split("T")[0];
      nextReviewDate = newStr;
      nextInterval++;
    }
  }

  // Final apply
  await app.fileManager.processFrontMatter(file, (frontmatter) => {
    frontmatter.confidence = score;
    frontmatter.interval = nextInterval;
    frontmatter.next_review = nextReviewDate;
  });

  return { lastReviewBeforeExam };
}
