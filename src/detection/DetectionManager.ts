import { Notice, Platform } from "obsidian";
import type CortexPlugin from "../main";
import { BleFocusDetector } from "../ble/BleFocusDetector";
import type { BleFocusState } from "../ble/types";
import { FaceFocusEvaluator } from "../face/FaceFocusEvaluator";
import type { FaceFocusState } from "../face/FaceFocusEvaluator";
import type { FaceAssetStore } from "../FaceDetector";

export type DetectionSource = "ble" | "face";

const WARNING_AUTO_DISMISS_MS = 15000;
const WARNING_COOLDOWN_MS = 15000;

const WARNING_CONTENT: Record<DetectionSource, { emoji: string; title: string; sub: string }> = {
	ble: {
		emoji: "👋",
		title: "Phone detected in hand",
		sub: "Stay focused — put it down and get back to studying.",
	},
	face: {
		emoji: "👀",
		title: "Look at the screen",
		sub: "You seem distracted — eyes back on the screen and get back to studying.",
	},
};

/**
 * Unified focus-detection system. Owns both detection backends (BLE
 * proximity + webcam face tracking), their lifecycle, and the shared
 * distraction-warning overlay. Each backend can be enabled, disabled and
 * configured independently; shared resources (overlay, cooldowns, asset
 * cache) live here instead of being duplicated per feature.
 */
export class DetectionManager {
	private plugin: CortexPlugin;
	ble: BleFocusDetector | null = null;
	face: FaceFocusEvaluator | null = null;

	private warningOverlay: HTMLElement | null = null;
	private warningTimer: ReturnType<typeof setTimeout> | null = null;
	private warningSource: DetectionSource | null = null;
	private cooldownUntil: Record<DetectionSource, number> = { ble: 0, face: 0 };
	private toggling: Record<DetectionSource, boolean> = { ble: false, face: false };

	constructor(plugin: CortexPlugin) {
		this.plugin = plugin;

		if (!Platform.isMobile) {
			this.ble = new BleFocusDetector(plugin);
			this.ble.onStateChange((state) => this.onBleStateChange(state));
		}
	}

	get isAvailable(): boolean {
		return !Platform.isMobile;
	}

	/**
	 * Vault-adapter-backed cache for the MediaPipe wasm runtime and face
	 * model (~15 MB total) so they download once instead of on every start.
	 */
	private createAssetStore(): FaceAssetStore {
		const adapter = this.plugin.app.vault.adapter;
		const dir = `${this.plugin.app.vault.configDir}/plugins/cortex/.assets`;
		const path = (name: string) => `${dir}/${name}`;
		return {
			exists: (name) => adapter.exists(path(name)),
			readBinary: (name) => adapter.readBinary(path(name)),
			writeBinary: async (name, data) => {
				if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
				await adapter.writeBinary(path(name), data);
			},
			getResourcePath: (name) => adapter.getResourcePath(path(name)),
		};
	}

	/** Start whichever detectors are enabled in settings (deferred init). */
	async startEnabled(): Promise<void> {
		if (!this.isAvailable) return;
		const tasks: Promise<unknown>[] = [];

		if (this.plugin.settings.bleEnabled && this.ble) {
			tasks.push(
				this.startBle().catch((e) => console.error("[cortex] BLE auto-start failed:", e))
			);
		}
		if (this.plugin.settings.faceEnabled) {
			tasks.push(
				this.startFace().catch((e) => console.error("[cortex] Face auto-start failed:", e))
			);
		}

		await Promise.all(tasks);
	}

	async destroy(): Promise<void> {
		this.destroyWarning();
		try {
			this.ble?.stop();
		} catch (e) {
			console.error("[cortex] BLE stop failed:", e);
		}
		try {
			await this.face?.stop();
		} catch (e) {
			console.error("[cortex] Face evaluator stop failed:", e);
		}
	}

	// ── BLE ──────────────────────────────────────────────────────────

	private async startBle(): Promise<boolean> {
		if (!this.ble) return false;
		const ok = await this.ble.start();
		if (ok) {
			const name = this.plugin.settings.bleDeviceName;
			if (name) await this.ble.startScanningByName(name);
		}
		return ok;
	}

	isBleOn(): boolean {
		return this.plugin.settings.bleEnabled || (this.ble?.isIntendedActive() ?? false);
	}

