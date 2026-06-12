import { Plugin, Notice, Platform } from "obsidian";
import Commands from "./commands";
import {
  CortexDashboardView,
  CORTEX_DASHBOARD_VIEW,
} from "./views/CortexDashboardView";
import { CortexSettings, DEFAULT_SETTINGS, CortexSettingTab } from "./settings";
import { DetectionManager } from "./detection/DetectionManager";
import { CalibrationModal } from "./ble/CalibrationModal";
import { BleDevicePickerModal } from "./ble/BleDevicePickerModal";
import type { BleFocusDetector } from "./ble/BleFocusDetector";
import type { FaceFocusEvaluator } from "./face/FaceFocusEvaluator";

export type { CortexSettings };
export { DEFAULT_SETTINGS };

export default class CortexPlugin extends Plugin {
  settings: CortexSettings = DEFAULT_SETTINGS;
  commands!: Commands;
  detection: DetectionManager | null = null;

  /** Convenience accessors for views/modals. */
  get bleDetector(): BleFocusDetector | null {
    return this.detection?.ble ?? null;
  }
  get faceEvaluator(): FaceFocusEvaluator | null {
    return this.detection?.face ?? null;
  }

  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

    if (!Array.isArray(this.settings.tests)) {
      this.settings.tests = [];
    }

    this.registerView(
      CORTEX_DASHBOARD_VIEW,
      (leaf) => new CortexDashboardView(leaf, this),
    );

    // Ensure any stale dashboard views from a previous plugin load are closed
    this.app.workspace.detachLeavesOfType(CORTEX_DASHBOARD_VIEW);

    if (!Platform.isMobile) {
      this.detection = new DetectionManager(this);
    }

    this.registerObsidianProtocolHandler("cortex-auth", async (params) => {
      if (params.access_token) {
        this.settings.googleAccessToken = params.access_token;
        if (params.refresh_token) {
          this.settings.googleRefreshToken = params.refresh_token;
        }
        if (params.expires_in) {
          this.settings.googleTokenExpiry = Date.now() + parseInt(params.expires_in, 10) * 1000;
        } else {
          this.settings.googleTokenExpiry = Date.now() + 3600 * 1000;
        }

        await this.saveData(this.settings);
        new Notice("Cortex: Google Calendar connected successfully!");
      } else if (params.error) {
        new Notice(`Cortex: Failed to connect Google Calendar: ${params.error}`);
      }
    });

    this.addRibbonIcon("brain", "Open Cortex Dashboard", () => {
      this.openDashboard();
    });

    this.addCommand({
      id: "open-cortex-dashboard",
      name: "Open Cortex Dashboard",
      callback: () => this.openDashboard(),
    });

    if (this.detection) {
      this.addCommand({
        id: "toggle-face-detection",
        name: "Toggle Face Detection",
        callback: () => this.detection?.toggleFace(),
      });

      this.addCommand({
        id: "toggle-ble-detection",
        name: "Toggle BLE Focus Detection",
        callback: () => this.detection?.toggleBle(),
      });

      this.addCommand({
        id: "select-ble-device",
        name: "Select Bluetooth device",
        callback: () => this.openBleDevicePicker(),
      });
    }

    this.commands = new Commands(this);
    this.commands.addCommands();

    this.addSettingTab(new CortexSettingTab(this.app, this));

    // Detectors start only after the workspace is ready so they never
    // compete with vault indexing / layout restore at startup.
    this.app.workspace.onLayoutReady(() => {
      window.setTimeout(() => {
        this.detection?.startEnabled();
      }, 1000);
    });
  }

  async onunload(): Promise<void> {
    this.app.workspace.detachLeavesOfType(CORTEX_DASHBOARD_VIEW);
    await this.detection?.destroy();
  }

  async openDashboard() {
    const { workspace } = this.app;
    const existingLeaves = workspace.getLeavesOfType(CORTEX_DASHBOARD_VIEW);

    if (existingLeaves.length > 0) {
      workspace.revealLeaf(existingLeaves[0]);
      return;
    }

    const leaf = workspace.getLeftLeaf(false);
    if (leaf) {
      await leaf.setViewState({ type: CORTEX_DASHBOARD_VIEW });
      workspace.revealLeaf(leaf);
    }
  }

  openBleCalibration(): void {
    if (!this.bleDetector) return;
    new CalibrationModal(this.app, this, this.bleDetector).open();
  }

  openBleDevicePicker(): void {
    if (!this.bleDetector) return;
    new BleDevicePickerModal(this.app, this, this.bleDetector).open();
  }
}
