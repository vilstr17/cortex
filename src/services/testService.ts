import CortexPlugin from "../main";
import { CortexTest } from "../settings";
import { TFile } from "obsidian";

export class TestService {
  private plugin: CortexPlugin;

  constructor(plugin: CortexPlugin) {
    this.plugin = plugin;
  }

  getAllTests(): CortexTest[] {
    return this.plugin.settings.tests;
  }

  getTestById(id: string): CortexTest | undefined {
    return this.plugin.settings.tests.find((test) => test.id === id);
  }

  async addTest(name: string, date: string): Promise<CortexTest> {
    const newTest: CortexTest = {
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
    this.plugin.settings.tests = this.plugin.settings.tests.filter(
      (test) => test.id !== id
    );
    await this.plugin.saveData(this.plugin.settings);
  }

  async updateTest(id: string, updates: Partial<Pick<CortexTest, "name" | "date">>): Promise<CortexTest | undefined> {
    const test = this.getTestById(id);
    if (!test) return undefined;

    if (updates.name !== undefined) test.name = updates.name;
    if (updates.date !== undefined) {
      test.date = updates.date;
      // Sync the new exam date to all linked notes' frontmatter
      await this.syncExamDateToNotes(test.id);
    }

    await this.plugin.saveData(this.plugin.settings);
    return test;
  }

  async addFileToTest(testId: string, filePath: string): Promise<CortexTest | undefined> {
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

  async removeFileFromTest(testId: string, filePath: string): Promise<CortexTest | undefined> {
    const test = this.getTestById(testId);
    if (!test) return undefined;

    test.filePaths = test.filePaths.filter((path) => path !== filePath);
    await this.plugin.saveData(this.plugin.settings);

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
  private async syncExamDateToFile(test: CortexTest, filePath: string): Promise<void> {
    const file = this.plugin.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) return;

    await this.plugin.app.fileManager.processFrontMatter(file, (frontmatter) => {
      frontmatter.exam_date = test.date;
    });
  }
}