	async toggleBle(notify = true): Promise<void> {
		if (this.toggling.ble) return;
		this.toggling.ble = true;
		try {
			if (!this.ble) {
				if (notify) new Notice("Cortex: BLE Focus Detection is not available on this device.");
				return;
			}
			if (this.isBleOn()) {
				this.ble.stop();
				this.plugin.settings.bleEnabled = false;
				await this.plugin.saveData(this.plugin.settings);
			} else {
				const ok = await this.startBle();
				if (ok) {
					this.plugin.settings.bleEnabled = true;
					await this.plugin.saveData(this.plugin.settings);
				} else if (notify) {
					new Notice("Cortex: Bluetooth unavailable. Make sure Bluetooth is on and Obsidian has access in System Settings → Privacy & Security → Bluetooth.");
				}
			}
		} catch (e) {
			console.error("[cortex] BLE toggle failed:", e);
			if (notify) new Notice("Cortex: BLE error occurred. Check console for details.");
		} finally {
			this.toggling.ble = false;
		}
	}

	private onBleStateChange(state: BleFocusState): void {
		if (state === "DISTRACTED") {
			this.showWarning("ble");
		} else if (this.warningSource === "ble") {
			this.destroyWarning();
		}
	}

	// ── Face ─────────────────────────────────────────────────────────

	private async startFace(): Promise<boolean> {
		if (!this.face) {
			this.face = new FaceFocusEvaluator({
				sampleIntervalMs: this.plugin.settings.faceSampleIntervalSec * 1000,
				blinkThreshold: this.plugin.settings.faceBlinkThreshold,
				pitchDownThreshold: this.plugin.settings.facePitchThreshold,
				gracePeriodMs: this.plugin.settings.faceGracePeriodSec * 1000,
				assetStore: this.createAssetStore(),
			});
		}
		this.face.setStateChangeCallback((state) => this.onFaceStateChange(state));
		return this.face.start();
	}

	isFaceOn(): boolean {
		return this.plugin.settings.faceEnabled;
	}

	async toggleFace(notify = true): Promise<void> {
		if (this.toggling.face) return;
		this.toggling.face = true;
		try {
			if (this.plugin.settings.faceEnabled) {
				await this.face?.stop();
				this.plugin.settings.faceEnabled = false;
				await this.plugin.saveData(this.plugin.settings);
			} else {
				await this.face?.stop();
				// Recreate so settings changes (interval, thresholds) apply
				this.face = null;
				const ok = await this.startFace();
				if (ok) {
					this.plugin.settings.faceEnabled = true;
					await this.plugin.saveData(this.plugin.settings);
					if (notify) new Notice("Cortex: Face detection started.");
				} else if (notify) {
					const face = this.face as FaceFocusEvaluator | null;
					new Notice(face?.lastError ?? "Cortex: Face detection failed to start. Make sure your webcam is available.");
				}
			}
		} catch (e) {
			console.error("[cortex] Face toggle failed:", e);
			if (notify) new Notice("Cortex: Face detection failed to start. Check console for details.");
		} finally {
			this.toggling.face = false;
		}
	}

	private onFaceStateChange(state: FaceFocusState): void {
		if (state === "DISTRACTED") {
			this.showWarning("face");
		} else if (this.warningSource === "face") {
			this.destroyWarning();
		}
	}

	// ── Shared warning overlay ───────────────────────────────────────

	private showWarning(source: DetectionSource): void {
		if (this.warningOverlay) return;
		if (Date.now() < this.cooldownUntil[source]) return;

		this.warningSource = source;
		const content = WARNING_CONTENT[source];
		const root = this.plugin.app.workspace.containerEl;

		this.warningOverlay = root.createDiv({ cls: "cortex-ble-warning-overlay" });
		const box = this.warningOverlay.createDiv({ cls: "cortex-ble-warning-box" });

		box.createDiv({ text: content.emoji, cls: "cortex-ble-warning-emoji" });
		box.createEl("h1", { text: content.title, cls: "cortex-ble-warning-title" });
		box.createEl("p", { text: content.sub, cls: "cortex-ble-warning-sub" });

		const dismissBtn = box.createEl("button", {
			text: "I'm focused",
			cls: "cortex-ble-warning-dismiss mod-cta",
		});
		dismissBtn.addEventListener("click", () => this.destroyWarning());

		this.warningOverlay.addEventListener("click", (e) => {
			if (e.target === this.warningOverlay) {
				this.destroyWarning();
			}
		});

		this.warningTimer = setTimeout(() => this.destroyWarning(), WARNING_AUTO_DISMISS_MS);
	}

	private destroyWarning(): void {
		if (this.warningTimer) {
			clearTimeout(this.warningTimer);
			this.warningTimer = null;
		}
		const source = this.warningSource;
		if (this.warningOverlay) {
			this.warningOverlay.remove();
			this.warningOverlay = null;
		}
		if (source) {
			this.cooldownUntil[source] = Date.now() + WARNING_COOLDOWN_MS;
		}
		if (source === "ble" && this.ble) {
			this.ble.isWarningActive = false;
			this.ble.resetConfirmation();
		}
		this.warningSource = null;
	}
}
