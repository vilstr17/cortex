import { App, Modal, Notice } from "obsidian";
import type CortexPlugin from "../main";
import { BleFocusDetector } from "./BleFocusDetector";
import type { BleDevice } from "./types";

export class BleDevicePickerModal extends Modal {
	private plugin: CortexPlugin;
	private detector: BleFocusDetector;
	private contentArea!: HTMLElement;
	private scanning = false;

	constructor(app: App, plugin: CortexPlugin, detector: BleFocusDetector) {
		super(app);
		this.plugin = plugin;
		this.detector = detector;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("cortex-ble-device-picker-modal");

		this.contentArea = contentEl.createDiv({ cls: "cortex-ble-device-picker-body" });

		this.startScan();
	}

	onClose(): void {}

	private async startScan(): Promise<void> {
		if (this.scanning) return;
		this.scanning = true;

		this.contentArea.empty();
		this.contentArea.createEl("h2", { text: "Scanning for devices..." });

		this.contentArea.createEl("p", {
			text: "Make sure Bluetooth is on and your phone is nearby. Scanning for 8 seconds...",
			cls: "cortex-ble-device-picker-desc",
		});

		const progressBar = this.contentArea.createDiv({ cls: "cortex-ble-cal-progress" });
		const fill = progressBar.createDiv({ cls: "cortex-ble-cal-progress-fill" });
		fill.style.width = "0%";

		const progressStart = Date.now();
		const progressInterval = setInterval(() => {
			const elapsed = (Date.now() - progressStart) / 1000;
			fill.style.width = `${Math.min(100, (elapsed / 8) * 100)}%`;
		}, 100);

		try {
			const devices = await this.detector.discoverDevices();

			clearInterval(progressInterval);
			fill.style.width = "100%";
			this.scanning = false;

			this.renderDeviceList(devices);
		} catch {
			clearInterval(progressInterval);
			this.scanning = false;

			this.contentArea.empty();
			this.contentArea.createEl("h2", { text: "Scan failed" });
			this.contentArea.createEl("p", {
				text: "Could not scan for Bluetooth devices. Make sure Bluetooth is enabled on your Mac and Obsidian has Bluetooth access in System Settings → Privacy & Security → Bluetooth.",
				cls: "cortex-ble-device-picker-error",
			});

			const btnRow = this.contentArea.createDiv({ cls: "cortex-ble-device-picker-btn-row" });
			const retryBtn = btnRow.createEl("button", { text: "Retry", cls: "mod-cta" });
			retryBtn.addEventListener("click", () => this.startScan());
		}
	}

	private renderDeviceList(devices: BleDevice[]): void {
		this.contentArea.empty();

		this.contentArea.createEl("h2", { text: "Select your phone" });

		if (devices.length === 0) {
			this.contentArea.createEl("p", {
				text: "No Bluetooth devices found. Make sure Bluetooth is on and your phone is nearby.",
				cls: "cortex-ble-device-picker-error",
			});

			const btnRow = this.contentArea.createDiv({ cls: "cortex-ble-device-picker-btn-row" });
			const retryBtn = btnRow.createEl("button", { text: "Scan again", cls: "mod-cta" });
			retryBtn.addEventListener("click", () => this.startScan());
			return;
		}

		const currentDevice = this.plugin.settings.bleDeviceName;
		if (currentDevice) {
			const currentInfo = this.contentArea.createDiv({ cls: "cortex-ble-device-picker-current" });
			currentInfo.createSpan({ text: "Current: " });
			currentInfo.createSpan({ text: currentDevice, cls: "cortex-ble-device-picker-current-name" });
		}

		this.contentArea.createEl("p", {
			text: "Devices are sorted by signal strength (strongest first).",
			cls: "cortex-ble-device-picker-desc",
		});

		const list = this.contentArea.createDiv({ cls: "cortex-ble-device-list" });

		for (const d of devices) {
			const item = list.createDiv({ cls: "cortex-ble-device-item" });

			if (currentDevice && d.name && d.name.toLowerCase() === currentDevice.toLowerCase()) {
				item.addClass("cortex-ble-device-item-active");
			}

			const signalIcon = item.createSpan({ cls: "cortex-ble-device-signal" });
			const barCount = this.signalBars(d.rssi);
			for (let i = 0; i < 4; i++) {
				const bar = signalIcon.createSpan({ cls: "cortex-ble-signal-bar" });
				if (i < barCount) bar.addClass("cortex-ble-signal-active");
			}

			item.createSpan({
				text: `${d.rssi} dBm`,
				cls: "cortex-ble-device-rssi",
			});

			const info = item.createDiv({ cls: "cortex-ble-device-info" });
			info.createSpan({
				text: d.name || "Unknown device",
				cls: "cortex-ble-device-name",
			});
			info.createSpan({
				text: d.uuid,
				cls: "cortex-ble-device-uuid",
			});

			if (d.name) {
				item.addEventListener("click", async () => {
					await this.selectDevice(d);
				});
			} else {
				item.addClass("cortex-ble-device-item-disabled");
				item.setAttribute("title", "This device has no visible name and cannot be selected");
			}
		}

		const footer = this.contentArea.createDiv({ cls: "cortex-ble-device-picker-footer" });
		const rescanBtn = footer.createEl("button", { text: "Scan again" });
		rescanBtn.addEventListener("click", () => this.startScan());
	}

	private async selectDevice(device: BleDevice): Promise<void> {
		const deviceName = device.name;

		this.plugin.settings.bleDeviceName = deviceName;
		await this.plugin.saveData(this.plugin.settings);

		await this.detector.ensureRunning();
		await this.detector.startScanningByName(deviceName);

		if (!this.plugin.settings.bleEnabled) {
			this.plugin.settings.bleEnabled = true;
			await this.plugin.saveData(this.plugin.settings);
		}

		new Notice(`Bluetooth device set: ${deviceName}`);
		this.close();
	}

	private signalBars(rssi: number): number {
		if (rssi >= -40) return 4;
		if (rssi >= -55) return 3;
		if (rssi >= -70) return 2;
		return 1;
	}
}