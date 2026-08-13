#!/bin/bash
# Build the Chronote Camera companion (macOS only).
#
# The companion is a bare Swift executable that owns the camera and
# serves an MJPEG stream on localhost. Obsidian's binary lacks the camera
# entitlement, so the plugin spawns this instead.
#
# Output: companion/chronote-camera — ad-hoc signed with the camera
# entitlement and the Continuity Camera Info.plist key embedded.
#
# Run from the repo root: npm run build:companion
set -euo pipefail
cd "$(dirname "$0")"

swiftc -O -swift-version 5 \
  -o chronote-camera \
  Sources/chronote-camera/main.swift \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker Info.plist

codesign --force --sign - --entitlements chronote-camera.entitlements chronote-camera

echo "Built companion/chronote-camera"
