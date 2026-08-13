/**
 * Chronote Camera companion process.
 *
 * On macOS Obsidian's binary lacks the camera entitlement, so the
 * plugin cannot open a camera itself. The companion is a tiny local
 * Swift binary (`companion/chronote-camera`) that owns the camera
 * (built-in or iPhone via Continuity Camera) and serves an MJPEG stream
 * on localhost. This module spawns / kills it as a child process —
 * the same pattern the old BLE scanner used.
 *
 * The binary is built with `npm run build:companion` (see
 * `companion/README.md`) and lives at `<plugin dir>/companion/`.
 */

import { spawn, type ChildProcess } from "child_process";
import { connect } from "net";

/** Port the companion serves the MJPEG stream on. */
export const COMPANION_PORT = 47831;
export const COMPANION_STREAM_URL = `http://127.0.0.1:${COMPANION_PORT}/stream`;

/** How long to wait for the companion's HTTP server to come up. */
const START_TIMEOUT_MS = 10000;

export class CompanionProcess {
  private proc: ChildProcess | null = null;
  private binaryPath: string;

  constructor(binaryPath: string) {
    this.binaryPath = binaryPath;
  }

  get isRunning(): boolean {
    return this.proc !== null && this.proc.exitCode === null;
  }

  /**
   * Spawn the companion and wait until its stream port accepts
   * connections. Returns false when the binary is missing or the
   * server never comes up.
   */
  async start(): Promise<boolean> {
    if (this.isRunning) return true;
    try {
      this.proc = spawn(this.binaryPath, ["--port", String(COMPANION_PORT)], {
        stdio: "ignore",
      });
    } catch (err) {
      console.error("[chronote] Companion spawn failed:", err);
      this.proc = null;
      return false;
    }
    this.proc.on("exit", () => {
      this.proc = null;
    });
    return this.waitForPort();
  }

  stop(): void {
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
  }

  private waitForPort(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const deadline = Date.now() + START_TIMEOUT_MS;
      const attempt = () => {
        if (Date.now() > deadline) {
          resolve(false);
          return;
        }
        const socket = connect(COMPANION_PORT, "127.0.0.1");
        socket.setTimeout(1000);
        socket.once("connect", () => {
          socket.destroy();
          resolve(true);
        });
        socket.once("error", () => {
          socket.destroy();
          setTimeout(attempt, 200);
        });
        socket.once("timeout", () => {
          socket.destroy();
          setTimeout(attempt, 200);
        });
      };
      attempt();
    });
  }
}
