const http = require("node:http");
const noble = require("@abandonware/noble");

const EMA_ALPHA = 0.8;
const SESSION_TIMEOUT_MS = 5000;
// If no advertisement (from any device) arrives for this long while we are
// supposed to be scanning, CoreBluetooth has likely stalled — restart the scan.
const STALE_SCAN_RESTART_MS = 8000;
const WATCHDOG_INTERVAL_MS = 2500;

let scanConfig = null;
let sessionAddress = null;
let scanning = false;
let watchdogTimer = null;
let lastAdvertAt = 0;

let rawRssi = null;
let smoothedRssi = null;
let lastSeen = 0;
let foundDeviceName = null;

function applyEma(newRssi) {
	if (smoothedRssi === null || smoothedRssi === undefined) {
		smoothedRssi = newRssi;
	} else {
		smoothedRssi = EMA_ALPHA * newRssi + (1 - EMA_ALPHA) * smoothedRssi;
	}
}

function checkSessionTimeout() {
	if (sessionAddress && lastSeen > 0 && (Date.now() - lastSeen) > SESSION_TIMEOUT_MS) {
		console.log("[ble-scanner] Session timed out, resetting for re-discovery");
		sessionAddress = null;
		smoothedRssi = null;
		rawRssi = null;
	}
}

function onDiscover(peripheral) {
	lastAdvertAt = Date.now();

	const rssi = peripheral.rssi;
	if (rssi === undefined || rssi === null) return;
	if (rssi > 0) return;

	const name = peripheral.advertisement?.localName ?? "";
	const uuid = (peripheral.uuid ?? "").toUpperCase();

	if (sessionAddress) {
		if (uuid === sessionAddress) {
			rawRssi = rssi;
			applyEma(rssi);
			lastSeen = Date.now();
			if (name) foundDeviceName = name;
		}
		return;
	}

	if (!scanConfig) return;

	if (scanConfig.mode === "name" && scanConfig.name && name) {
		if (name.toLowerCase().includes(scanConfig.name.toLowerCase())) {
			sessionAddress = uuid;
			foundDeviceName = name;
			rawRssi = rssi;
			smoothedRssi = rssi;
			lastSeen = Date.now();
			console.log(`[ble-scanner] Found "${name}" at ${uuid} RSSI=${rssi}`);
		}
	}

	if (scanConfig.mode === "all") {
		rawRssi = rssi;
		applyEma(rssi);
		lastSeen = Date.now();
		if (name) foundDeviceName = name;
	}
}

noble.on("discover", onDiscover);

async function startContinuousScan() {
	try {
		// Continuous scan with duplicates enabled — one start instead of a
		// start/stop cycle every 800ms, which thrashes CoreBluetooth and
		// drops advertisements.
		await noble.startScanningAsync([], true);
		scanning = true;
		lastAdvertAt = Date.now();
		startWatchdog();
		console.log("[ble-scanner] Continuous scan started, config:", JSON.stringify(scanConfig));
	} catch (e) {
		console.error("[ble-scanner] startScanningAsync error:", e.message);
	}
}

function stopContinuousScan() {
	scanning = false;
	stopWatchdog();
	try {
		noble.stopScanning();
	} catch (_) {}
	rawRssi = null;
	smoothedRssi = null;
	sessionAddress = null;
	foundDeviceName = null;
	scanConfig = null;
}

function startWatchdog() {
	stopWatchdog();
	watchdogTimer = setInterval(async () => {
		if (!scanning) return;
		checkSessionTimeout();
		if (Date.now() - lastAdvertAt > STALE_SCAN_RESTART_MS) {
			console.log("[ble-scanner] No advertisements recently, restarting scan");
			try {
				noble.stopScanning();
				await noble.startScanningAsync([], true);
				lastAdvertAt = Date.now();
			} catch (e) {
				console.error("[ble-scanner] Watchdog restart failed:", e.message);
			}
		}
	}, WATCHDOG_INTERVAL_MS);
}

function stopWatchdog() {
	if (watchdogTimer) {
		clearInterval(watchdogTimer);
		watchdogTimer = null;
	}
}

function getStatus() {
	return {
		rawRssi,
		smoothedRssi: smoothedRssi !== null ? Math.round(smoothedRssi * 10) / 10 : null,
		phoneFound: smoothedRssi !== null,
		lastSeen,
		scanning,
		deviceName: foundDeviceName,
		sessionAddress,
	};
}

