import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import CortexPlugin from "./main";

export interface CortexTest {
  id: string;
  name: string;
  date: string; // ISO date string
  filePaths: string[];
}

export interface CortexSettings {
  geminiApiKey: string;
  geminiModel: string;
  planningPreferences: string;
  timeZone: string;
  googleAccessToken: string;
  googleRefreshToken: string;
  googleTokenExpiry: number;
  tests: CortexTest[];
  wakeUpTime: string;
  bedTime: string;
  mealTimes: string;
}

export const DEFAULT_SETTINGS: CortexSettings = {
  geminiApiKey: "",
  geminiModel: "gemini-2.5-flash",
  planningPreferences: "",
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  googleAccessToken: "",
  googleRefreshToken: "",
  googleTokenExpiry: 0,
  tests: [],
  wakeUpTime: "07:00",
  bedTime: "23:00",
  mealTimes: "Lunch 12:00-13:00",
};

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
      
    new Setting(containerEl)
      .setName("Meal Times")
      .setDesc("Your usual meal times (e.g., Lunch 12:00-13:00)")
      .addText((text) =>
        text
          .setPlaceholder("Lunch 12:00-13:00")
          .setValue(this.plugin.settings.mealTimes)
          .onChange(async (value) => {
            this.plugin.settings.mealTimes = value;
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
  }
}
