/**
 * FaceDetector — MediaPipe FaceLandmarker for focus detection.
 *
 * Detection runs in short "bursts": every `sampleIntervalMs` a burst of
 * frames is captured at ~10fps for `burstDurationMs` and aggregated into a
 * single state. This keeps average CPU low (~2 frames/sec) while making
 * blink detection, gaze and head-pose readings statistically meaningful —
 * a single frame every 10s cannot observe a 300ms blink.
 *
 * Model + wasm assets are pinned to the installed @mediapipe/tasks-vision
 * version and cached on disk after the first download, so startup needs no
 * network after the first successful run.
 */

import type { FaceLandmarker as FaceLandmarkerT, FaceLandmarkerResult, NormalizedLandmark, Matrix } from "@mediapipe/tasks-vision";
import WASM_LOADER_JS from "mediapipe:wasm-loader";

// Version must stay in sync with the installed @mediapipe/tasks-vision package.
const MEDIAPIPE_VERSION = "0.10.35";
// Version-pinned WASM binary (data asset, not JS). Downloaded once, cached to vault.
const WASM_BINARY_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm/vision_wasm_internal.wasm`;
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

const WASM_BINARY_FILE = "vision_wasm_internal.wasm";
const MODEL_FILE = "face_landmarker.task";

const INIT_STEP_TIMEOUT_MS = 60000;

/** Persistence for downloaded detection assets (backed by the vault adapter). */
export interface FaceAssetStore {
  exists(name: string): Promise<boolean>;
  readBinary(name: string): Promise<ArrayBuffer>;
  writeBinary(name: string, data: ArrayBuffer): Promise<void>;
}

export type FocusFaceState = {
  /** Is the face visible in the camera? */
  faceVisible: boolean;
  /** Confidence of face detection (0-1) */
  confidence: number;
  /** Head pitch (radians). Negative = looking down at desk */
  headPitch: number | null;
  /** Head yaw (radians). Positive = looking right */
  headYaw: number | null;
  /** Head roll (radians). Positive = tilting right */
  headRoll: number | null;
  /** Is gaze directed at the screen? (0-1 probability) */
  gazeAtScreen: number | null;
  /** Left eye openness (0-1). < 0.3 = likely closed */
  leftEyeOpenness: number | null;
  /** Right eye openness (0-1). < 0.3 = likely closed */
  rightEyeOpenness: number | null;
  /** Blinks per minute (duty-cycle-corrected rolling estimate) */
  blinkRate: number | null;
  /** Head movement variance — low = steady and focused, high = fidgeting */
  headStability: number | null;
};

const DEFAULT_STATE: FocusFaceState = {
  faceVisible: false,
  confidence: 0,
  headPitch: null,
  headYaw: null,
  headRoll: null,
  gazeAtScreen: null,
  leftEyeOpenness: null,
  rightEyeOpenness: null,
  blinkRate: null,
  headStability: null,
};

/** Per-frame measurement inside a burst. */
interface FrameSample {
  faceVisible: boolean;
  pitch: number | null;
  yaw: number | null;
  roll: number | null;
  gaze: number | null;
  leftEye: number | null;
  rightEye: number | null;
}

export class FaceDetectorCancelledError extends Error {
  constructor() {
    super("FaceDetector init was cancelled");
    this.name = "FaceDetectorCancelledError";
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s. Check your network connection and try again.`)),
      ms
    );
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

export class FaceDetector {
  private faceLandmarker: FaceLandmarkerT | null = null;
  private video: HTMLVideoElement | null = null;
  private running = false;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private burstActive = false;
  private lastState: FocusFaceState = { ...DEFAULT_STATE };
  private aborted = false;
  private currentStream: MediaStream | null = null;
  /** Strictly increasing timestamp source for detectForVideo. */
  private lastVideoTimestamp = 0;

  // Blink detection (across bursts, duty-cycle corrected)
  private blinkTimestamps: number[] = [];
  private wasEyesClosed = false;

  // Grace period: if face drops out, keep last known state for N ms
  private lastFaceSeenTime = 0;

  private config: FaceDetectorConfig;

