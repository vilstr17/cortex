export type BleFocusState = "LOCKED_IN" | "DISTRACTED" | "NO_PHONE" | "DISABLED";

export interface BleCalibration {
	target_rssi: number;
	tolerance: number;
	device_name: string;
}

export interface BleStatus {
	rawRssi: number | null;
	smoothedRssi: number | null;
	phoneFound: boolean;
	lastSeen: number;
	scanning: boolean;
	deviceName: string | null;
}

export interface BleDevice {
	uuid: string;
	name: string;
	rssi: number;
}

export function computeCalibration(readings: number[]): BleCalibration | null {
	if (readings.length === 0) return null;
	const avg = readings.reduce((a, b) => a + b, 0) / readings.length;
	return {
		target_rssi: Math.round(avg * 10) / 10,
		tolerance: 0.1,
		device_name: "",
	};
}

export function classifyRssi(
	smoothedRssi: number | null,
	calibration: BleCalibration | null,
): BleFocusState {
	if (smoothedRssi === null || calibration === null) return "NO_PHONE";

	const { target_rssi, tolerance } = calibration;
	const low = Math.min(target_rssi * (1 - tolerance), target_rssi * (1 + tolerance));
	const high = Math.max(target_rssi * (1 - tolerance), target_rssi * (1 + tolerance));

	if (smoothedRssi >= low && smoothedRssi <= high) {
		return "DISTRACTED";
	}

	return "LOCKED_IN";
}