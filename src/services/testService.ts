import type ChronotePlugin from "../main.js";
import type { ChronoteTest } from "../settings.js";
import { TFile } from "obsidian";

export class TestService {
  private plugin: ChronotePlugin;

  constructor(plugin: ChronotePlugin) {
    this.plugin = plugin;
  }

  getAllTests(): ChronoteTest[] {
    return this.plugin.settings.tests;
  }

  getTestById(id: string): ChronoteTest | undefined {
    return this.plugin.settings.tests.find((test) => test.id === id);
  }

  async addTest(name: string, date: string): Promise<ChronoteTest> {
    const newTest: ChronoteTest = {
      id: crypto.randomUUID(),
      name,
      date,
      filePaths: [],
    };

    this.plugin.settings.tests.push(newTest);
    await this.plugin.saveData(this.plugin.settings);

    return newTest;
  }

  async removeTest(id: string): Promise<void> {
    const test = this.getTestById(id);
    if (!test) return;

    const affectedFilePaths = [...new Set(test.filePaths)];
    this.plugin.settings.tests = this.plugin.settings.tests.filter(
      (test) => test.id !== id
    );
    await this.plugin.saveData(this.plugin.settings);

    for (const filePath of affectedFilePaths) {
      await this.syncExamDateAfterUnlink(filePath);
    }
  }

  async toggleDone(id: string): Promise<ChronoteTest | undefined> {
    const test = this.getTestById(id);
    if (!test) return undefined;
    test.done = !test.done;
    await this.plugin.saveData(this.plugin.settings);
    return test;
  }

  async addFileToTest(testId: string, filePath: string): Promise<ChronoteTest | undefined> {
    const test = this.getTestById(testId);
    if (!test) return undefined;

    if (!test.filePaths.includes(filePath)) {
      test.filePaths.push(filePath);
      await this.plugin.saveData(this.plugin.settings);

      // Sync exam_date to the newly added note's frontmatter
      await this.syncExamDateToFile(test, filePath);

      return test;
    }

    return test;
  }

  /**
   * Remove the link between a note and one test. The note's exam date is
   * only cleared when no other test still links to it.
   */
  async removeFileFromTest(testId: string, filePath: string): Promise<ChronoteTest | undefined> {
    const test = this.getTestById(testId);
    if (!test) return undefined;

    if (!test.filePaths.includes(filePath)) return test;

    test.filePaths = test.filePaths.filter((path) => path !== filePath);
    await this.plugin.saveData(this.plugin.settings);
    await this.syncExamDateAfterUnlink(filePath);

    return test;
  }

  /**
   * Sync the exam date to all notes linked to a test.
   */
  private async syncExamDateToNotes(testId: string): Promise<void> {
    const test = this.getTestById(testId);
    if (!test) return;

    for (const filePath of test.filePaths) {
      await this.syncExamDateToFile(test, filePath);
    }
  }

  /**
   * Sync the exam date to a single note's frontmatter.
   * Always overwrites to keep it in sync with the test date.
   */
  private async syncExamDateToFile(test: ChronoteTest, filePath: string): Promise<void> {
    const file = this.plugin.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) return;

    await this.plugin.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
      frontmatter.exam_date = test.date;
      delete frontmatter.exclude_from_exam;
    });
  }

  /**
   * Keep frontmatter aligned after a note is unlinked or an entire test is
   * removed. `exam_date` is derived from the remaining test links.
   */
  private async syncExamDateAfterUnlink(filePath: string): Promise<void> {
    const remainingTest = this.plugin.settings.tests.find((test) =>
      test.filePaths.includes(filePath)
    );
    if (remainingTest) {
      await this.syncExamDateToFile(remainingTest, filePath);
      return;
    }

    const file = this.plugin.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) return;

    await this.plugin.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
      delete frontmatter.exam_date;
      delete frontmatter.exclude_from_exam;
    });
  }
}
