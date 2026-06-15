/**
 * Save Flashcards Modal.
 *
 * Shown when the user clicks "Save" on a flashcard deck in chat.
 * Lets them override the default flashcard folder for this one
 * save — either by picking a different folder, or by appending
 * the new cards into an existing flashcard note.
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
 * A folder-picker modal that lists every folder in the vault.
 * Obsidian's `FuzzySuggestModal` works on any `T[]`; we just
 * materialise folders from the markdown file paths.
 */
class FolderPickerModal extends FuzzySuggestModal<string> {
  /** Resolves with the folder path the user picked, or null on cancel. */
  private resolvePick: ((value: string | null) => void) | null = null;
  /** Folders to offer in the picker. */
  private folders: string[];

  constructor(app: App) {
    super(app);
    this.setPlaceholder("Type a folder path…");
    this.setInstructions([
      { command: "↑↓", purpose: "navigate" },
      { command: "↵", purpose: "select" },
      { command: "esc", purpose: "cancel" },
    ]);
    this.folders = collectVaultFolders(app);
  }

  /** Resolves with the chosen folder, or null if dismissed. */
  pick(): Promise<string | null> {
    return new Promise((resolve) => {
      this.resolvePick = resolve;
    });
  }

  getItems(): string[] {
    // Always include the vault root, even when no folders are present.
    return ["/", ...this.folders];
  }

  getItemText(item: string): string {
    return item === "/" ? "(vault root)" : item;
  }

  onChooseItem(item: string, _evt: MouseEvent | KeyboardEvent): void {
    const resolver = this.resolvePick;
    this.resolvePick = null;
    // `open()` returns void on close — we resolve via the field
    // so this works regardless of how the user picked.
    resolver?.(item === "/" ? "" : item);
  }

  onClose(): void {
    // If the modal closed without a pick, the resolver is still
    // pending — resolve it as cancel.
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
 * Collect every flashcard-bearing note in the vault. We use the
 * `flashcards: true` frontmatter the save service already writes
 * as the marker, so the dropdown only shows notes the user has
 * actually used as a deck.
 */
function collectFlashcardNotes(app: App): TFile[] {
  const out: TFile[] = [];
  for (const f of app.vault.getMarkdownFiles()) {
    const cache = app.metadataCache.getFileCache(f);
    const fm = cache?.frontmatter;
    if (fm && (fm as Record<string, unknown>).flashcards === true) {
      out.push(f);
    }
  }
  // Sort by basename for predictable display.
  out.sort((a, b) => a.basename.localeCompare(b.basename));
  return out;
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
  private choice: "default" | "folder" | "existing" = "default";
  private customFolder: string;
  private existingFile: TFile | null = null;
  /** DOM nodes for the conditional sub-forms, hidden until needed. */
  private folderSection!: HTMLElement;
  private existingSection!: HTMLElement;

  constructor(
    app: App,
    plugin: CortexPlugin,
    resolve: (target: SaveTarget | null) => void,
  ) {
    super(app);
    this.plugin = plugin;
    this.resolve = resolve;
    this.customFolder = plugin.settings.flashcardFolder;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("cortex-save-flashcards-modal");

    contentEl.createEl("h2", { text: "Save flashcards" });

    const defaultLabel = this.plugin.settings.flashcardFolder.trim() === ""
      ? "(vault root)"
      : this.plugin.settings.flashcardFolder;

    // ── Radio 1: default ───────────────────────────────────────────
    new Setting(contentEl)
      .setName("Use default")
      .setDesc(`Save to: ${defaultLabel}`)
      .addToggle((toggle) => {
        toggle.setValue(this.choice === "default");
        toggle.onChange((on) => {
          if (on) this.setChoice("default");
        });
      });

    // ── Radio 2: pick a folder ────────────────────────────────────
    new Setting(contentEl)
      .setName("Pick a folder")
      .setDesc("Save to a one-off folder for this batch only — the default setting is not changed.")
      .addToggle((toggle) => {
        toggle.setValue(this.choice === "folder");
        toggle.onChange((on) => {
          if (on) this.setChoice("folder");
        });
      });

    this.folderSection = contentEl.createDiv({ cls: "cortex-save-fc-folder-section" });
    this.folderSection.style.display = "none";
    this.folderSection.style.marginLeft = "24px";
    this.folderSection.style.marginBottom = "12px";

    new Setting(this.folderSection)
      .setName("Folder")
      .addText((text) => {
        text
          .setPlaceholder("(vault root)")
          .setValue(this.customFolder)
          .onChange((value) => {
            this.customFolder = value;
          });
      })
      .addButton((btn) => {
        btn.setButtonText("Browse…").onClick(() => this.openFolderPicker());
      });

    // ── Radio 3: save into existing note ─────────────────────────
    const existing = collectFlashcardNotes(this.app);
    const existingDesc = existing.length === 0
      ? "No existing flashcard notes found in the vault yet."
      : "Append these cards to an existing deck (any note with `flashcards: true` frontmatter).";

    new Setting(contentEl)
      .setName("Save into existing note")
      .setDesc(existingDesc)
      .addToggle((toggle) => {
        toggle.setValue(this.choice === "existing");
        toggle.onChange((on) => {
          if (on) this.setChoice("existing");
        });
      });

    this.existingSection = contentEl.createDiv({ cls: "cortex-save-fc-existing-section" });
    this.existingSection.style.display = "none";
    this.existingSection.style.marginLeft = "24px";
    this.existingSection.style.marginBottom = "12px";

    if (existing.length === 0) {
      this.existingSection.createEl("p", {
        text: "Save some cards first, then come back — your existing decks will appear here.",
        cls: "cortex-save-fc-empty",
      });
    } else {
      new Setting(this.existingSection)
        .setName("Note")
        .addDropdown((dropdown) => {
          for (const f of existing) {
            dropdown.addOption(f.path, `${f.basename} (${f.path})`);
          }
          this.existingFile = existing[0];
          dropdown.setValue(existing[0].path).onChange((value) => {
            const found = existing.find((f) => f.path === value);
            if (found) this.existingFile = found;
          });
        });
    }

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

  private setChoice(choice: "default" | "folder" | "existing"): void {
    this.choice = choice;
    this.folderSection.style.display = choice === "folder" ? "" : "none";
    this.existingSection.style.display = choice === "existing" ? "" : "none";
  }

  private async openFolderPicker(): Promise<void> {
    const picker = new FolderPickerModal(this.app);
    const picked = await picker.pick();
    if (picked !== null) {
      this.customFolder = picked;
      // Refresh the visible text in the folder input. We re-render
      // the section's text setting so the new value shows up.
      this.refreshFolderInput();
    }
  }

  /** Find the text input under the folder section and update it. */
  private refreshFolderInput(): void {
    const input = this.folderSection.querySelector("input[type=text]") as
      | HTMLInputElement
      | null;
    if (input) input.value = this.customFolder;
  }

  private cancel(): void {
    this.resolve(null);
    this.close();
  }

  private confirm(): void {
    let target: SaveTarget;
    if (this.choice === "folder") {
      target = { kind: "folder", folder: this.customFolder.trim() };
    } else if (this.choice === "existing") {
      if (!this.existingFile) {
        new Notice("Cortex: pick an existing note first.");
        return;
      }
      target = { kind: "existing", file: this.existingFile };
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
