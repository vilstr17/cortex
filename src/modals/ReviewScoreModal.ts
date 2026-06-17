import { App, Modal, Setting, SliderComponent } from "obsidian";
import { ReviewScoreInfoModal } from "./ReviewScoreInfoModal.js";

export class ReviewScoreModal extends Modal {
  private onSubmit: (score: number) => void;
  private score = 3;
  private slider!: SliderComponent;
  private scoreLabel!: HTMLElement;

  constructor(app: App, onSubmit: (score: number) => void) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "📊 Log Chronote Review" });
    contentEl.createEl("p", {
      text: "How well do you know this material?",
    });

    // Slider setting — name above the slider, full-width
    const sliderSetting = new Setting(contentEl)
      .setName("Review Score")
      .setDesc('Left (1) = "Don\'t know it at all"  ·  Right (5) = "Know it perfectly"');
    sliderSetting.settingEl.addClass("chronote-review-score-setting");

    const scoreInfoButton = sliderSetting.nameEl.createEl("button", {
      cls: "chronote-score-info-btn",
      text: "i",
      attr: {
        type: "button",
        "aria-label": "Show review score explanation",
        title: "What do scores 1–5 mean?",
      },
    });
    scoreInfoButton.addEventListener("click", () => {
      new ReviewScoreInfoModal(this.app).open();
    });

    // Score display label
    this.scoreLabel = sliderSetting.controlEl.createSpan({
      cls: "chronote-score-label",
      text: `${this.score} / 5`,
    });

    sliderSetting.addSlider((slider) => {
      this.slider = slider;
      slider
        .setLimits(1, 5, 1)
        .setValue(3)
        .setDynamicTooltip()
        .onChange((value) => {
          this.score = value;
          this.scoreLabel.textContent = `${value} / 5`;
        });

      // Force the slider to be wide and easier to grab
    });

    // Ensure the Setting's info/name area also stretches

    // Scale legend — evenly spaced labels directly under the slider
    const legend = contentEl.createDiv({ cls: "chronote-score-legend" });
    legend.createSpan({ text: "1 — Don't know it" });
    legend.createSpan({ text: "3 — Partially" });
    legend.createSpan({ text: "5 — Know it perfectly" });

    // Submit button
    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText("Submit")
        .setCta()
        .onClick(() => {
          this.close();
          this.onSubmit(this.score);
        })
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
