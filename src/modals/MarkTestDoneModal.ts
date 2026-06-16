import { App, Modal, Notice, Setting } from "obsidian";
import CortexPlugin from "../main.js";
import { TestService } from "../services/testService.js";

export class MarkTestDoneModal extends Modal {
  private plugin: CortexPlugin;
  private testService: TestService;

  constructor(app: App, plugin: CortexPlugin) {
    super(app);
    this.plugin = plugin;
    this.testService = new TestService(plugin);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Mark test as done" });

    const tests = this.plugin.settings.tests;

    if (tests.length === 0) {
      contentEl.createEl("p", {
        text: "No tests found. Create a test first in the Cortex Dashboard.",
      });
      new Setting(contentEl).addButton((btn) =>
        btn.setButtonText("Close").onClick(() => this.close())
      );
      return;
    }

    let selectedTestId: string = tests[0].id;

    new Setting(contentEl)
      .setName("Select a test")
      .setDesc("Choose which test to mark as done or not done.")
      .addDropdown((dropdown) => {
        tests.forEach((test) => {
          const label = test.done ? `${test.name} (done)` : test.name;
          dropdown.addOption(test.id, label);
        });
        dropdown.setValue(selectedTestId).onChange((value) => {
          selectedTestId = value;
        });
      });

    const selectedTest = () => this.testService.getTestById(selectedTestId);

    new Setting(contentEl).addButton((btn) =>
      btn
        .setButtonText("Toggle done")
        .setCta()
        .onClick(async () => {
          const test = selectedTest();
          if (!test) {
            new Notice("Test not found.");
            return;
          }
          await this.testService.toggleDone(test.id);
          new Notice(test.done ? `Marked "${test.name}" as not done` : `Marked "${test.name}" as done`);
          this.close();
        })
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}