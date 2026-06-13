import { App, Notice, Platform, PluginSettingTab, Setting } from "obsidian";
import CortexPlugin from "./main";

// Re-export the pure data types from the dependency-free module so tests
// and other non-Obsidian code paths can import them without pulling in
// the full plugin runtime.
export type { CortexTest, CortexSettings } from "./settingsTypes";
export { DEFAULT_SETTINGS } from "./settingsTypes";
import type { CortexSettings } from "./settingsTypes";
import { DEFAULT_SETTINGS } from "./settingsTypes";

export class CortexSettingTab extends PluginSettingTab {
  plugin: CortexPlugin;

  constructor(app: App, plugin: CortexPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h3", { text: "Cortex" });
    containerEl.createEl("p", {
      text: "All review data is stored locally in each note's YAML frontmatter (confidence, interval, next_review).",
    });

    containerEl.createEl("h4", { text: "AI Scheduling" });
    containerEl.createEl("p", {
      text: "A Gemini API key is required for AI-powered scheduling suggestions. You can get one from Google AI Studio (https://aistudio.google.com/apikey).",
    });

    new Setting(containerEl)
      .setName("Gemini API key")
      .setDesc("API key for Google Gemini AI.")
      .addText((text) =>
        text
          .setPlaceholder("Enter your Gemini API key")
          .setValue(this.plugin.settings.geminiApiKey)
          .onChange(async (value) => {
            this.plugin.settings.geminiApiKey = value;
            await this.plugin.saveData(this.plugin.settings);
          })
      );

    new Setting(containerEl)
      .setName("Gemini model")
      .setDesc(
        "Select the Gemini model to use for AI scheduling. " +
        "Note: Some models may not be available on the free tier. Each model is subject to specific rate limits. " +
        "Generally, more efficient models (like Flash or Lite) allow for more frequent requests compared to Pro models."
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption("gemini-3.1-pro-preview", "3.1 Pro")
          .addOption("gemini-3.1-flash-lite-preview", "3.1 Flash Lite")
          .addOption("gemini-3-flash-preview", "3.0 Flash")
          .addOption("gemini-2.5-pro", "2.5 Pro")
          .addOption("gemini-2.5-flash", "2.5 Flash")
          .addOption("gemini-2.5-flash-lite", "2.5 Flash Lite")
          .setValue(this.plugin.settings.geminiModel)
          .onChange(async (value) => {
            this.plugin.settings.geminiModel = value;
            await this.plugin.saveData(this.plugin.settings);
          })
      );

    new Setting(containerEl)
      .setName("Planning preferences")
      .setDesc(
        "Add your daily schedule rules, e.g., 'no studying after 8 PM, take 15m breaks between sessions, prefer mornings for math'. The AI will strictly follow these rules when generating study plans.",
      )
      .addTextArea((text) =>
        text
          .setPlaceholder("e.g., No studying after 8 PM\nTake 15-minute breaks between sessions\nPrefer mornings for math")
          .setValue(this.plugin.settings.planningPreferences)
          .onChange(async (value) => {
            this.plugin.settings.planningPreferences = value;
            await this.plugin.saveData(this.plugin.settings);
          })
      );

    const prefTextArea = containerEl.querySelector("textarea") as HTMLTextAreaElement | null;
    if (prefTextArea) {
      prefTextArea.rows = 4;
    }
    
    new Setting(containerEl)
      .setName("Timezone")
      .setDesc("The IANA timezone name (e.g., Europe/Prague) used for calendar events and AI context.")
      .addText((text) =>
        text
          .setPlaceholder("e.g., Europe/Prague")
          .setValue(this.plugin.settings.timeZone)
          .onChange(async (value) => {
            this.plugin.settings.timeZone = value;
            await this.plugin.saveData(this.plugin.settings);
          })
      );
    
    // Daily Routine section
    containerEl.createEl("h4", { text: "Daily Routine" });
    
    new Setting(containerEl)
      .setName("Wake Up Time")
      .setDesc("Your usual wake up time (e.g., 07:00)")
      .addText((text) =>
        text
          .setPlaceholder("07:00")
          .setValue(this.plugin.settings.wakeUpTime)
          .onChange(async (value) => {
            this.plugin.settings.wakeUpTime = value;
            await this.plugin.saveData(this.plugin.settings);
          })
      );
      
    new Setting(containerEl)
      .setName("Bed Time")
      .setDesc("Your usual bed time (e.g., 23:00)")
      .addText((text) =>
        text
          .setPlaceholder("23:00")
          .setValue(this.plugin.settings.bedTime)
          .onChange(async (value) => {
            this.plugin.settings.bedTime = value;
            await this.plugin.saveData(this.plugin.settings);
          })
      );
      
    // Review load balancing section
    containerEl.createEl("h4", { text: "Review scheduling" });

    const clampDailyLimit = (value: number): number => {
      return Math.max(1, Math.min(20, value));
    };

    new Setting(containerEl)
      .setName("Max reviews per day")
      .setDesc("Maximum scheduled reviews for one day (1-20). Leave empty for no limit.")
      .addText((text) =>
        text
          .setPlaceholder("No limit")
          .setValue(
            this.plugin.settings.dailyLimitMax === null
              ? ""
              : String(this.plugin.settings.dailyLimitMax)
          )
          .onChange(async (value) => {
            const trimmed = value.trim();
            if (trimmed === "") {
              this.plugin.settings.dailyLimitMax = null;
              await this.plugin.saveData(this.plugin.settings);
              return;
            }

            const parsed = Number.parseInt(trimmed, 10);
            if (Number.isNaN(parsed)) return;

            this.plugin.settings.dailyLimitMax = clampDailyLimit(parsed);
            await this.plugin.saveData(this.plugin.settings);
          })
      );

    const clampMaxReviewInterval = (value: number): number => {
      return Math.max(1, Math.min(365, value));
    };

    new Setting(containerEl)
      .setName("Maximum interval between reviews (days)")
      .setDesc("Optional. Leave empty for no maximum.")
      .addText((text) =>
        text
          .setPlaceholder("empty = no limit")
          .setValue(
            this.plugin.settings.maxReviewIntervalDays === null
              ? ""
              : String(this.plugin.settings.maxReviewIntervalDays)
          )
          .onChange(async (value) => {
            const trimmed = value.trim();
            if (trimmed === "") {
              this.plugin.settings.maxReviewIntervalDays = null;
              await this.plugin.saveData(this.plugin.settings);
              return;
            }

            const parsed = Number.parseInt(trimmed, 10);
            if (Number.isNaN(parsed)) {
              return;
            }

            this.plugin.settings.maxReviewIntervalDays =
              clampMaxReviewInterval(parsed);
            await this.plugin.saveData(this.plugin.settings);
          })
      );

    // Google Calendar section
    containerEl.createEl("h4", { text: "Google Calendar" });
    containerEl.createEl("p", {
      text: "Google Calendar is connected from the Dashboard. If you encounter permission errors, disconnect and re-authenticate with the correct scopes.",
    });

    new Setting(containerEl)
      .setName("Disconnect Google Calendar")
      .setDesc("Remove stored Google OAuth tokens. You will need to re-authenticate on the Dashboard.")
      .addButton((button) =>
        button
          .setButtonText("Disconnect")
          .setWarning()
          .onClick(async () => {
            this.plugin.settings.googleAccessToken = "";
            this.plugin.settings.googleRefreshToken = "";
            this.plugin.settings.googleTokenExpiry = 0;
            await this.plugin.saveData(this.plugin.settings);
            new Notice("Google Calendar disconnected. Please re-authenticate on the Dashboard.");
            this.display();
          })
      );

    if (!Platform.isMobile) {
    containerEl.createEl("h3", { text: "Focus Detection" });
    containerEl.createEl("p", {
      text: "Two independent detection methods that warn you when you get distracted: Bluetooth proximity (phone in hand) and webcam face tracking. Each can be enabled and configured separately; both run locally — nothing is recorded or sent anywhere.",
    });

    containerEl.createEl("h4", { text: "Phone detection (Bluetooth)" });

    new Setting(containerEl)
      .setName("Enable phone detection")
      .setDesc("Detect when your phone is in your hand using its Bluetooth signal strength. Requires a selected and calibrated device below.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.detection?.isBleOn() ?? false)
          .onChange(async () => {
            await this.plugin.detection?.toggleBle();
            // Re-render so the toggle reflects the real state if start failed
            this.display();
          })
      );

    new Setting(containerEl)
      .setName("Bluetooth device")
      .setDesc(this.plugin.settings.bleDeviceName
        ? `Currently: ${this.plugin.settings.bleDeviceName}`
        : "No device selected. Scan for nearby Bluetooth devices and pick your phone.")
      .addButton((button) =>
        button
          .setButtonText(this.plugin.settings.bleDeviceName ? "Change device" : "Select device")
          .setCta()
          .onClick(() => {
            this.plugin.openBleDevicePicker();
          })
      );

    new Setting(containerEl)
      .setName("Calibrate")
      .setDesc("Calibrate by holding your phone in hand. Cortex will learn the Bluetooth signal and detect when you're using it.")
      .addButton((button) =>
        button
          .setButtonText("Calibrate")
          .setCta()
          .onClick(() => {
            this.plugin.openBleCalibration();
          })
      );

    containerEl.createEl("h4", { text: "Face tracking (webcam)" });

    new Setting(containerEl)
      .setName("Enable face tracking")
      .setDesc("Detect when you look away from the screen, blink excessively, or fidget. The first start downloads the detection model (~15 MB, cached afterwards).")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.faceEnabled)
          .onChange(async () => {
            await this.plugin.detection?.toggleFace();
            this.display();
          })
      );

