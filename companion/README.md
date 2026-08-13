# Chronote Camera companion

A tiny macOS executable that owns the camera and serves an MJPEG stream
on localhost. The Chronote plugin spawns it as a child process and runs
all face-detection logic in TypeScript (MediaPipe).

## Why it exists

Obsidian's binary lacks the `com.apple.security.device.camera`
entitlement, so `getUserMedia` cannot open a camera inside Obsidian on
macOS. The companion is a separate signed executable that *can* hold the
camera, and it streams frames to the plugin over `127.0.0.1`.

It prefers the **iPhone via Continuity Camera** (better range than the
MacBook's built-in camera) and falls back to the built-in front camera.

## Build

Requires Xcode Command Line Tools (`xcode-select --install`).

```sh
npm run build:companion
```

This compiles `Sources/chronote-camera/main.swift` and ad-hoc signs the
result with the camera entitlement. The binary lands at
`companion/chronote-camera` (git-ignored — build it once after cloning).

## First run

macOS will show a one-time permission prompt: *"chronote-camera would
like to access the camera"*. Allow it. If the iPhone is used, it must be
nearby and Continuity Camera enabled (System Settings → General →
AirDrop & Handoff → Continuity Camera).

## Protocol

- `GET http://127.0.0.1:47831/stream` → `multipart/x-mixed-replace`
  MJPEG stream (~10 fps, JPEG quality 0.7). A `<video>` element renders
  it natively.
- `--port <n>` overrides the port (default `47831`).

## Debug

Run it directly to see errors on stderr:

```sh
./companion/chronote-camera
curl -N http://127.0.0.1:47831/stream | head -c 100000 > /tmp/frame.jpg
```
