// Chronote Camera companion.
//
// Obsidian's binary lacks the camera entitlement, so the plugin cannot
// open a camera itself on macOS. This tiny local executable owns the
// camera (built-in FaceTime HD, or the iPhone via Continuity Camera) and
// serves an MJPEG stream on localhost. The plugin spawns it as a child
// process and the TypeScript FaceDetector reads the stream from a
// <video> element.
//
// Usage: chronote-camera [--port <n>]   (default port 47831)
//
// The stream is served at http://127.0.0.1:<port>/stream as
// multipart/x-mixed-replace, which a <video> element renders natively.

import AVFoundation
import CoreImage
import Foundation
import Network

// ── Argument parsing ─────────────────────────────────────────────
var port: UInt16 = 47831
let args = CommandLine.arguments
var i = 1
while i < args.count {
    switch args[i] {
    case "--port":
        if i + 1 < args.count, let p = UInt16(args[i + 1]) { port = p }
        i += 2
    default:
        i += 1
    }
}

// ── JPEG encoder (BGRA pixel buffer → JPEG) ──────────────────────
final class JpegEncoder {
    private let context = CIContext()

    func encode(_ sampleBuffer: CMSampleBuffer) -> Data? {
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return nil }
        let image = CIImage(cvPixelBuffer: pixelBuffer)
        guard let cgImage = context.createCGImage(image, from: image.extent) else { return nil }
        let data = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(data, "public.jpeg" as CFString, 1, nil) else {
            return nil
        }
        let props: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: 0.7]
        CGImageDestinationAddImage(dest, cgImage, props as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { return nil }
        return data as Data
    }
}

// ── MJPEG server ─────────────────────────────────────────────────
final class MJpegServer {
    private let boundary = "chronote-frame"
    private var listener: NWListener?
    private var connections: [NWConnection] = []
    private let queue = DispatchQueue(label: "chronote.mjpeg")

    func start(port: UInt16) throws {
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        params.requiredLocalEndpoint = NWEndpoint.hostPort(
            host: "127.0.0.1",
            port: NWEndpoint.Port(rawValue: port)!
        )
        let listener = try NWListener(using: params)
        listener.newConnectionHandler = { [weak self] conn in
            self?.handle(conn)
        }
        listener.start(queue: queue)
        self.listener = listener
    }

    private func handle(_ conn: NWConnection) {
        conn.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                self?.sendHeader(conn)
            case .failed, .cancelled:
                self?.drop(conn)
            default:
                break
            }
        }
        conn.start(queue: queue)
    }

    private func sendHeader(_ conn: NWConnection) {
        let header = """
        HTTP/1.1 200 OK\r
        Content-Type: multipart/x-mixed-replace; boundary=\(boundary)\r
        Cache-Control: no-cache\r
        \r
        """
        conn.send(content: Data(header.utf8), completion: .contentProcessed { _ in })
        queue.async { [weak self] in
            self?.connections.append(conn)
        }
    }

    private func drop(_ conn: NWConnection) {
        queue.async { [weak self] in
            self?.connections.removeAll { $0 === conn }
        }
    }

    func broadcast(_ jpeg: Data) {
        queue.async { [weak self] in
            guard let self = self else { return }
            var frame = Data()
            frame.append(Data("--\(self.boundary)\r\n".utf8))
            frame.append(Data("Content-Type: image/jpeg\r\n".utf8))
            frame.append(Data("Content-Length: \(jpeg.count)\r\n\r\n".utf8))
            frame.append(jpeg)
            frame.append(Data("\r\n".utf8))
            for conn in self.connections {
                conn.send(content: frame, completion: .contentProcessed { _ in })
            }
        }
    }
}

// ── Frame handler (camera → JPEG → server) ───────────────────────
final class FrameHandler: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    private let encoder: JpegEncoder
    private let server: MJpegServer
    private var lastFrameAt: TimeInterval = 0
    private let minInterval: TimeInterval = 1.0 / 10.0  // 10 fps is plenty for face detection

    init(encoder: JpegEncoder, server: MJpegServer) {
        self.encoder = encoder
        self.server = server
    }

    func captureOutput(
        _ output: AVCaptureOutput,
        didOutput sampleBuffer: CMSampleBuffer,
        from connection: AVCaptureConnection
    ) {
        let now = ProcessInfo.processInfo.systemUptime
        guard now - lastFrameAt >= minInterval else { return }
        lastFrameAt = now
        if let jpeg = encoder.encode(sampleBuffer) {
            server.broadcast(jpeg)
        }
    }
}

// ── Camera setup ─────────────────────────────────────────────────
// Prefer the iPhone (Continuity Camera) — the user's phone has better
// range than the MacBook's built-in camera — then fall back to the
// built-in front camera.
let device: AVCaptureDevice? =
    AVCaptureDevice.default(.continuityCamera, for: .video, position: .unspecified)
    ?? AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .front)
    ?? AVCaptureDevice.default(for: .video)

guard let device else {
    fputs("chronote-camera: no camera device found\n", stderr)
    exit(1)
}

let session = AVCaptureSession()
session.sessionPreset = .medium

do {
    let input = try AVCaptureDeviceInput(device: device)
    guard session.canAddInput(input) else {
        fputs("chronote-camera: cannot add camera input\n", stderr)
        exit(1)
    }
    session.addInput(input)
} catch {
    fputs("chronote-camera: camera unavailable: \(error)\n", stderr)
    exit(1)
}

let server = MJpegServer()
do {
    try server.start(port: port)
} catch {
    fputs("chronote-camera: cannot bind port \(port): \(error)\n", stderr)
    exit(1)
}

let encoder = JpegEncoder()
let handler = FrameHandler(encoder: encoder, server: server)

let output = AVCaptureVideoDataOutput()
output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
output.alwaysDiscardsLateVideoFrames = true
output.setSampleBufferDelegate(handler, queue: DispatchQueue(label: "chronote.camera"))
guard session.canAddOutput(output) else {
    fputs("chronote-camera: cannot add video output\n", stderr)
    exit(1)
}
session.addOutput(output)

session.startRunning()
guard session.isRunning else {
    fputs("chronote-camera: camera failed to start (in use by another app?)\n", stderr)
    exit(1)
}

fputs("chronote-camera: streaming on http://127.0.0.1:\(port)/stream\n", stderr)

// Keep the process alive until killed. The camera and server run on
// their own queues; the main thread just idles.
dispatchMain()
