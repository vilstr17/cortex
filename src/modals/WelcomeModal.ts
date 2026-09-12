import { App, Modal, Setting } from "obsidian";

/**
 * First-run welcome modal. Shown once — either at plugin activation or
 * at the first dashboard open, whichever comes first — to introduce the
 * plugin and its default shortcuts. `onDismiss` fires on ANY close path
 * (Esc, the X button, or "Get started") so the caller can persist the
 * `welcomeSeen` flag and never show it again.
 */
export class WelcomeModal extends Modal {
  private onDismiss: () => void;

  constructor(app: App, onDismiss: () => void) {
    super(app);
    this.onDismiss = onDismiss;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("chronote-welcome-modal");

    contentEl.createEl("h2", { text: "👋 Welcome to Chronote" });
    contentEl.createEl("p", {
      text: "Thank you for installing Chronote — a spaced-repetition study tool that turns the notes you already have into a review system. Here's a quick tutorial:",
    });

    const steps = contentEl.createEl("ol", { cls: "chronote-welcome-steps" });

    this.addStep(steps, [{ text: "Open any note you want to remember." }]);
    this.addStep(steps, [
      { text: "Press " },
      { kbd: "Cmd+R" },
      { text: " (or " },
      { kbd: "Ctrl+R" },
      { text: " on Windows/Linux) to log a review." },
    ]);
    this.addStep(steps, [
      { text: "Rate how confident you are on a scale of " },
      { strong: "1–5" },
      { text: ": " },
      { strong: "1" },
      { text: " = “Don't know it at all”, " },
      { strong: "3" },
      { text: " = “Partially”, " },
      { strong: "5" },
      { text: " = “Know it perfectly”. Chronote schedules the next review for you." },
    ]);
    this.addStep(steps, [
      { text: "The note automatically appears under " },
      { strong: "Due Reviews" },
      { text: " in your dashboard." },
    ]);
    this.addStep(steps, [
      { text: "Press " },
      { kbd: "Cmd+M" },
      { text: " (or " },
      { kbd: "Ctrl+M" },
      { text: " on Windows/Linux) to open the dashboard anytime." },
    ]);
    this.addStep(steps, [
      { text: "Press " },
      { kbd: "Option+T" },
      { text: " (or " },
      { kbd: "Alt+T" },
      { text: " on Windows/Linux) to add the current note to a test. Create the test first in the dashboard — click the " },
      { strong: "+" },
      { text: " button in the Upcoming Tests panel." },
    ]);

    contentEl.createEl("p", {
      cls: "chronote-welcome-note",
      text: "You can change these shortcuts anytime in Settings → Hotkeys. Happy studying! 🎓",
    });

    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText("Get started")
        .setCta()
        .onClick(() => this.close())
    );
  }

  onClose(): void {
    this.contentEl.empty();
    this.onDismiss();
  }

  /**
   * Append one tutorial step. Each segment is either plain text, a
   * `<kbd>` keycap, or a `<strong>` emphasis — built with the DOM API
   * (no innerHTML) to match the rest of the plugin.
   */
  private addStep(
    list: HTMLElement,
    segments: Array<{ text?: string; kbd?: string; strong?: string }>,
  ): void {
    const li = list.createEl("li");
    for (const seg of segments) {
      if (seg.kbd) li.createEl("kbd", { text: seg.kbd });
      else if (seg.strong) li.createEl("strong", { text: seg.strong });
      else if (seg.text) li.appendText(seg.text);
    }
  }
}