  constructor(config?: Partial<FaceDetectorConfig>) {
    this.config = { ...DEFAULT_FACE_CONFIG, ...config };
  }

  /**
   * Returns true when the cached WASM binary and model are present on disk.
   * Used to decide whether the first init will need to download.
   */
  static async areAssetsReady(store: FaceAssetStore): Promise<boolean> {
    const [wasm, model] = await Promise.all([
      store.exists(WASM_BINARY_FILE),
      store.exists(MODEL_FILE),
    ]);
    return wasm && model;
  }

  /**
   * Whether the host runtime is even allowed to use the camera. On macOS
   * this is gated by an entitlement on the Obsidian app binary — without
   * `com.apple.security.device.camera`, the OS will not show a permission
   * dialog and getUserMedia will hang or reject with NotAllowedError. There
   * is no plugin-level workaround; users on macOS must rely on the BLE
   * focus detector until Obsidian adds the entitlement. See:
   * https://forum.obsidian.md/t/add-camera-permissions-for-obsidian-mac-so-the-obsidian-camera-plugin-works/76265
   */
  static isCameraSupported(): boolean {
    // The actual entitlement lives on the Obsidian binary, which we cannot
    // inspect from a renderer. We assume macOS may be blocked; the
    // practical check happens when getUserMedia is attempted. This helper
    // exists so callers can disable face tracking UI on macOS if desired.
    return process.platform !== "darwin";
  }

  private cleanupStream(): void {
    if (this.currentStream) {
      for (const track of this.currentStream.getTracks()) { track.stop(); }
      this.currentStream = null;
    }
    if (this.video) {
      this.video.srcObject = null;
      this.video.remove();
      this.video = null;
    }
  }

  private throwIfAborted(): void {
    if (this.aborted) {
      this.cleanupStream();
      throw new FaceDetectorCancelledError();
    }
  }

  private reportProgress(msg: string): void {
    this.config.onProgress?.(msg);
  }

  /**
   * Returns the bytes of `name` from the on-disk cache, downloading from
   * `url` on first use. Returns null on failure (caller falls back to
   * loading directly from the CDN).
   */
  private async ensureAsset(name: string, url: string): Promise<ArrayBuffer | null> {
    const store = this.config.assetStore;
    try {
      if (store && (await store.exists(name))) {
        return await store.readBinary(name);
      }
      this.reportProgress(`Downloading ${name} (one-time)…`);
      const res = await withTimeout(fetch(url), INIT_STEP_TIMEOUT_MS, `Downloading ${name}`);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const data = await res.arrayBuffer();
      if (store) {
        try {
          await store.writeBinary(name, data);
          console.log(`[cortex] FaceDetector cached ${name} (${(data.byteLength / 1048576).toFixed(1)} MB)`);
        } catch (e) {
          console.warn(`[cortex] FaceDetector could not cache ${name}:`, e);
        }
      }
      return data;
    } catch (err) {
      console.warn(`[cortex] FaceDetector asset load failed for ${name}:`, err);
      return null;
    }
  }

