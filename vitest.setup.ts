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
 */
import { vi } from "vitest";

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