    new Setting(containerEl)
      .setName("Sample interval (seconds)")
      .setDesc("How often to check your face (3-30s). Lower = more responsive but more CPU usage. Changes apply the next time face tracking is turned on.")
      .addSlider((slider) =>
        slider
          .setLimits(3, 30, 1)
          .setValue(this.plugin.settings.faceSampleIntervalSec)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.faceSampleIntervalSec = value;
            await this.plugin.saveData(this.plugin.settings);
          })
      );

    new Setting(containerEl)
      .setName("Blink threshold")
      .setDesc("Eye openness below which eyes are considered closed (lower = stricter).")
      .addSlider((slider) =>
        slider
          .setLimits(0.1, 0.5, 0.05)
          .setValue(this.plugin.settings.faceBlinkThreshold)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.faceBlinkThreshold = value;
            await this.plugin.saveData(this.plugin.settings);
          })
      );

    const pitchLabel = (v: number) => `${v.toFixed(2)} rad`;
    new Setting(containerEl)
      .setName("Head pitch threshold (radians)")
      .setDesc("How far down your head needs to tilt to count as 'looking away'. -0.08 = slight tilt. -0.15 = clearly looking at desk.")
      .addSlider((slider) =>
        slider
          .setLimits(-0.2, 0, 0.01)
          .setValue(this.plugin.settings.facePitchThreshold)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.facePitchThreshold = value;
            await this.plugin.saveData(this.plugin.settings);
          })
      );

    new Setting(containerEl)
      .setName("Grace period (seconds)")
      .setDesc("If your face briefly disappears (e.g., you turn away), how long to preserve the last state before resetting (0-5s).")
      .addSlider((slider) =>
        slider
          .setLimits(0, 5, 0.5)
          .setValue(this.plugin.settings.faceGracePeriodSec)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.faceGracePeriodSec = value;
            await this.plugin.saveData(this.plugin.settings);
          })
      );
  }
  }
}
