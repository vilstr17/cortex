import { FaceDetector, FaceDetectorCancelledError } from "../FaceDetector";
import type { FocusFaceState, FaceAssetStore } from "../FaceDetector";

export type FaceFocusState = "LOCKED_IN" | "DISTRACTED" | "UNKNOWN";

interface FaceEvaluation {
	state: FaceFocusState;
	confidence: number;
	reason: string;
	faceState: FocusFaceState;
}

type OnStateChange = (state: FaceFocusState) => void;

export class FaceFocusEvaluator {
	private detector: FaceDetector | null = null;
	private currentState: FaceFocusState = "UNKNOWN";
	private confirmCounter = 0;
	// null = no pending transition. Must not use "UNKNOWN" as the sentinel —
	// it is a real state and the collision corrupted confirmation counting.
	private pendingState: FaceFocusState | null = null;
	private onStateChange: OnStateChange | null = null;
	private running = false;
	lastError: string | null = null;

	private sampleIntervalMs: number;
	private blinkThreshold: number;
	private pitchDownThreshold: number;
	private gracePeriodMs: number;
	private assetStore: FaceAssetStore | null;

	constructor(config?: {
		sampleIntervalMs?: number;
		blinkThreshold?: number;
		pitchDownThreshold?: number;
		gracePeriodMs?: number;
		assetStore?: FaceAssetStore | null;
	}) {
		this.sampleIntervalMs = config?.sampleIntervalMs ?? 10000;
		this.blinkThreshold = config?.blinkThreshold ?? 0.25;
		this.pitchDownThreshold = config?.pitchDownThreshold ?? -0.08;
		this.gracePeriodMs = config?.gracePeriodMs ?? 2000;
		this.assetStore = config?.assetStore ?? null;
	}

	setStateChangeCallback(cb: OnStateChange): void {
		this.onStateChange = cb;
	}

	getCurrentState(): FaceFocusState {
		return this.currentState;
	}

	isRunning(): boolean {
		return this.running;
	}

	async start(): Promise<boolean> {
		try {
			this.lastError = null;
			this.detector = new FaceDetector({
				sampleIntervalMs: this.sampleIntervalMs,
				blinkThreshold: this.blinkThreshold,
				pitchDownThreshold: this.pitchDownThreshold,
				gracePeriodMs: this.gracePeriodMs,
				assetStore: this.assetStore,
			});

			await this.detector.init();

			this.currentState = "UNKNOWN";
			this.confirmCounter = 0;
			this.pendingState = null;

			if (!this.detector.start((faceState) => this.evaluate(faceState))) {
				this.lastError = "Face detection failed to start. Try again.";
				this.running = false;
				await this.detector.destroy();
				this.detector = null;
				return false;
			}
			this.running = true;
			console.log("[cortex] FaceFocusEvaluator started");
			return true;
		} catch (err) {
			if (err instanceof FaceDetectorCancelledError) {
				this.running = false;
				if (this.detector) {
					await this.detector.destroy();
					this.detector = null;
				}
				return false;
			}
			console.error("[cortex] FaceFocusEvaluator start failed:", err);
			if (err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "NotFoundError")) {
				this.lastError = "Camera access denied. Grant access in System Settings \u2192 Privacy & Security \u2192 Camera, then try again.";
			} else if (err instanceof Error && err.message.includes("Camera permission denied")) {
				this.lastError = err.message;
			} else {
				this.lastError = err instanceof Error ? err.message : String(err);
			}
			this.running = false;
			if (this.detector) {
				await this.detector.destroy();
				this.detector = null;
			}
			return false;
		}
	}

	async stop(): Promise<void> {
		this.running = false;
		this.lastError = null;
		if (this.detector) {
			await this.detector.destroy();
			this.detector = null;
		}
		this.currentState = "UNKNOWN";
		this.confirmCounter = 0;
		this.pendingState = null;
		console.log("[cortex] FaceFocusEvaluator stopped");
	}

	getLastFaceState(): FocusFaceState | null {
		return this.detector?.getLastState() ?? null;
	}

	private evaluate(faceState: FocusFaceState): void {
		const evaluation = this.evaluateFaceState(faceState);
		this.transition(evaluation);
	}

	private evaluateFaceState(faceState: FocusFaceState): FaceEvaluation {
		if (!faceState.faceVisible) {
			return {
				state: "UNKNOWN",
				confidence: 0,
				reason: "No face detected",
				faceState,
			};
		}

		const lookingDown = faceState.headPitch !== null && faceState.headPitch < this.pitchDownThreshold;
		const gazeAway = faceState.gazeAtScreen !== null && faceState.gazeAtScreen < 0.4;

		if (lookingDown && gazeAway) {
			return {
				state: "DISTRACTED",
				confidence: 0.75,
				reason: "Looking down at desk",
				faceState,
			};
		}

		if (faceState.blinkRate !== null && faceState.blinkRate > 25) {
			return {
				state: "DISTRACTED",
				confidence: 0.6,
				reason: "High blink rate",
				faceState,
			};
		}

		if (faceState.headStability !== null && faceState.headStability < 0.3) {
			return {
				state: "DISTRACTED",
				confidence: 0.5,
				reason: "Fidgeting / head instability",
				faceState,
			};
		}

		if (faceState.gazeAtScreen !== null && faceState.gazeAtScreen > 0.7) {
			return {
				state: "LOCKED_IN",
				confidence: 0.6,
				reason: "Gaze on screen",
				faceState,
			};
		}

		return {
			state: this.currentState === "UNKNOWN" ? "LOCKED_IN" : this.currentState,
			confidence: faceState.confidence * 0.5,
			reason: "No strong signal",
			faceState,
		};
	}

	private transition(evaluation: FaceEvaluation): void {
		// Each sample is already a burst aggregate (~15 frames), so 2
		// consecutive confirmations are enough: state changes within
		// ~2 sample intervals instead of 3+.
		const confirmRequired = 2;

		if (evaluation.state === this.currentState) {
			this.confirmCounter = 0;
			this.pendingState = null;
			return;
		}

		if (evaluation.state === this.pendingState) {
			this.confirmCounter++;
			if (this.confirmCounter >= confirmRequired) {
				this.currentState = evaluation.state;
				this.confirmCounter = 0;
				this.pendingState = null;
				if (this.onStateChange) {
					this.onStateChange(this.currentState);
				}
			}
		} else {
			this.pendingState = evaluation.state;
			this.confirmCounter = 1;
		}
	}
}
