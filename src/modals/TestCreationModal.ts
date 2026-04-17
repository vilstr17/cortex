import { App, Modal, Setting, moment } from "obsidian";
import { TestService } from "../services/testService";

export class TestCreationModal extends Modal {
  private testName: string = "";
  private testDate: string = "";
  private testService: TestService;
  private onSave: () => void;

  constructor(app: App, testService: TestService, onSave: () => void) {
    super(app);
    this.testService = testService;
    this.onSave = onSave;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: "Create New Test" });

    // Default date: 7 days from now
    const defaultDate = moment().add(7, "days").format("YYYY-MM-DD");
    this.testDate = defaultDate;

    let submitBtn: HTMLButtonElement | null = null;
    let dateInput: HTMLInputElement | null = null;

    const validateForm = () => {
      const nameValid = this.testName.trim().length > 0;
      const dateValid = this.testDate.length > 0;
      if (submitBtn) {
        submitBtn.disabled = !(nameValid && dateValid);
      }
    };

    new Setting(contentEl)
      .setName("Test name")
      .setDesc("Enter a name for this test (e.g., Math Final, Physics Midterm).")
      .addText((text) =>
        text
          .setPlaceholder("e.g., Math Final")
          .setValue(this.testName)
          .onChange(async (value) => {
            this.testName = value;
            validateForm();
          })
      );

    // Date picker using a native <input type="date"> — Obsidian's Setting has no addDatepicker.
    const dateSetting = new Setting(contentEl)
      .setName("Test date")
      .setDesc("Select the date of the test.");

    dateInput = dateSetting.controlEl.createEl("input", {
      attr: {
        type: "date",
        value: defaultDate,
      },
    });
    dateInput.addClass("clickable-icon");
    dateInput.style.cssText =
      "width: 100%; padding: 6px 8px; border-radius: 4px; border: 1px solid var(--background-modifier-border); background: var(--background-modifier-form-field); color: var(--text-normal); font-size: var(--font-ui-small);";

    dateInput.addEventListener("change", () => {
      this.testDate = dateInput!.value;
      validateForm();
    });

    new Setting(contentEl)
      .addButton((btn) => {
        btn.setButtonText("Cancel").onClick(() => this.close());
      })
      .addButton((b) => {
        submitBtn = b.buttonEl as HTMLButtonElement;
        b.setButtonText("Save")
          .setCta()
          .setDisabled(true)
          .onClick(async () => {
            if (!this.testName.trim() || !this.testDate) return;

            await this.testService.addTest(
              this.testName.trim(),
              this.testDate
            );

            this.close();
            this.onSave();
          });
      });

    // Initial validation
    validateForm();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
