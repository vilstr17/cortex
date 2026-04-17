import { Plugin, WorkspaceLeaf } from "obsidian";
import Commands from "./commands";
import {
  CortexDashboardView,
  CORTEX_DASHBOARD_VIEW,
} from "./views/CortexDashboardView";
import { CortexSettings, DEFAULT_SETTINGS, CortexSettingTab } from "./settings";

export type { CortexSettings };
export { DEFAULT_SETTINGS };

export default class CortexPlugin extends Plugin {
  settings: CortexSettings = DEFAULT_SETTINGS;
  commands!: Commands;

  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

    // Safety: ensure tests array is always initialized
    if (!Array.isArray(this.settings.tests)) {
      this.settings.tests = [];
    }

    // Register the dashboard view
    this.registerView(
      CORTEX_DASHBOARD_VIEW,
      (leaf) => new CortexDashboardView(leaf, this),
    );

    // Add ribbon icon to open the dashboard
    this.addRibbonIcon("brain", "Open Cortex Dashboard", () => {
      this.openDashboard();
    });

    // Register command to open dashboard
    this.addCommand({
      id: "open-cortex-dashboard",
      name: "Open Cortex Dashboard",
      callback: () => this.openDashboard(),
    });

    this.commands = new Commands(this);
    this.commands.addCommands();

    this.addSettingTab(new CortexSettingTab(this.app, this));
  }

  async onunload(): Promise<void> {
    this.app.workspace.detachLeavesOfType(CORTEX_DASHBOARD_VIEW);
  }

  async openDashboard() {
    const { workspace } = this.app;
    const existingLeaves = workspace.getLeavesOfType(CORTEX_DASHBOARD_VIEW);

    if (existingLeaves.length > 0) {
      workspace.revealLeaf(existingLeaves[0]);
      return;
    }

    // Open in a new leaf in the left sidebar
    const leaf = workspace.getLeftLeaf(false);
    if (leaf) {
      await leaf.setViewState({ type: CORTEX_DASHBOARD_VIEW });
      workspace.revealLeaf(leaf);
    }
  }
}
