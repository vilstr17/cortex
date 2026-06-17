import { App, Modal, Setting } from "obsidian";

/**
 * Minimal yes/no confirmation dialog. Replaces the browser `confirm()`
 * (disallowed by the Obsidian plugin guidelines) for destructive
 * actions such as deleting a test.
 */
export class ConfirmModal extends Modal {
  private message: string;
  private onConfirm: () => void;
  private confirmText: string;

  constructor(
    app: App,
    message: string,
    onConfirm: () => void,
    confirmText = "Delete",
  ) {
    super(app);
    this.message = message;
    this.onConfirm = onConfirm;
    this.confirmText = confirmText;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("p", { text: this.message });

    new Setting(contentEl)
      .addButton((btn) => btn.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((btn) => {
        btn.setButtonText(this.confirmText).onClick(() => {
          this.close();
          this.onConfirm();
        });
        btn.buttonEl.addClass("mod-warning");
      });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
