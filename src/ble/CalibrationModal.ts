import { App, Modal, Notice } from "obsidian";
import type CortexPlugin from "../main";
import { BleFocusDetector } from "./BleFocusDetector";
import type { BleCalibration } from "./types";
import { computeCalibration } from "./types";

export class CalibrationModal extends Modal {
	private plugin: CortexPlugin;
	private detector: BleFocusDetector;
	private savedCalibration: BleCalibration | null = null;
	private contentArea!: HTMLElement;

	constructor(app: App, plugin: CortexPlugin, detector: BleFocusDetector) {
		super(app);
		this.plugin = plugin;
		this.detector = detector;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("cortex-ble-calibration-modal");

		this.contentArea = contentEl.createDiv({ cls: "cortex-ble-cal-body" });

		const existing = this.plugin.settings.bleDeviceName;
		this.showExplanation(existing);
	}

	onClose(): void {
		this.detector.finishCalibrationCollection();
	}

	private showExplanation(existingDevice: string): void {
		this.contentArea.empty();

		this.contentArea.createEl("h2", { text: "Focus Detection Setup" });

		const steps = this.contentArea.createDiv({ cls: "cortex-ble-cal-explanation" });

		if (!existingDevice) {
			steps.createEl("p", {
				text: "You need to select a Bluetooth device first. Close this and use the device picker.",
			});
			return;
		}

		steps.createEl("p", {
			text: `Cortex will learn the Bluetooth signal of your phone (${existingDevice}) when you're using it. Hold your phone normally and stay still during the 10-second scan.`,
		});

		steps.createEl("p", {
			text: "After calibration, Cortex will detect whenever your phone signal matches — meaning you're using it.",
		});

		const btnRow = this.contentArea.createDiv({ cls: "cortex-ble-cal-btn-row" });
		const startBtn = btnRow.createEl("button", {
			text: "Begin Calibration",
			cls: "mod-cta",
		});
		startBtn.addEventListener("click", () => this.runCalibration());
	}

	private async runCalibration(): Promise<void> {
		this.contentArea.empty();

		this.contentArea.createEl("h3", { text: "Hold your phone" });
		this.contentArea.createEl("p", {
			text: "Pick up your phone and hold it like you normally do when using it. Stay still.",
			cls: "cortex-ble-cal-instruction",
		});

		const countdownEl = this.contentArea.createEl("div", {
			text: "3",
			cls: "cortex-ble-cal-countdown",
		});

		await this.delay(1000);
		countdownEl.setText("2");
		await this.delay(1000);
		countdownEl.setText("1");
		await this.delay(1000);
		countdownEl.setText("GO");
		countdownEl.addClass("cortex-ble-cal-go");
		await this.delay(600);

		countdownEl.remove();

		const statusEl = this.contentArea.createEl("p", {
			text: "Scanning...",
			cls: "cortex-ble-cal-status",
		});

		const progressBar = this.contentArea.createDiv({ cls: "cortex-ble-cal-progress" });
		const fill = progressBar.createDiv({ cls: "cortex-ble-cal-progress-fill" });

		const progressStart = Date.now();
		const progressInterval = setInterval(() => {
			const elapsed = (Date.now() - progressStart) / 1000;
			fill.style.width = `${Math.min(100, (elapsed / 10) * 100)}%`;
		}, 100);

		const readings = await this.detector.startCalibrationCollection();

		clearInterval(progressInterval);
		fill.style.width = "100%";

		if (readings.length === 0) {
			this.contentArea.empty();
			this.contentArea.createEl("p", {
				text: "No readings captured. Make sure your phone is nearby and Bluetooth is on.",
				cls: "cortex-ble-cal-error",
			});
			const btnRow = this.contentArea.createDiv({ cls: "cortex-ble-cal-btn-row" });
			this.addBtn(btnRow, "Try again", () => this.runCalibration());
			return;
		}

		statusEl.setText("Done!");
		await this.delay(800);
		this.showResults(readings);
	}

	private showResults(readings: number[]): void {
		this.contentArea.empty();

		this.savedCalibration = computeCalibration(readings);

		if (!this.savedCalibration) {
			this.contentArea.createEl("p", {
				text: "Calibration failed — not enough data.",
				cls: "cortex-ble-cal-error",
			});
			return;
		}

		const cal = this.savedCalibration;

		this.contentArea.createEl("h3", { text: "Calibration complete" });

		const summary = this.contentArea.createDiv({ cls: "cortex-ble-cal-summary" });
		summary.createEl("p", { text: `Device: ${this.plugin.settings.bleDeviceName}` });
		summary.createEl("p", { text: `In-hand signal: ${cal.target_rssi} dBm` });
		summary.createEl("p", { text: `Detection range: ${Math.round(cal.target_rssi * (1 - cal.tolerance))} to ${Math.round(cal.target_rssi * (1 + cal.tolerance))} dBm` });

		const btnRow = this.contentArea.createDiv({ cls: "cortex-ble-cal-btn-row" });
		const saveBtn = btnRow.createEl("button", {
			text: "Save calibration",
			cls: "mod-cta",
		});
		saveBtn.addEventListener("click", async () => {
			await this.saveCalibration();
			new Notice("Calibration saved.");
			this.close();
		});

		const retryBtn = btnRow.createEl("button", {
			text: "Redo",
			cls: "cortex-ble-cal-btn",
		});
		retryBtn.addEventListener("click", () => this.runCalibration());
	}

	private async saveCalibration(): Promise<void> {
		if (!this.savedCalibration) return;

		const deviceName = this.plugin.settings.bleDeviceName;
		this.savedCalibration.device_name = deviceName;
		this.plugin.settings.bleCalibrationData = this.savedCalibration;

		await this.plugin.saveData(this.plugin.settings);
	}

	private addBtn(parent: HTMLElement, text: string, onClick: () => void): HTMLButtonElement {
		const btn = parent.createEl("button", {
			text,
			cls: "cortex-ble-cal-btn",
		});
		btn.addEventListener("click", onClick);
		return btn;
	}

	private delay(ms: number): Promise<void> {
		return new Promise(r => setTimeout(r, ms));
	}
}