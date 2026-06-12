import { App, Modal } from "obsidian";

export class ReviewScoreInfoModal extends Modal {
  constructor(app: App) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.addClass("cortex-score-info-modal");
    contentEl.createEl("h3", { text: "How to choose your review score" });

    const list = contentEl.createEl("ul", { cls: "cortex-score-info-list" });

    list.createEl("li", {
      text: "1 — No idea. I couldn’t recall this without help.",
    });
    list.createEl("li", {
      text: "2 — I understand it a bit, but only partially.",
    });
    list.createEl("li", {
      text: "3 — Good passive knowledge, but not fully stable yet.",
    });
    list.createEl("li", {
      text: "4 — I’m confident, but I still sometimes need a quick look.",
    });
    list.createEl("li", {
      text: "5 — I can explain the whole note without looking.",
    });

    contentEl.createEl("p", {
      cls: "cortex-score-info-note",
      text: "Tip: Be honest with your score — it helps scheduling stay effective.",
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
