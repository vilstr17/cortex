import { App, Modal, Setting, SliderComponent } from "obsidian";

export class ReviewScoreModal extends Modal {
  private onSubmit: (score: number) => void;
  private score: number = 3;
  private slider!: SliderComponent;
  private scoreLabel!: HTMLElement;

  constructor(app: App, onSubmit: (score: number) => void) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "📊 Log Cortex Review" });
    contentEl.createEl("p", {
      text: "How well do you know this material?",
    });

    // Slider setting — name above the slider, full-width
    const sliderSetting = new Setting(contentEl)
      .setName("Review Score")
      .setDesc('Left (1) = "Don\'t know it at all"  ·  Right (5) = "Know it perfectly"');
    sliderSetting.settingEl.style.display = "block";

    // Score display label
    this.scoreLabel = sliderSetting.controlEl.createSpan({
      cls: "cortex-score-label",
      text: `${this.score} / 5`,
    });
    this.scoreLabel.style.cssText = "font-weight: bold; font-size: 1.4em; display: block; text-align: center; margin-bottom: 0.75em;";

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
      slider.sliderEl.style.width = "100%";
      slider.sliderEl.style.padding = "12px 0";
    });

    // Ensure the Setting's info/name area also stretches
    sliderSetting.infoEl.style.marginBottom = "0.5em";

    // Scale legend — evenly spaced labels directly under the slider
    const legend = contentEl.createDiv({ cls: "cortex-score-legend" });
    legend.style.cssText =
      "display: flex; justify-content: space-between; padding: 0 4px; color: var(--text-muted); font-size: 0.8em; margin-bottom: 1.5em;";
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
