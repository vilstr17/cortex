/**
 * Save Flashcards Modal.
 *
 * Shown when the user clicks "Save" on a flashcard deck in chat.
 *
 * Two mutually-exclusive choices:
 *   • Use default  — save to the configured flashcard folder.
 *   • Custom       — browse the vault and pick a destination, which
 *                    can be EITHER a folder (a new flashcard note is
 *                    created inside it) OR an existing note (the cards
 *                    are appended to the bottom of that note).
 *
 * The selection is session-only. The durable default
 * (`settings.flashcardFolder`) is unchanged when the user picks
 * something else for one save.
 */

import {
  App,
  FuzzySuggestModal,
  Modal,
  Notice,
  Setting,
  TFile,
} from "obsidian";
import type CortexPlugin from "../main";
import { SaveTarget } from "../services/flashcardSaveService";

/**
 * One entry in the unified vault browser — either a folder (cards
 * land in a new note inside it) or an existing note (cards are
 * appended to it).
 */
type VaultLocation =
  | { type: "folder"; path: string }
  | { type: "note"; file: TFile };

/**
 * A single picker that lists every folder AND every note in the
 * vault, so the user makes one choice instead of juggling separate
 * "folder" and "existing note" toggles.
 */
class VaultLocationPickerModal extends FuzzySuggestModal<VaultLocation> {
  /** Resolves with the location the user picked, or null on cancel. */
  private resolvePick: ((value: VaultLocation | null) => void) | null = null;
  private items: VaultLocation[];

  constructor(app: App) {
    super(app);
    this.setPlaceholder("Pick a folder or a note…");
    this.setInstructions([
      { command: "↑↓", purpose: "navigate" },
      { command: "↵", purpose: "select" },
      { command: "esc", purpose: "cancel" },
    ]);

    const folders: VaultLocation[] = ["", ...collectVaultFolders(app)].map(
      (path) => ({ type: "folder", path }),
    );
    const notes: VaultLocation[] = app.vault
      .getMarkdownFiles()
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((file) => ({ type: "note", file }));
    // Folders first, then notes — folders are the common case.
    this.items = [...folders, ...notes];
  }

  /** Resolves with the chosen location, or null if dismissed. */
  pick(): Promise<VaultLocation | null> {
    return new Promise((resolve) => {
      this.resolvePick = resolve;
    });
  }

  getItems(): VaultLocation[] {
    return this.items;
  }

  getItemText(item: VaultLocation): string {
    if (item.type === "folder") {
      return `📁 ${item.path === "" ? "(vault root)" : item.path}  — new note`;
    }
    return `📄 ${item.file.path}  — append to this note`;
  }

  onChooseItem(item: VaultLocation, _evt: MouseEvent | KeyboardEvent): void {
    const resolver = this.resolvePick;
    this.resolvePick = null;
    resolver?.(item);
  }

  onClose(): void {
    if (this.resolvePick) {
      const resolver = this.resolvePick;
      this.resolvePick = null;
      resolver(null);
    }
    super.onClose();
  }
}

/**
 * Collect every folder mentioned by any markdown file in the
 * vault. Returns paths relative to the vault root, no trailing
 * slash. The vault root ("") is NOT included — callers add it
 * explicitly when they need it.
 */
function collectVaultFolders(app: App): string[] {
  const set = new Set<string>();
  for (const f of app.vault.getMarkdownFiles()) {
    const idx = f.path.lastIndexOf("/");
    if (idx <= 0) continue; // file is in the vault root
    const folder = f.path.slice(0, idx);
    set.add(folder);
  }
  return Array.from(set).sort();
}

/**
 * Show the per-save location picker. Resolves with the user's
 * choice, or null if they cancel.
 */
export function promptForSaveLocation(
  app: App,
  plugin: CortexPlugin,
): Promise<SaveTarget | null> {
  return new Promise((resolve) => {
    const modal = new SaveFlashcardsModal(app, plugin, resolve);
    modal.open();
  });
}

class SaveFlashcardsModal extends Modal {
  private plugin: CortexPlugin;
  private resolve: (target: SaveTarget | null) => void;
  private choice: "default" | "custom" = "default";
  /** The custom destination, once the user has picked one. */
  private custom: VaultLocation | null = null;

  /** Toggle handles so the two options behave as a radio pair. */
  private defaultToggle?: { setValue(v: boolean): void };
  private customToggle?: { setValue(v: boolean): void };
  /** Custom destination sub-form, hidden until "Custom" is on. */
  private customSection!: HTMLElement;
  private customReadout!: HTMLElement;