  async init(): Promise<void> {
    this.aborted = false;

    this.video = document.createElement("video");
    this.video.setAttribute("autoplay", "");
    this.video.setAttribute("playsinline", "");
    this.video.muted = true;
    // Off-screen instead of display:none — Chromium may stop decoding
    // frames for fully hidden videos.
    this.video.style.position = "fixed";
    this.video.style.left = "-10000px";
    this.video.style.top = "0";
    this.video.style.width = "1px";
    this.video.style.height = "1px";
    document.body.appendChild(this.video);

    let stream: MediaStream;
    try {
      this.reportProgress("Opening webcam…");
      // The first getUserMedia on macOS (with OS-level status "not-determined")
      // surfaces the system camera-permission dialog automatically. If the
      // user previously dismissed it, the OS will not show it again and
      // getUserMedia rejects with NotAllowedError — the catch block below
      // tells them how to grant it manually. The 20s timeout is a safety
      // net for any hangs in the underlying media stack.
      stream = await withTimeout(
        navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 640 },
            height: { ideal: 480 },
            facingMode: "user",
          },
          audio: false,
        }),
        20000,
        "Opening the webcam"
      );
      this.currentStream = stream;
    } catch (err) {
      this.video.remove();
      this.video = null;
      if (err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "NotFoundError")) {
        if (process.platform === "darwin") {
          throw new Error(
            "Camera access is unavailable in Obsidian on macOS: the Obsidian app binary is " +
            "missing the com.apple.security.device.camera entitlement, so macOS will not show " +
            "the camera permission dialog. There is no plugin-level workaround. " +
            "Use the BLE Focus Detector instead, or track this open feature request: " +
            "https://forum.obsidian.md/t/add-camera-permissions-for-obsidian-mac-so-the-obsidian-camera-plugin-works/76265"
          );
        }
        throw new Error(
          "Camera access denied. Open System Settings → Privacy & Security → Camera " +
          "and enable Obsidian, then click the Face Detection toggle again."
        );
      }
      if (err instanceof Error && err.message.startsWith("Opening the webcam timed out")) {
        if (process.platform === "darwin") {
          throw new Error(
            "Webcam request timed out. On macOS this almost always means Obsidian is missing " +
            "the camera entitlement (no permission dialog will appear). Use the BLE Focus " +
            "Detector instead."
          );
        }
        throw new Error(
          "Webcam did not respond within 20s. Check System Settings → Privacy & Security → " +
          "Camera (Obsidian must be allowed), make sure no other app is blocking the " +
          "camera, then try again."
        );
      }
      throw err;
    }

    this.throwIfAborted();
    this.video.srcObject = stream;
    await this.video.play();

    this.throwIfAborted();
    // Lazy import — keeps the MediaPipe module from executing at plugin load.
    const { FaceLandmarker } = await import("@mediapipe/tasks-vision");

    this.throwIfAborted();
    this.reportProgress("Loading detection runtime…");

    // JS loader is bundled into main.js at build time — no network request.
    // WASM binary is a version-pinned data asset; downloaded once and cached.
    const binaryBytes = await this.ensureAsset(WASM_BINARY_FILE, WASM_BINARY_URL);
    if (!binaryBytes) {
      throw new Error(
        "Face detection runtime could not be downloaded. Check your network connection and try again.",
      );
    }

    // Serve assets via blob: URLs — work regardless of vault location/scheme.
    const blobUrls: string[] = [];
    const loaderUrl = URL.createObjectURL(new Blob([WASM_LOADER_JS], { type: "text/javascript" }));
    const wasmUrl = URL.createObjectURL(new Blob([binaryBytes], { type: "application/wasm" }));
    blobUrls.push(loaderUrl, wasmUrl);
    const fileset = { wasmLoaderPath: loaderUrl, wasmBinaryPath: wasmUrl };

    try {
      this.throwIfAborted();
      let modelSource: { modelAssetBuffer: Uint8Array } | { modelAssetPath: string };
      const modelBytes = await this.ensureAsset(MODEL_FILE, this.config.modelPath ?? MODEL_URL);
      if (modelBytes) {
        modelSource = { modelAssetBuffer: new Uint8Array(modelBytes) };
      } else {
        modelSource = { modelAssetPath: this.config.modelPath ?? MODEL_URL };
      }

      this.throwIfAborted();
      this.reportProgress("Starting face model…");
      const createWithDelegate = (fs: { wasmLoaderPath: string; wasmBinaryPath: string }, delegate: "GPU" | "CPU") =>
        withTimeout(
          FaceLandmarker.createFromOptions(fs, {
            baseOptions: { ...modelSource, delegate },
            runningMode: "VIDEO",
            numFaces: 1,
            outputFaceBlendshapes: false,
            outputFacialTransformationMatrixes: true,
          }),
          INIT_STEP_TIMEOUT_MS,
          "Initializing face landmark model"
        );

      try {
        this.faceLandmarker = await createWithDelegate(fileset, "GPU");
      } catch (gpuErr) {
        this.throwIfAborted();
        console.warn("[cortex] FaceDetector GPU delegate failed, falling back to CPU:", gpuErr);
        this.faceLandmarker = await createWithDelegate(fileset, "CPU");
      }
    } finally {
      // The runtime is fully instantiated (or failed) — blobs are no longer
      // referenced and ~11 MB can be released.
      for (const u of blobUrls) URL.revokeObjectURL(u);
    }

    console.log("[cortex] FaceDetector initialized — webcam active, face+iris tracking enabled");
  }

  /**
   * Start periodic burst detection. Each burst aggregates several frames
   * into one FocusFaceState delivered to `callback`.
   */
  start(callback: (state: FocusFaceState) => void): boolean {
    if (!this.faceLandmarker || !this.video) {
      console.error("[cortex] FaceDetector not initialized — call init() first");
      return false;
    }
    this.running = true;

    const runBurst = () => {
      if (!this.running || this.burstActive) return;
      // Window minimized/hidden — skip the burst entirely, save CPU.
      if (document.hidden) return;
      this.burstActive = true;
      this.captureBurst()
        .then((state) => {
          if (!this.running) return;
          this.lastState = state;
          callback(state);
        })
        .catch((err) => {
          console.error("[cortex] Face detection burst error:", err);
        })
        .finally(() => {
          this.burstActive = false;
        });
    };

    runBurst(); // immediate first sample
    this.intervalId = setInterval(runBurst, this.config.sampleIntervalMs);
    return true;
  }

  stop(): void {
    this.running = false;
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  getLastState(): FocusFaceState {
    return this.lastState;
  }

  private async captureBurst(): Promise<FocusFaceState> {
    const frames: FrameSample[] = [];
    const frameCount = Math.max(2, Math.round(this.config.burstDurationMs / this.config.burstFrameIntervalMs));
    let blinksInBurst = 0;

    for (let i = 0; i < frameCount; i++) {
      if (!this.running) break;
      const sample = this.sampleFrame();
      if (sample) {
        frames.push(sample);

        // Blink edge detection on consecutive frames (~100ms apart)
        if (sample.faceVisible && sample.leftEye !== null && sample.rightEye !== null) {
          const eyesClosed =
            sample.leftEye < this.config.blinkThreshold &&
            sample.rightEye < this.config.blinkThreshold;
          if (eyesClosed && !this.wasEyesClosed) {
            this.wasEyesClosed = true;
          } else if (!eyesClosed && this.wasEyesClosed) {
            this.wasEyesClosed = false;
            blinksInBurst++;
            this.blinkTimestamps.push(Date.now());
          }
        }
      }
      if (i < frameCount - 1) {
        await new Promise((r) => setTimeout(r, this.config.burstFrameIntervalMs));
      }
    }

    return this.aggregateBurst(frames);
  }

  private sampleFrame(): FrameSample | null {
    if (!this.faceLandmarker || !this.video || this.video.readyState < 2) {
      return null;
    }

    // detectForVideo requires strictly increasing timestamps
    const ts = Math.max(performance.now(), this.lastVideoTimestamp + 1);
    this.lastVideoTimestamp = ts;

    let results: FaceLandmarkerResult;
    try {
      results = this.faceLandmarker.detectForVideo(this.video, ts);
    } catch (err) {
      console.error("[cortex] detectForVideo failed:", err);
      return null;
    }

    if (!results.faceLandmarks || results.faceLandmarks.length === 0) {
      return { faceVisible: false, pitch: null, yaw: null, roll: null, gaze: null, leftEye: null, rightEye: null };
    }

    this.lastFaceSeenTime = Date.now();
    const landmarks = results.faceLandmarks[0];

    let pitch = this.extractPitch(results);
    let yaw = this.extractYaw(results);
    let roll = this.extractRoll(results);
    if (pitch === null) pitch = this.pitchFromLandmarks(landmarks);
    if (yaw === null) yaw = this.yawFromLandmarks(landmarks);
    if (roll === null) roll = this.rollFromLandmarks(landmarks);

    // ── EYE OPENNESS ──
    // Landmarks: Left eye upper=159, lower=145, inner=133, outer=33
    //            Right eye upper=386, lower=374, inner=362, outer=263
    const leftEyeWidth = Math.max(0.001, Math.abs(landmarks[133].x - landmarks[33].x));
    const rightEyeWidth = Math.max(0.001, Math.abs(landmarks[263].x - landmarks[362].x));
    const leftEye = Math.min(1, Math.abs(landmarks[159].y - landmarks[145].y) / leftEyeWidth / 0.15);
    const rightEye = Math.min(1, Math.abs(landmarks[386].y - landmarks[374].y) / rightEyeWidth / 0.15);

    // ── GAZE (iris landmarks 468/473, weighted with head pitch) ──
    const gazeFromIris = this.computeGazeFromIris(landmarks);
    const gazeFromPitch = this.computeGazeFromPitch(pitch);
    const gaze = gazeFromIris !== null
      ? gazeFromIris * 0.7 + gazeFromPitch * 0.3
      : gazeFromPitch;

    return { faceVisible: true, pitch, yaw, roll, gaze, leftEye, rightEye };
  }

  private aggregateBurst(frames: FrameSample[]): FocusFaceState {
    const total = frames.length;
    const visible = frames.filter((f) => f.faceVisible);
    const visibleRatio = total > 0 ? visible.length / total : 0;

    // Face counts as visible if seen in ≥30% of burst frames — tolerant of
    // per-frame detection flicker.
    if (total === 0 || visibleRatio < 0.3) {
      const timeSinceLastFace = Date.now() - this.lastFaceSeenTime;
      if (timeSinceLastFace < this.config.gracePeriodMs && this.lastState.faceVisible) {
        return {
          ...this.lastState,
          confidence: Math.max(0.2, this.lastState.confidence * 0.7),
        };
      }
      return { ...DEFAULT_STATE, blinkRate: this.estimateBlinkRate() };
    }

    const pitches = visible.map((f) => f.pitch).filter((v): v is number => v !== null);
    const yaws = visible.map((f) => f.yaw).filter((v): v is number => v !== null);

    const state: FocusFaceState = {
      faceVisible: true,
      confidence: visibleRatio,
      headPitch: median(pitches),
      headYaw: median(yaws),
      headRoll: median(visible.map((f) => f.roll).filter((v): v is number => v !== null)),
      gazeAtScreen: median(visible.map((f) => f.gaze).filter((v): v is number => v !== null)),
      leftEyeOpenness: median(visible.map((f) => f.leftEye).filter((v): v is number => v !== null)),
      rightEyeOpenness: median(visible.map((f) => f.rightEye).filter((v): v is number => v !== null)),
      blinkRate: this.estimateBlinkRate(),
      headStability: null,
    };

    // Head stability from within-burst variance — measures fidgeting on a
    // timescale where it is actually observable.
    const combinedVariance = (variance(pitches) + variance(yaws)) / 2;
    state.headStability = Math.max(0, Math.min(1, 1 - combinedVariance * 20));

    return state;
  }

  /**
   * Blinks/minute from blinks observed during bursts, corrected for the
   * sampling duty cycle (we only watch burstDuration out of every
   * sampleInterval).
   */
  private estimateBlinkRate(): number {
    const now = Date.now();
    this.blinkTimestamps = this.blinkTimestamps.filter((t) => now - t < 60000);
    const dutyCycle = Math.min(1, this.config.burstDurationMs / this.config.sampleIntervalMs);
    if (dutyCycle <= 0) return 0;
    return Math.min(60, Math.round(this.blinkTimestamps.length / dutyCycle));
  }

  // ── EULER ANGLE EXTRACTION FROM TRANSFORMATION MATRIX ──

  private extractPitch(results: FaceLandmarkerResult): number | null {
    const m = results.facialTransformationMatrixes?.[0]?.data;
    if (!m || m.length < 16) return null;
    const r21 = m[9];
    const sinPitch = Math.max(-1, Math.min(1, -r21));
    return Math.asin(sinPitch);
  }

  private extractYaw(results: FaceLandmarkerResult): number | null {
    const m = results.facialTransformationMatrixes?.[0]?.data;
    if (!m || m.length < 16) return null;
    return Math.atan2(m[8], m[10]);
  }

  private extractRoll(results: FaceLandmarkerResult): number | null {
    const m = results.facialTransformationMatrixes?.[0]?.data;
    if (!m || m.length < 16) return null;
    return Math.atan2(m[1], m[0]);
  }

  // ── FALLBACK: LANDMARK-BASED POSE (when transformation matrices unavailable) ──

  private pitchFromLandmarks(landmarks: NormalizedLandmark[]): number {
    const noseTip = landmarks[1];
    const chin = landmarks[152];
    const forehead = landmarks[10];
    const faceMidY = (forehead.y + chin.y) / 2;
    return (noseTip.y - faceMidY) * 12;
  }

  private yawFromLandmarks(landmarks: NormalizedLandmark[]): number {
    const noseTip = landmarks[1];
    const leftEye = landmarks[33];
    const rightEye = landmarks[263];
    const leftDist = Math.abs(noseTip.x - leftEye.x);
    const rightDist = Math.abs(rightEye.x - noseTip.x);
    return (leftDist - rightDist) * 15;
  }

  private rollFromLandmarks(landmarks: NormalizedLandmark[]): number {
    const leftEye = landmarks[33];
    const rightEye = landmarks[263];
    return Math.atan2(rightEye.y - leftEye.y, rightEye.x - leftEye.x);
  }

  // ── GAZE COMPUTATION ──

  private computeGazeFromIris(landmarks: NormalizedLandmark[]): number | null {
    if (landmarks.length < 478) return null;

    const leftIris = landmarks[468];
    const rightIris = landmarks[473];
    const leftInner = landmarks[133];
    const leftOuter = landmarks[33];
    const rightInner = landmarks[362];
    const rightOuter = landmarks[263];

    const leftEyeCenterX = (leftInner.x + leftOuter.x) / 2;
    const rightEyeCenterX = (rightInner.x + rightOuter.x) / 2;
    const leftEyeWidth = Math.abs(leftInner.x - leftOuter.x) || 0.001;
    const rightEyeWidth = Math.abs(rightInner.x - rightOuter.x) || 0.001;

    const leftIrisOffset = Math.abs(leftIris.x - leftEyeCenterX) / leftEyeWidth;
    const rightIrisOffset = Math.abs(rightIris.x - rightEyeCenterX) / rightEyeWidth;
    const avgOffset = (leftIrisOffset + rightIrisOffset) / 2;

    // Offset of ~0.1 is a centered iris, 0.4+ is looking away
    return Math.max(0, Math.min(1, 1 - (avgOffset - 0.05) * 5));
  }

  private computeGazeFromPitch(pitch: number | null): number {
    if (pitch === null) return 0.5;
    if (pitch < this.config.pitchDownThreshold) return 0.1;
    if (pitch < 0) return 0.5;
    return 0.9;
  }

  async destroy(): Promise<void> {
    this.aborted = true;
    this.stop();
    this.cleanupStream();
    this.faceLandmarker?.close();
    this.faceLandmarker = null;
  }
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function variance(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
}

export interface FaceDetectorConfig {
  /** Path/URL of face_landmarker.task model. Falls back to pinned CDN URL. */
  modelPath: string | null;
  /** Interval between bursts in ms. Default 10000 (10s). */
  sampleIntervalMs: number;
  /** How long each detection burst runs (ms). */
  burstDurationMs: number;
  /** Frame spacing within a burst (ms). ~100ms = 10fps. */
  burstFrameIntervalMs: number;
  /** Threshold for eye openness below which eyes are "closed" (0-1) */
  blinkThreshold: number;
  /** Pitch value below which head is considered "looking down" (radians) */
  pitchDownThreshold: number;
  /** Grace period (ms) — if face disappears briefly, keep last state */
  gracePeriodMs: number;
  /** Optional on-disk cache for wasm/model assets. */
  assetStore: FaceAssetStore | null;
  /** Init progress reporting, e.g. for the dashboard panel. */
  onProgress?: (message: string) => void;
}

const DEFAULT_FACE_CONFIG: FaceDetectorConfig = {
  modelPath: null,
  sampleIntervalMs: 10000,
  burstDurationMs: 1500,
  burstFrameIntervalMs: 100,
  blinkThreshold: 0.25,
  pitchDownThreshold: -0.08,
  gracePeriodMs: 2000,
  assetStore: null,
};
