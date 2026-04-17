import { TFile } from "obsidian";
import CortexPlugin from "./main";
import { ReviewScoreModal } from "./modals/ReviewScoreModal";
import { AddToTestModal } from "./modals/AddToTestModal";
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
              await applyReviewToFrontmatter(activeFile, score, plugin.app);
              cortexNotice(
                `Logged review score: ${score} for ${activeFile.name}`
              );
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
  }
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
 */
async function applyReviewToFrontmatter(
  file: TFile,
  score: number,
  app: CortexPlugin["app"]
): Promise<void> {
  // Let's first calculate the basic next review date
  let nextInterval = 0;
  let nextReviewDate = "";

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

    // Calculate next review using the SRS algorithm
    const srResult = calculateNextReview(
      currentInterval,
      score,
      examDateStr
    );
    nextInterval = srResult.nextInterval;
    nextReviewDate = srResult.nextReviewDate;
  });

  // Check for daily overflow limits
  const maxPerDay = 5; // default max 5
  let hasOverflow = false;

  const getNotesScheduledFor = (dateStr: string, examStr?: string) => {
    let count = 0;
    const files = app.vault.getMarkdownFiles();
    for (const f of files) {
      if (f.path === file.path) continue; // Skip the currently updated file
      const cache = app.metadataCache.getFileCache(f);
      if (cache?.frontmatter) {
        if (
          cache.frontmatter.next_review === dateStr &&
          cache.frontmatter.exam_date === examStr
        ) {
          count++;
        }
      }
    }
    return count;
  };

  // We only check limits if it has an exam date (based on "from a single exam")
  let currentExamDateStr: string | undefined;
  const currentCache = app.metadataCache.getFileCache(file);
  if (currentCache?.frontmatter?.exam_date) {
    currentExamDateStr = currentCache.frontmatter.exam_date;
  }

  if (currentExamDateStr) {
    let overflowDate = new Date(nextReviewDate);
    const examDateObj = new Date(currentExamDateStr);

    while (getNotesScheduledFor(nextReviewDate, currentExamDateStr) >= maxPerDay) {
      // overflow to the next day
      overflowDate.setDate(overflowDate.getDate() + 1);
      const newStr = overflowDate.toISOString().split("T")[0];
      // Only overflow if it doesn't push past the exam date
      if (newStr > currentExamDateStr) {
        break; // can't overflow past exam, keep it as is
      }
      nextReviewDate = newStr;
      nextInterval++;
      hasOverflow = true;
    }
  }

  // Final apply
  await app.fileManager.processFrontMatter(file, (frontmatter) => {
    frontmatter.confidence = score;
    frontmatter.interval = nextInterval;
    frontmatter.next_review = nextReviewDate;
  });
}