  constructor(
    app: App,
    plugin: CortexPlugin,
    resolve: (target: SaveTarget | null) => void,
  ) {
    super(app);
    this.plugin = plugin;
    this.resolve = resolve;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("cortex-save-flashcards-modal");

    contentEl.createEl("h2", { text: "Save flashcards" });

    const defaultLabel = this.plugin.settings.flashcardFolder.trim() === ""
      ? "(vault root)"
      : this.plugin.settings.flashcardFolder;

    // ── Option 1: default ─────────────────────────────────────────
    new Setting(contentEl)
      .setName("Use default")
      .setDesc(`Save to: ${defaultLabel}`)
      .addToggle((toggle) => {
        this.defaultToggle = toggle;
        toggle.setValue(this.choice === "default");
        toggle.onChange((on) => {
          // Radio behaviour: turning this on selects default;
          // turning it off falls back to custom.
          this.setChoice(on ? "default" : "custom");
        });
      });

    // ── Option 2: custom (folder OR existing note) ────────────────
    new Setting(contentEl)
      .setName("Custom location")
      .setDesc(
        "Browse the vault and pick a folder (creates a new note) or an existing note (appends the cards). The default setting is not changed.",
      )
      .addToggle((toggle) => {
        this.customToggle = toggle;
        toggle.setValue(this.choice === "custom");
        toggle.onChange((on) => {
          this.setChoice(on ? "custom" : "default");
        });
      });

    this.customSection = contentEl.createDiv({
      cls: "cortex-save-fc-custom-section",
    });
    this.customSection.style.display = "none";
    this.customSection.style.marginLeft = "24px";
    this.customSection.style.marginBottom = "12px";

    this.customReadout = this.customSection.createEl("p", {
      cls: "cortex-save-fc-readout",
    });

    new Setting(this.customSection)
      .setName("Destination")
      .addButton((btn) => {
        btn.setButtonText("Browse vault…").onClick(() => this.openPicker());
      });

    this.renderReadout();

    // ── Footer buttons ────────────────────────────────────────────
    const footer = contentEl.createDiv({ cls: "cortex-save-fc-footer" });
    const cancelBtn = footer.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => this.cancel());

    const saveBtn = footer.createEl("button", {
      text: "Save",
      cls: "mod-cta",
    });
    saveBtn.addEventListener("click", () => this.confirm());
  }

  onClose(): void {
    // If the modal closes without confirm/cancel (e.g. user hits
    // Escape), resolve as null so the caller can short-circuit.
    this.resolve(null);
  }

  private setChoice(choice: "default" | "custom"): void {
    this.choice = choice;
    // Keep the two toggles in sync so only one ever reads as "on".
    this.defaultToggle?.setValue(choice === "default");
    this.customToggle?.setValue(choice === "custom");
    this.customSection.style.display = choice === "custom" ? "" : "none";

    // First time switching to custom with nothing picked yet —
    // open the browser straight away so the choice is obvious.
    if (choice === "custom" && this.custom === null) {
      void this.openPicker();
    }
  }

  private async openPicker(): Promise<void> {
    const picker = new VaultLocationPickerModal(this.app);
    const picked = await picker.pick();
    if (picked !== null) {
      this.custom = picked;
      this.renderReadout();
    } else if (this.custom === null) {
      // Cancelled with nothing chosen — revert to default so the
      // user isn't stuck on an empty custom selection.
      this.setChoice("default");
    }
  }

  /** Show what the custom destination currently points at. */
  private renderReadout(): void {
    if (!this.customReadout) return;
    if (this.custom === null) {
      this.customReadout.setText("No destination picked yet.");
      return;
    }
    if (this.custom.type === "folder") {
      const where = this.custom.path === "" ? "(vault root)" : this.custom.path;
      this.customReadout.setText(`New note in folder: ${where}`);
    } else {
      this.customReadout.setText(`Append to note: ${this.custom.file.path}`);
    }
  }

  private cancel(): void {
    this.resolve(null);
    this.close();
  }

  private confirm(): void {
    let target: SaveTarget;
    if (this.choice === "custom") {
      if (this.custom === null) {
        new Notice("Cortex: pick a destination first.");
        return;
      }
      target = this.custom.type === "folder"
        ? { kind: "folder", folder: this.custom.path.trim() }
        : { kind: "existing", file: this.custom.file };
    } else {
      // `default` carries the configured folder so the save
      // service doesn't have to know about plugin settings.
      target = {
        kind: "default",
        folder: this.plugin.settings.flashcardFolder,
      };
    }
    this.resolve(target);
    this.close();
  }
}
