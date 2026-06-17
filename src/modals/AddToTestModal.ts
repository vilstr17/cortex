import { App, Modal, Notice, Setting } from "obsidian";
import ChronotePlugin from "../main.js";
import { TestService } from "../services/testService.js";

export class AddToTestModal extends Modal {
  private plugin: ChronotePlugin;
  private filePath: string;
  private testService: TestService;

  constructor(app: App, plugin: ChronotePlugin, filePath: string) {
    super(app);
    this.plugin = plugin;
    this.filePath = filePath;
    this.testService = new TestService(plugin);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Add file to Test" });

    const tests = this.plugin.settings.tests;

    if (tests.length === 0) {
      contentEl.createEl("p", {
        text: "No tests found. Create a test first in the Chronote Dashboard.",
      });
      new Setting(contentEl).addButton((btn) =>
        btn.setButtonText("Close").onClick(() => this.close())
      );
      return;
    }

    let selectedTestId: string = tests[0].id;

    new Setting(contentEl)
      .setName("Select a test")
      .setDesc("Choose which test to add this file to.")
      .addDropdown((dropdown) => {
        tests.forEach((test) => { dropdown.addOption(test.id, test.name); });
        dropdown.setValue(selectedTestId).onChange((value) => {
          selectedTestId = value;
        });
      });

    new Setting(contentEl).addButton((btn) =>
      btn
        .setButtonText("Add to Test")
        .setCta()
        .onClick(async () => {
          const test = this.testService.getTestById(selectedTestId);
          if (!test) {
            new Notice("Test not found.");
            return;
          }

          if (!test.filePaths.includes(this.filePath)) {
            await this.testService.addFileToTest(test.id, this.filePath);
            new Notice(`Added to test: ${test.name}`);
          } else {
            new Notice("File is already in this test.");
          }

          this.close();
        })
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
