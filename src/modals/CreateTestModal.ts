import { App, Modal, Setting, moment, ButtonComponent } from "obsidian";
import CortexPlugin from "../main.js";

export class CreateTestModal extends Modal {
  private plugin: CortexPlugin;
  private onSubmit: () => void;
  private testName = "";
  private testDate = "";
  private saveButtonComponent: ButtonComponent | null = null;

  constructor(app: App, plugin: CortexPlugin, onSubmit: () => void) {
    super(app);
    this.plugin = plugin;
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: "Create New Test" });

    // Default date: 7 days from now
    const defaultDate = (moment as unknown as (input?: unknown) => { add(n: number, unit: string): { format(fmt: string): string } })().add(7, "days").format("YYYY-MM-DD");
    this.testDate = defaultDate;

    let dateInput: HTMLInputElement | null = null;

    const validateForm = () => {
      const nameValid = this.testName.trim().length > 0;
      const dateValid = this.testDate.length > 0;
      if (this.saveButtonComponent) {
        this.saveButtonComponent.setDisabled(!(nameValid && dateValid));
      }
    };

    new Setting(contentEl)
      .setName("Test name")
      .setDesc("Enter a name for this test (e.g., Math Final, Physics Midterm).")
      .addText((text) => {
        text.setPlaceholder("e.g., Math Final");
        text.setValue(this.testName);
        text.onChange(async (value) => {
          this.testName = value;
          validateForm();
        });
      });

    // Date picker using a native <input type="date">
    const dateSetting = new Setting(contentEl)
      .setName("Test date")
      .setDesc("Select the date of the test.");

    dateInput = dateSetting.controlEl.createEl("input", {
      attr: {
        type: "date",
        value: defaultDate,
      },
    });
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
        this.saveButtonComponent = b;
        b.setButtonText("Save")
          .setCta()
          .setDisabled(true)
          .onClick(async () => {
            // Capture values from input components
            const nameVal = this.testName.trim();
            const dateVal = this.testDate;

            if (!nameVal || !dateVal) {
              return;
            }

            await this.plugin.testService.addTest(nameVal, dateVal);

            // Call the onSubmit callback
            this.onSubmit();

            // Call this.close()
            this.close();
          });
      });

    // Initial validation
    validateForm();
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
  }
}