function discoverDevices(durationSec) {
	const seen = {};
	let stopped = false;

	return new Promise((resolve) => {
		const handler = (peripheral) => {
			if (stopped) return;
			const uuid = (peripheral.uuid ?? "").trim();
			if (!uuid) return;
			const rssi = peripheral.rssi;
			if (rssi === undefined || rssi === null) return;
			if (rssi > 0) return;

			const name = (peripheral.advertisement?.localName ?? "").trim();

			if (seen[uuid]) {
				if (rssi > seen[uuid].rssi) {
					seen[uuid].rssi = rssi;
					seen[uuid].name = name || seen[uuid].name;
				}
			} else {
				seen[uuid] = { uuid, name, rssi };
			}
		};

		noble.on("discover", handler);

		noble.startScanningAsync([], true).then(() => {
			setTimeout(() => {
				stopped = true;
				noble.stopScanning();
				noble.removeListener("discover", handler);
				const list = Object.values(seen);
				list.sort((a, b) => b.rssi - a.rssi);
				resolve(list);
			}, durationSec * 1000);
		}).catch(() => {
			stopped = true;
			noble.removeListener("discover", handler);
			resolve([]);
		});
	});
}

const server = http.createServer((req, res) => {
	res.setHeader("Content-Type", "application/json");
	res.setHeader("Access-Control-Allow-Origin", "*");
	res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
	res.setHeader("Access-Control-Allow-Headers", "Content-Type");

	if (req.method === "OPTIONS") {
		res.writeHead(204);
		res.end();
		return;
	}

	const url = new URL(req.url, "http://localhost");

	if (req.method === "POST" && url.pathname === "/start") {
		let body = "";
		req.on("data", chunk => { body += chunk; });
		req.on("end", async () => {
			try {
				const data = JSON.parse(body);

				scanConfig = {};
				sessionAddress = null;
				foundDeviceName = null;
				rawRssi = null;
				smoothedRssi = null;

				if (data.name) {
					scanConfig.mode = "name";
					scanConfig.name = data.name;
					console.log(`[ble-scanner] Start scanning for name "${data.name}"`);
				} else {
					scanConfig.mode = "all";
					console.log("[ble-scanner] Start scanning all devices");
				}

				if (noble.state === "poweredOn") {
					if (!scanning) await startContinuousScan();
					res.writeHead(200);
					res.end(JSON.stringify({ success: true }));
				} else {
					res.writeHead(503);
					res.end(JSON.stringify({
						success: false,
						error: `Bluetooth state: ${noble.state}`,
					}));
				}
			} catch (e) {
				res.writeHead(400);
				res.end(JSON.stringify({ success: false, error: e.message }));
			}
		});
		return;
	}

	if (req.method === "POST" && url.pathname === "/stop") {
		stopContinuousScan();
		res.writeHead(200);
		res.end(JSON.stringify({ success: true }));
		return;
	}

	if (req.method === "POST" && url.pathname === "/discover") {
		let body = "";
		req.on("data", chunk => { body += chunk; });
		req.on("end", async () => {
			try {
				const data = JSON.parse(body || "{}");
				const duration = data.duration || 8;

				const wasScanning = scanning;
				if (wasScanning) {
					stopContinuousScan();
					await new Promise(r => setTimeout(r, 400));
				}

				const devices = await discoverDevices(duration);

				res.writeHead(200);
				res.end(JSON.stringify({ devices }));
			} catch (e) {
				res.writeHead(500);
				res.end(JSON.stringify({ error: e.message }));
			}
		});
		return;
	}

	if (req.method === "GET" && url.pathname === "/status") {
		res.writeHead(200);
		res.end(JSON.stringify(getStatus()));
		return;
	}

	if (req.method === "GET" && url.pathname === "/health") {
		res.writeHead(200);
		res.end(JSON.stringify({ ok: true, bleState: noble.state }));
		return;
	}

	res.writeHead(404);
	res.end(JSON.stringify({ error: "not found" }));
});

const PORT = 18888;

noble.on("stateChange", async (state) => {
	console.log(`[ble-scanner] Bluetooth state: ${state}`);
	if (state === "poweredOn" && scanConfig && !scanning) {
		// Bluetooth came (back) up while a scan was requested — resume.
		await startContinuousScan();
	} else if (state !== "poweredOn" && scanning) {
		scanning = false;
		stopWatchdog();
	}
});

server.listen(PORT, "127.0.0.1", () => {
	console.log(`[ble-scanner] HTTP API on 127.0.0.1:${PORT}`);
});
