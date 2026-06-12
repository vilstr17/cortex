import { requestUrl } from "obsidian";
import type CortexPlugin from "../main";
import type { BleStatus, BleFocusState, BleCalibration, BleDevice } from "./types";
import { classifyRssi } from "./types";

const POLL_INTERVAL_MS = 1000;
const CONFIRMATION_COUNT = 2;
const STALE_THRESHOLD_MS = 5000;
const RECONNECT_DELAY_MS = 3000;
const MAX_RECONNECT_ATTEMPTS = 5;
const API_TIMEOUT_MS = 5000;
const NODE_BIN_CANDIDATES = [
	"/opt/homebrew/bin/node",
	"/usr/local/bin/node",
	"/usr/bin/node",
];
const NODE_MODULE_PATHS = [
	"/opt/homebrew/lib/node_modules",
	"/usr/local/lib/node_modules",
];

export type BleStateChangeCallback = (state: BleFocusState, previousState: BleFocusState) => void;

export class BleFocusDetector {
	private plugin: CortexPlugin;
	private child: any = null;
	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private currentState: BleFocusState = "DISABLED";
	private stateChangeCallbacks: BleStateChangeCallback[] = [];
	private consecutiveCount = 0;
	private consecutiveTarget: BleFocusState | null = null;
	private latestStatus: BleStatus = {
		rawRssi: null,
		smoothedRssi: null,
		phoneFound: false,
		lastSeen: 0,
		scanning: false,
		deviceName: null,
	};
	private calibrationReadings: number[] = [];
	private collectingCalibration = false;
	private calibrationResolve: ((readings: number[]) => void) | null = null;
	isWarningActive = false;
	private reconnectAttempts = 0;
	private stopped = false;
	private intendedActive = false;

	constructor(plugin: CortexPlugin) {
		this.plugin = plugin;
	}

	private getScannerScriptPath(): string {
		const vaultPath = (this.plugin.app.vault.adapter as any).getBasePath?.() ?? "";
		if (!vaultPath) {
			console.error("[ble-detector] Could not determine vault path");
		}
		return vaultPath + "/.obsidian/plugins/cortex/ble-scanner.cjs";
	}

	private findNodeBinary(): string | null {
		try {
			const fs = require("fs");
			for (const candidate of NODE_BIN_CANDIDATES) {
				if (fs.existsSync(candidate)) return candidate;
			}
		} catch {}
		return null;
	}

	isIntendedActive(): boolean {
		return this.intendedActive;
	}

	/** Public entry point — resets the reconnect budget. */
	async start(): Promise<boolean> {
		this.reconnectAttempts = 0;
		return this.launch();
	}

