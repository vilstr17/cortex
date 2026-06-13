import { requestUrl } from "obsidian";
import type { ChildProcess } from "child_process";
import type CortexPlugin from "../main";
import type { BleStatus, BleFocusState, BleCalibration, BleDevice } from "./types";
import { classifyRssi } from "./types";

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBleDevice(value: unknown): value is BleDevice {
	if (!isPlainObject(value)) return false;
	return (
		typeof value.uuid === "string" &&
		typeof value.name === "string" &&
		typeof value.rssi === "number"
	);
}

const POLL_INTERVAL_MS = 1000;
const CONFIRMATION_COUNT = 2;
const STALE_THRESHOLD_MS = 5000;
const RECONNECT_DELAY_MS = 3000;
const MAX_TOTAL_RECONNECT_ATTEMPTS = 5;
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
	private child: ChildProcess | null = null;
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
	private isLaunching = false;
	private launchPromise: Promise<boolean> | null = null;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private reconnectGeneration = 0;
	private manualKill = false;
	lastError: string | null = null;

	constructor(plugin: CortexPlugin) {
		this.plugin = plugin;
	}

	private getScannerScriptPath(): string {
		const adapter = this.plugin.app.vault.adapter as unknown as Record<string, unknown>;
		const vaultPath = typeof adapter.getBasePath === "function" ? (adapter.getBasePath as () => string)() : "";
		if (!vaultPath) {
			console.error("[ble-detector] Could not determine vault path");
		}
		return vaultPath + "/.obsidian/plugins/cortex/ble-scanner.cjs";
	}

	private findNodeBinary(): string | null {
		try {
			const fs = require("fs");
			const path = require("path");
			const candidates = [...NODE_BIN_CANDIDATES, process.execPath];
			for (const candidate of candidates) {
				if (!candidate) continue;
				const base = path.basename(candidate).toLowerCase();
				if (!base.includes("node")) continue;
				if (fs.existsSync(candidate)) return candidate;
			}
		} catch {}
		try {
			const { execSync } = require("child_process");
			const cmd = process.platform === "win32" ? "where node" : "which node";
			const result = execSync(cmd, { encoding: "utf8", timeout: 5000 }).trim();
			if (result) {
				const first = result.split("\n")[0].trim();
				if (first) return first;
			}
		} catch {}
		return null;
	}

	isIntendedActive(): boolean {
		return this.intendedActive;
	}

	/** Public entry point — resets the reconnect budget. */
	async start(): Promise<boolean> {
		if (this.child) return true;
		if (this.isLaunching && this.launchPromise) return this.launchPromise;
		const hadReconnectTimer = !!this.reconnectTimer;
		this.clearReconnectTimer();
		if (!hadReconnectTimer) {
			this.reconnectAttempts = 0;
		}
		this.reconnectGeneration++;
		const ok = await this.launch();
		if (!ok && !hadReconnectTimer) {
			this.lastError = this.lastError ?? "BLE detection failed to start";
			this.stop();
		}
		return ok;
	}

	private async launch(): Promise<boolean> {
		if (this.child) return true;
		if (this.isLaunching && this.launchPromise) return this.launchPromise;
		this.isLaunching = true;
		this.stopped = false;
		this.intendedActive = true;
		this.launchPromise = this.doLaunch();
		try {
			return await this.launchPromise;
		} finally {
			this.isLaunching = false;
			this.launchPromise = null;
		}
	}

	/**
	 * Kill any process still listening on the scanner port — e.g. an
	 * orphaned scanner from a previous Obsidian session (crash/force-quit).
	 * A stale listener makes every new scanner die with EADDRINUSE.
	 */
	private async cleanupStalePort(): Promise<void> {
		if (process.platform !== "darwin" && process.platform !== "linux") return;
		try {
			const { execFile } = require("child_process");
			const stdout: string = await new Promise((resolve) => {
				execFile(
					"/usr/sbin/lsof",
					["-ti", "tcp:18888", "-sTCP:LISTEN"],
					{ timeout: 4000 },
					(_err: unknown, out: string) => resolve(String(out ?? ""))
				);
			});
			const pids = stdout.split("\n").map((s) => s.trim()).filter(Boolean);
			let killed = false;
			for (const pidStr of pids) {
				const pid = Number(pidStr);
				if (!Number.isFinite(pid) || pid <= 1) continue;
				if (this.child?.pid === pid) continue;
				console.log(`[ble-detector] Killing stale scanner (pid ${pid}) holding port 18888`);
				try {
					process.kill(pid, "SIGKILL");
					killed = true;
				} catch {}
			}
			if (killed) await new Promise(r => setTimeout(r, 400));
		} catch (e) {
			console.warn("[ble-detector] Stale port cleanup failed:", e);
		}
	}

	private async doLaunch(): Promise<boolean> {
		const nodeBin = this.findNodeBinary();
		if (!nodeBin) {
			this.lastError = "Node.js not found. Install Node.js (e.g. via Homebrew) to use BLE detection.";
			console.error("[ble-detector] " + this.lastError);
			return false;
		}

		await this.cleanupStalePort();

		try {
			const { spawn } = require("child_process");
			const path = require("path");
			// stdin is piped so the scanner can detect Obsidian's death (pipe
			// closes) and exit instead of orphaning itself on the port.
			this.child = spawn(nodeBin, [this.getScannerScriptPath()], {
				stdio: ["pipe", "pipe", "pipe"],
				env: { ...process.env, NODE_PATH: NODE_MODULE_PATHS.join(path.delimiter) },
			});

			const child = this.child;
			if (!child) {
				this.lastError = "Failed to spawn BLE scanner";
				return false;
			}

			child.stdout?.on("data", (data: Buffer) => {
				console.log("[ble-detector] scanner:", data.toString().trim());
			});
			child.stderr?.on("data", (data: Buffer) => {
				console.error("[ble-detector] scanner err:", data.toString().trim());
			});
			child.on("exit", (code: number | null) => {
				console.log(`[ble-detector] scanner exited with code ${code}`);
				this.child = null;
				this.latestStatus.phoneFound = false;
				this.latestStatus.scanning = false;
				if (this.manualKill) {
					this.manualKill = false;
					return;
				}
				this.attemptReconnect();
			});
			child.on("error", (err: Error) => {
				console.error("[ble-detector] scanner spawn error:", err.message);
				this.child = null;
			});

			await new Promise(r => setTimeout(r, 500));

			const health = await this.waitForBleReady();
			if (!health) {
				this.lastError = "Bluetooth not available. Make sure Bluetooth is on and Obsidian has access in System Settings → Privacy & Security → Bluetooth.";
				console.error("[ble-detector] " + this.lastError);
				if (this.child) {
					try {
						this.manualKill = true;
						this.child.kill("SIGTERM");
					} catch (_) {}
					this.child = null;
				}
				return false;
			}

			const deviceName = this.plugin.settings.bleDeviceName;
			if (deviceName) {
				await this.fetchApi("/start", { name: deviceName });
				this.latestStatus.scanning = true;
			}

			this.startPolling();
			this.transitionTo("NO_PHONE");
			this.lastError = null;
			return true;
		} catch (e) {
			this.lastError = "Failed to start BLE scanner: " + (e instanceof Error ? e.message : String(e));
			console.error("[ble-detector] " + this.lastError);
			return false;
		}
	}

	private async attemptReconnect(): Promise<void> {
		if (this.stopped) return;
		if (this.reconnectAttempts >= MAX_TOTAL_RECONNECT_ATTEMPTS) {
			this.lastError = "Max reconnect attempts reached. BLE detection has stopped.";
			console.error("[ble-detector] " + this.lastError);
			this.transitionTo("NO_PHONE");
			return;
		}

		this.reconnectAttempts++;
		const generation = this.reconnectGeneration;
		const delay = RECONNECT_DELAY_MS * this.reconnectAttempts;
		console.log(`[ble-detector] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${MAX_TOTAL_RECONNECT_ATTEMPTS})`);

		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			if (this.stopped) return;
			if (generation !== this.reconnectGeneration) return;
			this.launch().then((ok) => {
				if (!ok && !this.stopped) {
					this.attemptReconnect();
				}
			});
		}, delay);
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
		this.reconnectGeneration++;
		this.clearReconnectTimer();
		this.isLaunching = false;
		this.launchPromise = null;
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

	getLastError(): string | null {
		return this.lastError;
	}

	private clearReconnectTimer(): void {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
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
			return res && isPlainObject(res.json) ? res.json : null;
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
			rawRssi: typeof status.rawRssi === "number" ? status.rawRssi : null,
			smoothedRssi: typeof status.smoothedRssi === "number" ? status.smoothedRssi : null,
			phoneFound: typeof status.phoneFound === "boolean" ? status.phoneFound : false,
			lastSeen: typeof status.lastSeen === "number" ? status.lastSeen : 0,
			scanning: typeof status.scanning === "boolean" ? status.scanning : false,
			deviceName: typeof status.deviceName === "string" ? status.deviceName : null,
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
		const running = await this.ensureRunning();
		if (!running) {
			this.lastError = this.lastError ?? "BLE scanner is not running";
			return [];
		}
		const duration = 8;
		const result = await this.fetchApi("/discover", { duration }, duration * 1000 + 5000);
		if (result && Array.isArray(result.devices)) {
			return result.devices.filter(isBleDevice);
		}
		return [];
	}

	async ensureRunning(): Promise<boolean> {
		if (this.child) return true;
		if (this.isLaunching && this.launchPromise) {
			return await this.launchPromise;
		}
		if (this.reconnectTimer) {
			return false;
		}
		return await this.start();
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