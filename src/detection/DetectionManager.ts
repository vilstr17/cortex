import { Modal, Notice, Platform } from "obsidian";
import type ChronotePlugin from "../main";
import { FaceFocusEvaluator } from "../face/FaceFocusEvaluator";
import type { FaceFocusState } from "../face/FaceFocusEvaluator";
import { FaceDetector } from "../FaceDetector";
import type { FaceAssetStore } from "../FaceDetector";
import type { FocusStatsRecorder } from "../focus/focusStats";
import { CompanionProcess, COMPANION_STREAM_URL } from "./companionProcess";

export type DetectionSource = "face";

const WARNING_AUTO_DISMISS_MS = 15000;
const WARNING_COOLDOWN_MS = 15000;

const WARNING_CONTENT: Record<DetectionSource, { emoji: string; title: string; sub: string }> = {
	face: {
		emoji: "👀",
		title: "Look at the screen",
		sub: "You seem distracted — eyes back on the screen and get back to studying.",
	},
};

/**
 * Camera-based focus detection. Owns the webcam face tracker, its
 * lifecycle, the distraction-warning overlay, and the stats recorder.
 *
 * On macOS the camera is owned by the Chronote Camera companion app
 * (Obsidian's binary lacks the camera entitlement), which streams
 * frames over localhost; FaceDetector connects to that stream and falls
 * back to getUserMedia on other platforms.
 */
export class DetectionManager {
	private plugin: ChronotePlugin;
	face: FaceFocusEvaluator | null = null;
	private stats: FocusStatsRecorder | null;
	private companion: CompanionProcess | null;

	private warningOverlay: HTMLElement | null = null;
	private warningTimer: ReturnType<typeof setTimeout> | null = null;
	private warningSource: DetectionSource | null = null;
	private cooldownUntil: Record<DetectionSource, number> = { face: 0 };
	private toggling = false;

	constructor(plugin: ChronotePlugin, stats?: FocusStatsRecorder) {
		this.plugin = plugin;
		this.stats = stats ?? null;
		this.companion = this.createCompanion();
	}

