/**
 * Pure-data settings types. No imports from obsidian or any plugin
 * module so this file is trivially testable in Node.
 *
 * `settings.ts` re-exports these and adds the Obsidian-coupled setting
 * tab UI. Keep this file dependency-free.
 */
import type { BleCalibration } from "./ble/types";

export interface CortexTest {
  id: string;
  name: string;
  date: string; // ISO date string
  filePaths: string[];
  done?: boolean;
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
  dailyLimitMax: number | null;
  maxReviewIntervalDays: number | null;
  bleEnabled: boolean;
  bleDeviceName: string;
  bleCalibrationData: BleCalibration | null;
  faceEnabled: boolean;
  faceSampleIntervalSec: number;
  faceBlinkThreshold: number;
  facePitchThreshold: number;
  faceGracePeriodSec: number;
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
  dailyLimitMax: null,
  maxReviewIntervalDays: null,
  bleEnabled: false,
  bleDeviceName: "",
  bleCalibrationData: null,
  faceEnabled: false,
  faceSampleIntervalSec: 10,
  faceBlinkThreshold: 0.25,
  facePitchThreshold: -0.08,
  faceGracePeriodSec: 2,
};
