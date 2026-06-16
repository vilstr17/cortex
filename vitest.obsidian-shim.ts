/**
 * Minimal runtime shim for the `obsidian` package — used only by the
 * vitest test environment. The real `obsidian` package is a type-only
 * stub (no JS), and tests cannot import production modules that
 * reference it without this shim.
 *
 * Tests that need to assert on specific Obsidian surface (e.g.
 * `requestUrl` call arguments) layer `vi.mock("obsidian", ...)` on top
 * of this default.
 */

export class TFile {
  path: string;
  basename: string;
  extension: string;
  constructor(path: string, basename?: string, extension?: string) {
    this.path = path;
    this.basename = basename ?? "";
    this.extension = extension ?? "md";
  }
}

export class TAbstractFile {
  path: string;
  constructor(path: string) { this.path = path; }
}

export class WorkspaceLeaf {}

export class App {
  vault = {
    adapter: {
      exists: async () => false,
      readBinary: async () => new ArrayBuffer(0),
      writeBinary: async () => {},
      mkdir: async () => {},
    },
    getMarkdownFiles: () => [] as TFile[],
    getFileByPath: () => null,
    getAbstractFileByPath: () => null,
    configDir: ".obsidian",
  };
  workspace = {
    containerEl: { createDiv: () => ({ createDiv: () => ({}), createEl: () => ({}), addEventListener: () => {} }) },
    detachLeavesOfType: () => {},
    getLeavesOfType: () => [],
    onLayoutReady: (cb: () => void) => { cb(); return { id: 0 }; },
    revealLeaf: () => {},
  };
  metadataCache = {
    getFileCache: () => null,
    on: () => { return { id: 0 }; },
  };
  fileManager = {
    processFrontMatter: async () => {},
  };
}

export class Plugin {
  app: App;
  manifest = { id: "cortex", name: "Cortex", version: "0.0.0", minAppVersion: "0.0.0", description: "", isDesktopOnly: false };
  constructor(app: App) { this.app = app; }
  async loadData() { return null; }
  async saveData() {}
  addCommand() {}
  addSettingTab() {}
  addRibbonIcon() {}
  registerView() {}
  registerEvent() { return { id: 0 }; }
  registerDomEvent() { return { id: 0 }; }
  registerInterval() { return { id: 0 }; }
}

export class PluginSettingTab {
  app: App;
  plugin: unknown;
  containerEl: { empty: () => void; createEl: () => HTMLElement; createDiv: () => HTMLElement; querySelector: () => unknown };
  constructor(app: App, plugin: unknown) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = {
      empty: () => {},
      createEl: () => document.createElement("div"),
      createDiv: () => document.createElement("div"),
      querySelector: () => null,
    };
  }
  display() {}
}

export class Setting {
  setName() { return this; }
  setDesc() { return this; }
  addText(cb: (text: { setPlaceholder: () => unknown; setValue: () => unknown; onChange: () => unknown; inputEl: { rows?: number } }) => unknown) { cb({ setPlaceholder: () => undefined, setValue: () => undefined, onChange: () => undefined, inputEl: {} }); return this; }
  addTextArea(cb: (text: { setPlaceholder: () => unknown; setValue: () => unknown; onChange: () => unknown }) => unknown) { cb({ setPlaceholder: () => undefined, setValue: () => undefined, onChange: () => undefined }); return this; }
  addDropdown(cb: (d: { addOption: () => unknown; setValue: () => unknown; onChange: () => unknown }) => unknown) { cb({ addOption: () => undefined, setValue: () => undefined, onChange: () => undefined }); return this; }
  addToggle(cb: (t: { setValue: () => unknown; onChange: () => unknown }) => unknown) { cb({ setValue: () => undefined, onChange: () => undefined }); return this; }
  addSlider(cb: (s: { setLimits: () => unknown; setValue: () => unknown; setDynamicTooltip: () => unknown; onChange: () => unknown }) => unknown) { cb({ setLimits: () => undefined, setValue: () => undefined, setDynamicTooltip: () => undefined, onChange: () => undefined }); return this; }
  addButton(cb: (b: { setButtonText: () => unknown; setWarning: () => unknown; setCta: () => unknown; onClick: () => unknown }) => unknown) { cb({ setButtonText: () => undefined, setWarning: () => undefined, setCta: () => undefined, onClick: () => undefined }); return this; }
}

export class Notice {
  constructor(_msg: unknown) {}
}

export const Platform = { isMobile: false };

export class Modal {
  app: unknown;
  modalEl: HTMLElement;
  contentEl: HTMLElement;
  constructor(app: unknown) {
    this.app = app;
    this.modalEl = document.createElement("div");
    this.contentEl = document.createElement("div");
  }
  open() {}
  close() {}
  setTitle(_t: string) {}
}

/**
 * Minimal stub of Obsidian's `FuzzySuggestModal`. Tests don't
 * exercise the actual fuzzy-search behaviour; they just need
 * the class to be importable so `SaveFlashcardsModal` (and any
 * other module that references it) can load under vitest.
 *
 * Subclasses override `getItems`, `getItemText`, and
 * `onChooseItem` to plug in real behaviour. The shim's no-op
 * defaults let the class be instantiated without throwing.
 */
export class FuzzySuggestModal<T> {
  app: unknown;
  constructor(app: unknown) {
    this.app = app;
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  setPlaceholder(_p: string) { return this; }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  setInstructions(_i: Array<{ command: string; purpose: string }>) { return this; }
  getItems(): T[] { return []; }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getItemText(_item: T): string { return ""; }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onChooseItem(_item: T, _evt: MouseEvent | KeyboardEvent): void {}
  open() {}
  close() {}
}

export class ItemView {
  containerEl: { children: Array<HTMLElement> };
  constructor(_leaf: unknown) {
    this.containerEl = { children: [document.createElement("div"), document.createElement("div")] };
  }
  getViewType() { return ""; }
  getDisplayText() { return ""; }
  getIcon() { return ""; }
  registerEvent() { return { id: 0 }; }
}

export const moment = (input?: unknown) => ({
  diff: () => 0,
  startOf: () => ({ diff: () => 0 }),
  toISOString: () => "",
  format: () => "",
});

export function setIcon() {}

export async function requestUrl(_opts: unknown): Promise<{ json: unknown; status: number; text: string }> {
  return { json: {}, status: 200, text: "" };
}