	private async launch(): Promise<boolean> {
		if (this.child) return true;
		this.stopped = false;
		this.intendedActive = true;

		const nodeBin = this.findNodeBinary();
		if (!nodeBin) {
			console.error("[ble-detector] No node binary found. Install Node.js (e.g. via Homebrew) to use BLE detection.");
			return false;
		}

		try {
			const { spawn } = require("child_process");
			this.child = spawn(nodeBin, [this.getScannerScriptPath()], {
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, NODE_PATH: NODE_MODULE_PATHS.join(":") },
			});

			this.child.stdout?.on("data", (data: any) => {
				console.log("[ble-detector] scanner:", data.toString().trim());
			});
			this.child.stderr?.on("data", (data: any) => {
				console.error("[ble-detector] scanner err:", data.toString().trim());
			});
			this.child.on("exit", (code: number | null) => {
				console.log(`[ble-detector] scanner exited with code ${code}`);
				this.child = null;
				this.latestStatus.phoneFound = false;
				this.latestStatus.scanning = false;
				this.attemptReconnect();
			});
			this.child.on("error", (err: Error) => {
				console.error("[ble-detector] scanner spawn error:", err.message);
				this.child = null;
			});

			await new Promise(r => setTimeout(r, 500));

			const health = await this.waitForBleReady();
			if (!health) {
				console.error("[ble-detector] Bluetooth not available after waiting");
				this.stop();
				return false;
			}

			const deviceName = this.plugin.settings.bleDeviceName;
			if (deviceName) {
				await this.fetchApi("/start", { name: deviceName });
				this.latestStatus.scanning = true;
			}

			this.startPolling();
			this.transitionTo("NO_PHONE");
			return true;
		} catch (e) {
			console.error("[ble-detector] Failed to start scanner:", e);
			return false;
		}
	}

	private async attemptReconnect(): Promise<void> {
		if (this.stopped) return;
		if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
			console.error("[ble-detector] Max reconnect attempts reached, giving up");
			this.transitionTo("NO_PHONE");
			return;
		}

		this.reconnectAttempts++;
		const delay = RECONNECT_DELAY_MS * this.reconnectAttempts;
		console.log(`[ble-detector] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
		await new Promise(r => setTimeout(r, delay));

		if (this.stopped) return;

		// launch() (not start()) so the reconnect budget isn't reset each attempt
		const ok = await this.launch();
		if (!ok && !this.stopped) {
			this.attemptReconnect();
		}
	}

	async startScanningByName(name: string): Promise<void> {
		const result = await this.fetchApi("/start", { name });
		if (result?.success) {
			this.latestStatus.scanning = true;
		}
	}

	stop(): void {
		this.stopped = true;
		this.intendedActive = false;
		this.reconnectAttempts = 0;
		this.stopPolling();
		this.cancelCalibration();

		this.fetchApi("/stop").catch(() => {});

		if (this.child) {
			this.child.kill("SIGTERM");
			this.child = null;
		}

		this.latestStatus.scanning = false;
		this.transitionTo("DISABLED");
		this.dismissWarning();
	}

	getLatestRSSI(): number | null {
		return this.latestStatus.smoothedRssi;
	}

	getRawRSSI(): number | null {
		return this.latestStatus.rawRssi;
	}

	getCurrentState(): BleFocusState {
		return this.currentState;
	}

	getLatestStatus(): BleStatus {
		return { ...this.latestStatus };
	}

	onStateChange(callback: BleStateChangeCallback): void {
		this.stateChangeCallbacks.push(callback);
	}

	isScanning(): boolean {
		return this.latestStatus.scanning;
	}

	dismissWarning(): void {
		this.isWarningActive = false;
		this.plugin.app.workspace.trigger("cortex-ble-warning-dismiss");
	}

	private async fetchApi(endpoint: string, body?: unknown, timeoutMs = API_TIMEOUT_MS): Promise<Record<string, unknown> | null> {
		try {
			const request = requestUrl({
				url: `http://127.0.0.1:18888${endpoint}`,
				method: body ? "POST" : "GET",
				headers: { "Content-Type": "application/json" },
				body: body ? JSON.stringify(body) : undefined,
			});
			// A wedged scanner process must never be able to hang the plugin.
			const timeout = new Promise<null>((_, reject) =>
				setTimeout(() => reject(new Error("BLE API timeout")), timeoutMs)
			);
			const res = await Promise.race([request, timeout]);
			return res ? (res.json as Record<string, unknown>) : null;
		} catch {
			return null;
		}
	}

	private startPolling(): void {
		this.stopPolling();
		this.pollTimer = setInterval(() => this.pollStatus(), POLL_INTERVAL_MS);
		this.pollStatus();
	}

	private stopPolling(): void {
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
	}

	private async pollStatus(): Promise<void> {
		const status = await this.fetchApi("/status");
		if (!status) return;

		this.latestStatus = {
			rawRssi: status.rawRssi as number | null,
			smoothedRssi: status.smoothedRssi as number | null,
			phoneFound: status.phoneFound as boolean,
			lastSeen: status.lastSeen as number,
			scanning: status.scanning as boolean,
			deviceName: status.deviceName as string | null,
		};

		if (this.collectingCalibration) {
			this.handleCalibrationReading();
			return;
		}

		if (this.latestStatus.smoothedRssi !== null && this.latestStatus.lastSeen > 0) {
			const age = Date.now() - this.latestStatus.lastSeen;
			if (age > STALE_THRESHOLD_MS) {
				this.latestStatus.smoothedRssi = null;
				this.latestStatus.phoneFound = false;
			}
		}

		const calibration = this.getActiveCalibration();
		const classified = classifyRssi(this.latestStatus.smoothedRssi, calibration);

		this.updateState(classified);
		this.plugin.app.workspace.trigger("cortex-ble-status-update");
	}

	private getActiveCalibration(): BleCalibration | null {
		return this.plugin.settings.bleCalibrationData;
	}

	private updateState(classified: BleFocusState): void {
		if (classified === this.consecutiveTarget) {
			this.consecutiveCount++;
		} else {
			this.consecutiveTarget = classified;
			this.consecutiveCount = 1;
		}

		if (this.consecutiveCount >= CONFIRMATION_COUNT && classified !== this.currentState) {
			this.transitionTo(classified);
		}
	}

	resetConfirmation(): void {
		this.consecutiveCount = 0;
		this.consecutiveTarget = null;
	}

	private transitionTo(newState: BleFocusState): void {
		if (newState === this.currentState) return;

		const previous = this.currentState;
		this.currentState = newState;

		for (const cb of this.stateChangeCallbacks) {
			cb(newState, previous);
		}

		this.consecutiveCount = 0;
		this.consecutiveTarget = null;
	}

	async startCalibrationCollection(): Promise<number[]> {
		if (!this.latestStatus.scanning) {
			const name = this.plugin.settings.bleDeviceName;
			if (name) {
				await this.fetchApi("/start", { name });
				this.latestStatus.scanning = true;
				await new Promise(r => setTimeout(r, 3000));
			}
		}

		this.collectingCalibration = true;
		this.calibrationReadings = [];
		this.dismissWarning();
		this.transitionTo("NO_PHONE");

		return new Promise((resolve) => {
			this.calibrationResolve = resolve;

			setTimeout(() => {
				if (this.collectingCalibration) {
					this.finishCalibrationCollection();
				}
			}, 10000);
		});
	}

	private handleCalibrationReading(): void {
		const rssi = this.latestStatus.smoothedRssi;
		if (rssi === null) return;

		this.calibrationReadings.push(rssi);
	}

	finishCalibrationCollection(): number[] {
		this.collectingCalibration = false;

		const readings = [...this.calibrationReadings];
		this.calibrationReadings = [];

		if (this.calibrationResolve) {
			this.calibrationResolve(readings);
			this.calibrationResolve = null;
		}

		return readings;
	}

	cancelCalibration(): void {
		this.collectingCalibration = false;
		this.calibrationReadings = [];

		if (this.calibrationResolve) {
			this.calibrationResolve([]);
			this.calibrationResolve = null;
		}
	}

	isCollectingCalibration(): boolean {
		return this.collectingCalibration;
	}

	async discoverDevices(): Promise<BleDevice[]> {
		await this.ensureRunning();
		const duration = 8;
		const result = await this.fetchApi("/discover", { duration }, duration * 1000 + 5000);
		if (result?.devices) {
			return result.devices as BleDevice[];
		}
		return [];
	}

	async ensureRunning(): Promise<boolean> {
		if (!this.child) {
			return await this.start();
		}
		return true;
	}

	private async waitForBleReady(): Promise<Record<string, unknown> | null> {
		const maxWaitMs = 8000;
		const pollIntervalMs = 500;
		const start = Date.now();

		while (Date.now() - start < maxWaitMs) {
			if (this.stopped) return null;

			const health = await this.fetchApi("/health");
			if (health && health.bleState === "poweredOn") {
				console.log("[ble-detector] Bluetooth ready");
				return health;
			}

			console.log(`[ble-detector] Waiting for Bluetooth... state=${health?.bleState ?? "null"}`);
			await new Promise(r => setTimeout(r, pollIntervalMs));
		}

		return null;
	}
}