	/**
	 * The Chronote Camera companion binary lives next to the plugin
	 * (`<plugin dir>/companion/chronote-camera`). On platforms where
	 * Obsidian can open the camera itself (non-macOS) the companion is
	 * not needed and stays null — FaceDetector falls back to
	 * getUserMedia.
	 */
	private createCompanion(): CompanionProcess | null {
		if (process.platform !== "darwin") return null;
		const pluginDir =
			(this.plugin.manifest as { dir?: string } | undefined)?.dir ??
			".obsidian/plugins/chronote";
		return new CompanionProcess(`${pluginDir}/companion/chronote-camera`);
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
		};
	}

	/** Start face detection if enabled in settings (deferred init). */
	async startEnabled(): Promise<void> {
		if (!this.isAvailable) return;
		if (this.plugin.settings.faceEnabled) {
			try {
				await this.startFace();
			} catch (e) {
				console.error("[chronote] Face auto-start failed:", e);
			}
		}
	}

	async destroy(): Promise<void> {
		this.destroyWarning();
		this.stats?.stop(Date.now());
		this.companion?.stop();
		try {
			await this.face?.stop();
		} catch (e) {
			console.error("[chronote] Face evaluator stop failed:", e);
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
				streamUrl: this.companion ? COMPANION_STREAM_URL : null,
			});
		}
		this.face.setStateChangeCallback((state) => this.onFaceStateChange(state));
		return this.face.start();
	}

	isFaceOn(): boolean {
		return this.plugin.settings.faceEnabled;
	}

	/** True while face detection is starting up (camera/model init). */
	isFaceStarting(): boolean {
		return this.toggling && !this.plugin.settings.faceEnabled;
	}

	async toggleFace(notify = true): Promise<void> {
		if (this.toggling) return;
		this.toggling = true;
		try {
			if (this.plugin.settings.faceEnabled) {
				await this.face?.stop();
				this.stats?.stop(Date.now());
				this.companion?.stop();
				this.plugin.settings.faceEnabled = false;
				await this.plugin.saveData(this.plugin.settings);
			} else {
				await this.face?.stop();
				// Recreate so settings changes (interval, thresholds) apply
				this.face = null;

				// macOS: start the camera companion first — Obsidian
				// cannot open a camera itself there.
				if (this.companion) {
					const started = await this.companion.start();
					if (!started) {
						if (notify) {
							new Notice(
								"Chronote: Could not start the Chronote Camera companion. " +
								"Build it with `npm run build:companion` (see companion/README.md).",
							);
						}
						return;
					}
				}

				// First use: ask before downloading the ~26 MB detection assets.
				const store = this.createAssetStore();
				const assetsReady = await FaceDetector.areAssetsReady(store);
				if (!assetsReady) {
					const consented = await this.showFaceSetupConsent();
					if (!consented) {
						this.companion?.stop();
						if (notify) new Notice("Chronote: Face detection setup cancelled.");
						return;
					}
				}

				const ok = await this.startFace();
				if (ok) {
					this.plugin.settings.faceEnabled = true;
					await this.plugin.saveData(this.plugin.settings);
					if (notify) new Notice("Chronote: Face detection started.");
				} else if (notify) {
					this.companion?.stop();
					const face = this.face as FaceFocusEvaluator | null;
					new Notice(face?.lastError ?? "Chronote: Face detection failed to start. Make sure your webcam is available.");
				}
			}
		} catch (e) {
			console.error("[chronote] Face toggle failed:", e);
			if (notify) new Notice("Chronote: Face detection failed to start. Check console for details.");
		} finally {
			this.toggling = false;
		}
	}

	private onFaceStateChange(state: FaceFocusState): void {
		this.stats?.recordState(state, Date.now());
		if (state === "DISTRACTED") {
			this.showWarning("face");
		} else if (this.warningSource === "face") {
			this.destroyWarning();
		}
	}

	/**
	 * Shown on first enable: explains what gets downloaded (~26 MB) and from
	 * where before any network request is made.
	 */
	private showFaceSetupConsent(): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			const modal = new Modal(this.plugin.app);
			modal.titleEl.setText("Face Detection: First-Time Setup");

			const { contentEl } = modal;
			contentEl.createEl("p", {
				text: "Enabling face detection requires downloading two files (~26 MB total). This is a one-time setup — files are cached locally and no download happens on subsequent starts.",
			});

			const dl = contentEl.createEl("dl", { cls: "chronote-setup-dl" });
			dl.createEl("dt", { text: "WASM runtime (~11 MB)" });
			dl.createEl("dd", { text: "cdn.jsdelivr.net — MediaPipe WebAssembly binary (version-pinned)" });
			dl.createEl("dt", { text: "Face landmark model (~15 MB)" });
			dl.createEl("dd", { text: "storage.googleapis.com — Google MediaPipe model weights" });

			contentEl.createEl("p", {
				text: "No data from your camera is ever sent to any server. Detection runs entirely on your device.",
				cls: "chronote-setup-note",
			});

			const btnRow = contentEl.createDiv({ cls: "chronote-setup-buttons" });
			const downloadBtn = btnRow.createEl("button", {
				text: "Download & Enable",
				cls: "mod-cta",
			});
			const cancelBtn = btnRow.createEl("button", { text: "Cancel" });

			let settled = false;
			const settle = (value: boolean) => {
				if (settled) return;
				settled = true;
				modal.close();
				resolve(value);
			};

			downloadBtn.addEventListener("click", () => settle(true));
			cancelBtn.addEventListener("click", () => settle(false));
			modal.onClose = () => settle(false);
			modal.open();
		});
	}

	// ── Shared warning overlay ───────────────────────────────────────

	private showWarning(source: DetectionSource): void {
		if (this.warningOverlay) return;
		if (Date.now() < this.cooldownUntil[source]) return;

		this.warningSource = source;
		const content = WARNING_CONTENT[source];
		const root = this.plugin.app.workspace.containerEl;

		this.warningOverlay = root.createDiv({ cls: "chronote-focus-warning-overlay" });
		const box = this.warningOverlay.createDiv({ cls: "chronote-focus-warning-box" });

		box.createDiv({ text: content.emoji, cls: "chronote-focus-warning-emoji" });
		box.createEl("h1", { text: content.title, cls: "chronote-focus-warning-title" });
		box.createEl("p", { text: content.sub, cls: "chronote-focus-warning-sub" });

		const dismissBtn = box.createEl("button", {
			text: "I'm focused",
			cls: "chronote-focus-warning-dismiss mod-cta",
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
		this.warningSource = null;
	}
}
