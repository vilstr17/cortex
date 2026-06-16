/**
 * Vitest setup — provides a JS shim for the `obsidian` package.
 *
 * The real `obsidian` npm package is a type-only stub (its package.json
 * has an empty `main` field). At test time, importing modules that
 * `import { requestUrl, App, ... } from "obsidian"` fails because
 * there's no runtime to resolve to. We install a minimal stub
 * interface in the global module registry before any source file is
 * loaded. The vi.mock() calls inside individual test files then layer
 * behaviour on top of these stubs.
 *
 * The build-flag globals (INCLUDE_FOCUS / INCLUDE_BLE) are normally
 * injected by esbuild's `define` at bundle time. Tests run on raw
 * source via Vitest's transformer, so we declare them on `globalThis`
 * to match the build-time behaviour. The with-focus build is the
 * test default — the catalog build is verified end-to-end by the
 * build script, not the test suite.
 */
import { vi } from "vitest";

(globalThis as unknown as { INCLUDE_FOCUS: boolean }).INCLUDE_FOCUS = true;
(globalThis as unknown as { INCLUDE_BLE: boolean }).INCLUDE_BLE = true;

// Minimal DOM stub for tests that instantiate Obsidian UI classes.
// Real browser APIs are unavailable in the default Node test environment,
// but modals/views need document.createElement and a handful of element
// helpers. The stub is intentionally small; it covers what CortexChatModal
// and related views use at test time.
class FakeElement {
  children: FakeElement[] = [];
  classes = new Set<string>();
  style: Record<string, string | number> = {};
  text = "";
  disabled = false;
  value = "";
  scrollTop = 0;
  scrollHeight = 0;
  title = "";
  placeholder = "";
  rows = 1;

  empty() {
    this.children = [];
    this.text = "";
  }
  createDiv(options?: { cls?: string }): FakeElement {
    const el = new FakeElement();
    if (options?.cls) el.addClasses(options.cls.split(/\s+/));
    this.children.push(el);
    return el;
  }
  createEl(tag: string, options?: { cls?: string; attr?: Record<string, string>; text?: string }): FakeElement {
    const el = tag === "textarea" ? new FakeTextArea() : new FakeElement();
    if (options?.cls) el.addClasses(options.cls.split(/\s+/));
    if (options?.attr) {
      for (const [k, v] of Object.entries(options.attr)) {
        (el as unknown as Record<string, string>)[k] = v;
      }
    }
    if (options?.text) el.setText(options.text);
    this.children.push(el);
    return el;
  }
  addClasses(classes: string[]) {
    for (const c of classes) this.classes.add(c);
  }
  setText(text: string) {
    this.text = text;
  }
  setAttr(name: string, value: string) {
    (this as unknown as Record<string, string>)[name] = value;
  }
  addEventListener() {}
  querySelector(): FakeElement | null {
    return null;
  }
  remove() {}
  appendChild(child: FakeElement) {
    this.children.push(child);
  }
  setAttribute() {}
}

class FakeTextArea extends FakeElement {
  value = "";
  placeholder = "";
  rows = 1;
}

(globalThis as unknown as { document: typeof document }).document = {
  createElement(tag: string) {
    return tag === "textarea" ? new FakeTextArea() : new FakeElement();
  },
  querySelector() {
    return null;
  },
} as unknown as typeof document;

vi.mock("obsidian", () => {
  return {
    requestUrl: vi.fn(),
    App: class {},
    Plugin: class {},
    PluginSettingTab: class {},
    Setting: class {
      setName() { return this; }
      setDesc() { return this; }
      addText() { return this; }
      addTextArea() { return this; }
      addDropdown() { return this; }
      addToggle() { return this; }
      addSlider() { return this; }
      addButton() { return this; }
    },
    MarkdownRenderer: class {
      static async render(_app: unknown, markdown: string, el: HTMLElement) {
        el.setText(markdown);
      }
      static async renderMarkdown(markdown: string, el: HTMLElement) {
        el.setText(markdown);
      }
    },
    Notice: class { constructor(_msg: unknown) {} },
    Platform: { isMobile: false },
    TFile: class {},
    WorkspaceLeaf: class {},
    Modal: class {
      app: unknown;
      modalEl: HTMLElement;
      contentEl: HTMLElement;
      constructor(app: unknown) { this.app = app; this.modalEl = document.createElement("div"); this.contentEl = document.createElement("div"); }
      open() {}
      close() {}
      setTitle() {}
    },
    /**
     * Minimal stub of `FuzzySuggestModal`. Tests don't exercise
     * the actual fuzzy-search behaviour — the only requirement
     * is that the class exists so `SaveFlashcardsModal` and
     * other modules that import it can load.
     */
    FuzzySuggestModal: class {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      app: any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      constructor(app: any) { this.app = app; }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setPlaceholder(_p: string) { return this; }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setInstructions(_i: Array<{ command: string; purpose: string }>) { return this; }
      getItems(): unknown[] { return []; }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getItemText(_item: unknown): string { return ""; }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onChooseItem(_item: unknown, _evt: MouseEvent | KeyboardEvent): void {}
      open() {}
      close() {}
    },
    ItemView: class {
      containerEl: { children: Array<HTMLElement> };
      constructor(_leaf: unknown) { this.containerEl = { children: [document.createElement("div"), document.createElement("div")] }; }
      getViewType() { return ""; }
      getDisplayText() { return ""; }
      getIcon() { return ""; }
      registerEvent() {}
    },
    moment: (input?: unknown) => ({
      diff: () => 0,
      startOf: () => ({ diff: () => 0 }),
      toISOString: () => "",
    }),
    setIcon: () => {},
  };
});
