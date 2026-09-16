import CoreGraphics
import CoreMedia
import CoreVideo
import Foundation
@preconcurrency import ScreenCaptureKit

/// The process/window/config identity of one long-lived window stream.
///
/// A PID or Window Server id can be reused. The proven process identity keeps
/// a replacement process from inheriting frames captured for an earlier
/// lifetime, while the output dimensions force a fresh stream after a resize
/// or backing-scale change.
struct WindowCaptureStreamKey: Equatable, Sendable {
    let pid: pid_t
    let processIdentity: AXTreeProcessIdentity
    let windowID: CGWindowID
    let pixelWidth: Int
    let pixelHeight: Int
}

/// Current geometry plus the stable identity/config key used by the stream.
/// The display-relative stream crop depends on origin as well as dimensions.
/// Reuse requires this complete target, not only its process/window key.
struct WindowCaptureStreamTarget: Equatable, Sendable {
    let key: WindowCaptureStreamKey
    let originX: Double
    let originY: Double
    let pointWidth: Double
    let pointHeight: Double
    var pixelsPerPoint: Double? = nil
}

/// An immutable copy of the newest complete BGRA frame. The ScreenCaptureKit
/// pixel buffer is reused after its callback returns, so bytes must be copied
/// before crossing out of the sample queue.
struct WindowCaptureStreamFrame: Equatable, Sendable {
    let bytes: Data
    let width: Int
    let height: Int
    let bytesPerRow: Int
    let sequence: UInt64
    let receivedUptime: TimeInterval
}

/// Metadata only: inspecting stream health never fetches or serializes pixels.
struct WindowCaptureStreamSourceDiagnostic: Equatable, Sendable {
    let hasFailed: Bool
    let latestFrameSequence: UInt64?
    let latestFrameReceivedUptime: TimeInterval?
    let sampleCount: UInt64
    let latestSampleStatus: Int?
    let latestSampleReceivedUptime: TimeInterval?
}

struct WindowCaptureStreamDiagnostic: Equatable, Sendable {
    let generation: UInt64
    let activeKey: WindowCaptureStreamKey?
    let startingKey: WindowCaptureStreamKey?
    let hasFailed: Bool?
    let latestFrameSequence: UInt64?
    let latestFrameAgeSeconds: TimeInterval?
    let sampleCount: UInt64?
    let latestSampleStatus: Int?
    let latestSampleAgeSeconds: TimeInterval?
}

enum WindowCaptureFrameStatusPolicy {
    static func accepts(_ status: SCFrameStatus) -> Bool {
        status == .complete || status == .started
    }

    static func marksFailure(_ status: SCFrameStatus) -> Bool {
        status == .stopped
    }
}

@MainActor
protocol WindowCaptureProviding: AnyObject {
    func windowShot(
        pid: pid_t,
        processIdentity: AXTreeProcessIdentity,
        preferredWindowID: CGWindowID?,
        scale: Double?,
        newerThanUptime: TimeInterval?
    ) async -> WindowShot?

    /// Synchronously makes every current/late frame unusable, then retires the
    /// physical stream asynchronously so turn cleanup never waits on SCK.
    func invalidate()
}

@MainActor
protocol WindowCaptureStreamSource: AnyObject {
    var targetKey: WindowCaptureStreamKey { get }
    var hasFailed: Bool { get }
    func sampleDiagnostic() -> WindowCaptureStreamSourceDiagnostic
    func start() async throws
    func latestFrame() -> WindowCaptureStreamFrame?
    func retire()
}

@MainActor
protocol WindowCaptureStreamSourceFactory: AnyObject {
    func makeSource(for target: WindowCaptureStreamTarget) -> any WindowCaptureStreamSource
}

/// One daemon-owned capture session. A source starts on the first
/// `get_app_state`, remains alive across mutations, and is reused until the
/// process lifetime, window identity, or output configuration changes.
@MainActor
final class WindowCaptureStreamManager: WindowCaptureProviding {
    private struct Entry {
        let generation: UInt64
        let source: any WindowCaptureStreamSource
        let target: WindowCaptureStreamTarget
    }

    private let factory: any WindowCaptureStreamSourceFactory
    private let frameWaitAttempts: Int
    private let frameWaitNanoseconds: UInt64
    private let takeSnapshot: (WindowCaptureStreamTarget, Double?) async -> WindowShot?
    private var generation: UInt64 = 0
    private var starting: Entry?
    private var active: Entry?

    convenience init() {
        self.init(factory: ScreenCaptureKitWindowStreamSourceFactory())
    }

    init(
        factory: any WindowCaptureStreamSourceFactory,
        frameWaitAttempts: Int = 12,
        frameWaitNanoseconds: UInt64 = 50_000_000,
        takeSnapshot: @escaping (WindowCaptureStreamTarget, Double?) async -> WindowShot? = { target, scale in
            await Capture.windowShot(
                pid: target.key.pid,
                preferredWindowID: target.key.windowID,
                scale: scale,
                allowCLIFallback: false
            )
        }
    ) {
        self.factory = factory
        self.frameWaitAttempts = max(0, frameWaitAttempts)
        self.frameWaitNanoseconds = frameWaitNanoseconds
        self.takeSnapshot = takeSnapshot
    }

    func windowShot(
        pid: pid_t,
        processIdentity: AXTreeProcessIdentity,
        preferredWindowID: CGWindowID?,
        scale: Double?,
        newerThanUptime: TimeInterval?
    ) async -> WindowShot? {
        guard Capture.hasScreenRecordingPermission(),
              processIdentity.isProven,
              AXTree.currentProcessIdentity(pid: pid) == processIdentity else {
            invalidate()
            return nil
        }

        // Geometry may change while the first frame is in flight. Re-resolve
        // the exact AX window once and reconfigure instead of binding new
        // pixels to an old coordinate transform.
        for _ in 0..<2 {
            guard let target = Capture.windowCaptureStreamTarget(
                pid: pid,
                processIdentity: processIdentity,
                preferredWindowID: preferredWindowID,
                scale: scale
            ) else {
                invalidate()
                return nil
            }
            guard let shot = await captureSnapshot(
                for: target,
                scale: scale,
                newerThanUptime: newerThanUptime
            ) else {
                return nil
            }
            if let preferredWindowID,
               !TargetVisibilityPolicy.captureTargetStillMatches(
                   snapshotWindowID: preferredWindowID,
                   currentWindowID: AXTree.currentKeyWindowID(pid: pid)
               ) {
                // The AX snapshot and pixel target must describe the same key
                // window. A sheet/dialog can replace the key window while SCK
                // is waiting; retire this source so the router can rebuild the
                // entire snapshot against the replacement window.
                invalidate()
                return nil
            }
            guard AXTree.currentProcessIdentity(pid: pid) == processIdentity,
                  let current = Capture.windowCaptureStreamTarget(
                      pid: pid,
                      processIdentity: processIdentity,
                      preferredWindowID: target.key.windowID,
                      scale: scale
                  ) else {
                invalidate()
                return nil
            }
            guard current == target else {
                continue
            }
            return WindowShot(
                base64: shot.base64, width: shot.width, height: shot.height,
                originX: current.originX, originY: current.originY,
                pointWidth: current.pointWidth, pointHeight: current.pointHeight,
                windowID: current.key.windowID, source: .streamBackedScreenshot,
                pixelsPerPoint: shot.pixelsPerPoint,
                mimeType: shot.mimeType
            )
        }
        return nil
    }

    /// Match the reference's two separate lifetimes: SCStream remains a
    /// daemon-lifetime consumer while covered; every state read runs an
    /// on-demand Skyshot/SCK capture. The stream must have produced a real
    /// pixel frame before its on-demand screenshot may be treated as live.
    func captureSnapshot(
        for target: WindowCaptureStreamTarget,
        scale: Double?,
        newerThanUptime: TimeInterval? = nil
    ) async -> WindowShot? {
        // The stream is a long-lived render/freshness consumer, not the model
        // screenshot source. A brand-new source must deliver its first pixel
        // frame before we trust an on-demand screenshot for a covered window.
        // After an input mutation, the frame must additionally be newer than
        // the action watermark. `frame` performs one bounded rebuild for a
        // silently starved stream; if neither source produces qualifying
        // pixels, fail closed instead of labelling compositor-cached pixels as
        // stream-backed.
        guard await frame(
            for: target,
            newerThanUptime: newerThanUptime
        ) != nil else {
            return nil
        }
        for _ in 0..<2 {
            guard let source = await source(for: target) else { continue }
            if source.hasFailed {
                retire(source: source)
                continue
            }
            let snapshotGeneration = generation
            guard let shot = await takeSnapshot(target, scale),
                  snapshotGeneration == generation,
                  active?.source === source,
                  !source.hasFailed,
                  shot.source == .screenshotManager,
                  shot.windowID == target.key.windowID,
                  shot.width == target.key.pixelWidth,
                  shot.height == target.key.pixelHeight else {
                return nil
            }
            return shot
        }
        return nil
    }

    /// Internal transition seam used by deterministic tests. No TCC, AX, or
    /// real ScreenCaptureKit object is needed to prove lifecycle behavior.
    func frame(
        for target: WindowCaptureStreamTarget,
        newerThanUptime: TimeInterval?
    ) async -> WindowCaptureStreamFrame? {
        // One bounded restart is allowed after a start/delegate failure. A live
        // source that simply has not delivered a fresh frame remains installed
        // so the next get_app_state can reuse it.
        for restartAttempt in 0..<2 {
            guard let source = await source(for: target) else { continue }
            if source.hasFailed {
                retire(source: source)
                continue
            }
            if let frame = await waitForFrame(
                from: source,
                target: target,
                newerThanUptime: newerThanUptime
            ) {
                return frame
            }
            if source.hasFailed {
                retire(source: source)
                continue
            }
            if newerThanUptime != nil, restartAttempt == 0 {
                // A live stream can become silently suspended without a
                // delegate error. One bounded rebuild forces a new `.started`
                // frame and prevents every later post-mutation read from
                // timing out forever on the same starved source.
                retire(source: source)
                continue
            }
            return nil
        }
        return nil
    }

    func invalidate() {
        generation &+= 1
        let currentStarting = starting
        let currentActive = active
        starting = nil
        active = nil

        // `retire` first invalidates the callback mailbox synchronously. Old
        // queued callbacks therefore cannot populate a later generation even
        // if the asynchronous physical stop finishes after a new stream starts.
        currentStarting?.source.retire()
        if currentActive?.source !== currentStarting?.source {
            currentActive?.source.retire()
        }
    }

    var activeGenerationForTesting: UInt64? { active?.generation }
    var activeKeyForTesting: WindowCaptureStreamKey? { active?.source.targetKey }

    func diagnostic(
        now: TimeInterval = ProcessInfo.processInfo.systemUptime
    ) -> WindowCaptureStreamDiagnostic {
        let sample = (active ?? starting)?.source.sampleDiagnostic()
        return WindowCaptureStreamDiagnostic(
            generation: generation,
            activeKey: active?.source.targetKey,
            startingKey: starting?.source.targetKey,
            hasFailed: sample?.hasFailed,
            latestFrameSequence: sample?.latestFrameSequence,
            latestFrameAgeSeconds: sample?.latestFrameReceivedUptime.map { max(0, now - $0) },
            sampleCount: sample?.sampleCount,
            latestSampleStatus: sample?.latestSampleStatus,
            latestSampleAgeSeconds: sample?.latestSampleReceivedUptime.map { max(0, now - $0) }
        )
    }

    private func source(
        for target: WindowCaptureStreamTarget
    ) async -> (any WindowCaptureStreamSource)? {
        if let active,
           active.target == target,
           !active.source.hasFailed {
            return active.source
        }

        if let active {
            retire(source: active.source)
        }

        generation &+= 1
        let operationGeneration = generation
        let source = factory.makeSource(for: target)
        starting = Entry(generation: operationGeneration, source: source, target: target)

        do {
            try await source.start()
        } catch {
            if starting?.generation == operationGeneration {
                starting = nil
            }
            source.retire()
            return nil
        }

        guard generation == operationGeneration,
              starting?.generation == operationGeneration else {
            source.retire()
            return nil
        }
        starting = nil
        let installed = Entry(generation: operationGeneration, source: source, target: target)
        active = installed
        return installed.source
    }

    private func waitForFrame(
        from source: any WindowCaptureStreamSource,
        target: WindowCaptureStreamTarget,
        newerThanUptime: TimeInterval?
    ) async -> WindowCaptureStreamFrame? {
        for attempt in 0...frameWaitAttempts {
            if source.hasFailed { return nil }
            if let frame = source.latestFrame(),
               frame.width == target.key.pixelWidth,
               frame.height == target.key.pixelHeight,
               newerThanUptime.map({ frame.receivedUptime > $0 }) ?? true {
                return frame
            }
            guard attempt < frameWaitAttempts else { break }
            if frameWaitNanoseconds == 0 {
                await Task.yield()
            } else {
                try? await Task.sleep(nanoseconds: frameWaitNanoseconds)
            }
        }
        return nil
    }

    private func retire(source: any WindowCaptureStreamSource) {
        generation &+= 1
        if active?.source === source { active = nil }
        if starting?.source === source { starting = nil }
        source.retire()
    }
}

@MainActor
private final class ScreenCaptureKitWindowStreamSourceFactory: WindowCaptureStreamSourceFactory {
    func makeSource(
        for target: WindowCaptureStreamTarget
    ) -> any WindowCaptureStreamSource {
        ScreenCaptureKitWindowStreamSource(target: target)
    }
}

/// The real SCK stream. Lifecycle stays on MainActor; sample delivery is copied
/// on one serial queue into the lock-backed mailbox below.
@MainActor
final class ScreenCaptureKitWindowStreamSource: WindowCaptureStreamSource {
    private static let sampleQueue = DispatchQueue(
        label: "dev.cchaha.cu-helper.window-stream.frames",
        qos: .userInitiated
    )
    private static let startTimeout: TimeInterval = 2.5

    let targetKey: WindowCaptureStreamKey
    private let target: WindowCaptureStreamTarget
    private let output = WindowCaptureStreamMailbox()
    private var stream: SCStream?
    private var retired = false

    init(target: WindowCaptureStreamTarget) {
        self.target = target
        self.targetKey = target.key
    }

    var hasFailed: Bool { output.hasFailed }

    func sampleDiagnostic() -> WindowCaptureStreamSourceDiagnostic {
        output.sampleDiagnostic()
    }

    func latestFrame() -> WindowCaptureStreamFrame? {
        output.latestFrame()
    }

    func start() async throws {
        guard !retired else {
            throw CUError("capture_failed", "Window stream was retired before it started")
        }

        // Bound the whole startup, including SCShareableContent enumeration.
        // That API can wedge before an SCStream exists, so timing only
        // `startCapture()` would still let the daemon request hang indefinitely.
        let gate = SCStreamStartGate()
        let startTask = Task { @MainActor in
            try await self.startCaptureWithoutTimeout()
        }
        Task { @MainActor in
            do {
                try await startTask.value
                gate.resolve(.success)
            } catch {
                gate.resolve(.failure(error.localizedDescription))
            }
        }
        DispatchQueue.global(qos: .userInitiated).asyncAfter(
            deadline: .now() + Self.startTimeout
        ) {
            gate.resolve(.failure("Timed out starting the window stream"))
        }

        switch await gate.wait() {
        case .success:
            guard !retired else {
                throw CUError("capture_failed", "Window stream was retired while starting")
            }
        case .failure(let message):
            startTask.cancel()
            retire()
            throw CUError("capture_failed", message)
        }
    }

    private func startCaptureWithoutTimeout() async throws {
        let content: SCShareableContent
        do {
            content = try await SCShareableContent.excludingDesktopWindows(
                false,
                onScreenWindowsOnly: false
            )
        } catch {
            throw CUError(
                "capture_failed",
                "SCShareableContent failed for window stream: \(error.localizedDescription)"
            )
        }

        guard !retired,
              let window = content.windows.first(where: {
                  $0.windowID == targetKey.windowID
                      && $0.owningApplication?.processID == targetKey.pid
              }) else {
            throw CUError(
                "capture_failed",
                "The exact target window disappeared before streaming started"
            )
        }

        guard let region = Self.displayCaptureRegion(
            windowFrame: window.frame, displayFrames: content.displays.map(\.frame)
        ) else {
            throw CUError("capture_failed", "The target window does not intersect a capture display")
        }
        // A desktop-independent stream can keep delivering compositor frames
        // while an occluded CEF renderer stops responding. The reference's
        // display/window filter keeps the renderer live. Include only the
        // authorized window; model screenshots still use Capture.windowShot.
        let filter = SCContentFilter(
            display: content.displays[region.displayIndex], including: [window]
        )
        let configuration = Self.makeConfiguration(for: target, sourceRect: region.sourceRect)
        let stream = SCStream(
            filter: filter,
            configuration: configuration,
            delegate: output
        )
        do {
            try stream.addStreamOutput(
                output,
                type: .screen,
                sampleHandlerQueue: Self.sampleQueue
            )
        } catch {
            throw CUError(
                "capture_failed",
                "Adding the window stream output failed: \(error.localizedDescription)"
            )
        }
        self.stream = stream
        try await stream.startCapture()
        guard !retired else {
            throw CUError("capture_failed", "Window stream was retired while starting")
        }
    }

    func retire() {
        guard !retired else { return }
        retired = true
        output.invalidate()
        guard let stream else { return }
        self.stream = nil

        // Do not await SCK shutdown on target replacement, disconnect, or
        // daemon teardown. The mailbox is already inert, and retaining the
        // stream in this completion closure lets ScreenCaptureKit finish
        // cleanup without delaying the request.
        Task { @MainActor in
            try? await stream.stopCapture()
        }
    }

    static func displayCaptureRegion(
        windowFrame: CGRect, displayFrames: [CGRect]
    ) -> (displayIndex: Int, sourceRect: CGRect)? {
        var selected: (displayIndex: Int, sourceRect: CGRect)?
        var largestArea: CGFloat = 0
        for (index, displayFrame) in displayFrames.enumerated() {
            guard [displayFrame.minX, displayFrame.minY, displayFrame.maxX, displayFrame.maxY]
                .allSatisfy(\.isFinite), !displayFrame.isInfinite else { continue }
            let intersection = windowFrame.intersection(displayFrame)
            guard !intersection.isNull, !intersection.isEmpty else { continue }
            let area = intersection.width * intersection.height
            guard area.isFinite, area > largestArea else { continue }
            largestArea = area
            selected = (
                index,
                intersection.offsetBy(dx: -displayFrame.minX, dy: -displayFrame.minY)
            )
        }
        return selected
    }

    static func makeConfiguration(
        for target: WindowCaptureStreamTarget, sourceRect: CGRect? = nil
    ) -> SCStreamConfiguration {
        let configuration = SCStreamConfiguration()
        configuration.width = max(1, target.key.pixelWidth)
        configuration.height = max(1, target.key.pixelHeight)
        if let sourceRect { configuration.sourceRect = sourceRect }
        configuration.shouldBeOpaque = false
        // Match Codex's long-lived window stream cadence and buffering. This
        // keeps a continuous WindowServer consumer for an occluded renderer;
        // it is not a polling screenshot throttle.
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: 60)
        configuration.queueDepth = 5
        configuration.showsCursor = false
        configuration.capturesAudio = false
        configuration.scalesToFit = true
        configuration.preservesAspectRatio = true
        configuration.pixelFormat = kCVPixelFormatType_32BGRA
        configuration.colorSpaceName = CGColorSpace.sRGB
        configuration.captureResolution = .best
        configuration.ignoreShadowsSingleWindow = true
        configuration.ignoreShadowsDisplay = true
        return configuration
    }
}

/// Only pixel-bearing ScreenCaptureKit frames enter this one-frame mailbox.
/// `.started` is the first generated frame after start and `.complete` is a
/// later generated frame. Idle, blank, suspended, and stopped notifications
/// never advance sequence or satisfy a post-mutation freshness watermark.
final class WindowCaptureStreamMailbox: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var accepting = true
    private var failed = false
    private var sequence: UInt64 = 0
    private var frame: WindowCaptureStreamFrame?
    private var sampleCount: UInt64 = 0
    private var latestSampleStatus: Int?
    private var latestSampleReceivedUptime: TimeInterval?

    var hasFailed: Bool {
        lock.lock()
        defer { lock.unlock() }
        return failed
    }

    func latestFrame() -> WindowCaptureStreamFrame? {
        lock.lock()
        defer { lock.unlock() }
        return accepting ? frame : nil
    }

    func sampleDiagnostic() -> WindowCaptureStreamSourceDiagnostic {
        lock.lock()
        defer { lock.unlock() }
        return WindowCaptureStreamSourceDiagnostic(
            hasFailed: failed,
            latestFrameSequence: frame?.sequence,
            latestFrameReceivedUptime: frame?.receivedUptime,
            sampleCount: sampleCount,
            latestSampleStatus: latestSampleStatus,
            latestSampleReceivedUptime: latestSampleReceivedUptime
        )
    }

    func recordSampleStatus(_ status: SCFrameStatus, receivedUptime: TimeInterval) {
        lock.lock()
        defer { lock.unlock() }
        guard accepting else { return }
        sampleCount &+= 1
        latestSampleStatus = status.rawValue
        latestSampleReceivedUptime = receivedUptime
    }

    func invalidate() {
        lock.lock()
        accepting = false
        frame = nil
        lock.unlock()
    }

    func stream(
        _ stream: SCStream,
        didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of outputType: SCStreamOutputType
    ) {
        guard outputType == .screen,
              sampleBuffer.isValid,
              sampleBuffer.dataReadiness == .ready,
              let status = Self.frameStatus(sampleBuffer) else {
            return
        }
        recordSampleStatus(status, receivedUptime: ProcessInfo.processInfo.systemUptime)
        if WindowCaptureFrameStatusPolicy.marksFailure(status) {
            markFailed()
            return
        }
        guard WindowCaptureFrameStatusPolicy.accepts(status),
              let pixelBuffer = sampleBuffer.imageBuffer,
              CVPixelBufferGetPixelFormatType(pixelBuffer) == kCVPixelFormatType_32BGRA else {
            return
        }
        // Timestamp callback arrival before copying. A mutation can land on the
        // main actor while a large pixel buffer is being copied; stamping after
        // that copy would make pre-mutation pixels look post-mutation fresh.
        let receivedUptime = ProcessInfo.processInfo.systemUptime

        CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }
        guard let baseAddress = CVPixelBufferGetBaseAddress(pixelBuffer) else { return }

        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)
        let bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)
        let (minimumBytesPerRow, rowOverflow) = width.multipliedReportingOverflow(by: 4)
        let (byteCount, overflow) = bytesPerRow.multipliedReportingOverflow(by: height)
        guard width > 0,
              height > 0,
              !rowOverflow,
              bytesPerRow >= minimumBytesPerRow,
              !overflow else {
            return
        }

        let copied = Data(bytes: baseAddress, count: byteCount)

        lock.lock()
        guard accepting else {
            lock.unlock()
            return
        }
        sequence &+= 1
        frame = WindowCaptureStreamFrame(
            bytes: copied,
            width: width,
            height: height,
            bytesPerRow: bytesPerRow,
            sequence: sequence,
            receivedUptime: receivedUptime
        )
        lock.unlock()
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        markFailed()
    }

    private func markFailed() {
        lock.lock()
        if accepting {
            failed = true
            frame = nil
        }
        lock.unlock()
    }

    private static func frameStatus(_ sampleBuffer: CMSampleBuffer) -> SCFrameStatus? {
        guard
            let attachments = CMSampleBufferGetSampleAttachmentsArray(
                sampleBuffer,
                createIfNecessary: false
            ) as? [[SCStreamFrameInfo: Any]],
            let rawStatus = attachments.first?[.status] as? Int,
            let status = SCFrameStatus(rawValue: rawStatus)
        else {
            return nil
        }
        return status
    }
}

private final class SCStreamStartGate: @unchecked Sendable {
    enum Outcome: Sendable {
        case success
        case failure(String)
    }

    private let lock = NSLock()
    private var outcome: Outcome?
    private var continuation: CheckedContinuation<Outcome, Never>?

    func wait() async -> Outcome {
        await withCheckedContinuation { continuation in
            lock.lock()
            if let outcome {
                lock.unlock()
                continuation.resume(returning: outcome)
            } else {
                self.continuation = continuation
                lock.unlock()
            }
        }
    }

    func resolve(_ outcome: Outcome) {
        let continuation: CheckedContinuation<Outcome, Never>?
        lock.lock()
        guard self.outcome == nil else {
            lock.unlock()
            return
        }
        self.outcome = outcome
        continuation = self.continuation
        self.continuation = nil
        lock.unlock()
        continuation?.resume(returning: outcome)
    }
}

@available(macOS 14.0, *)
@MainActor
extension Capture {
    static func windowCaptureStreamTarget(
        pid: pid_t,
        processIdentity: AXTreeProcessIdentity,
        preferredWindowID: CGWindowID?,
        scale: Double?
    ) -> WindowCaptureStreamTarget? {
        guard processIdentity.isProven,
              let candidate = bestWindow(
                  forPid: pid,
                  preferredWindowID: preferredWindowID
              ) else {
            return nil
        }
        let frame = candidate.frame
        guard frame.width > 1, frame.height > 1 else { return nil }

        let backingScale = backingScaleFactor(forWindowFrame: frame)
        let outputScale = scale.flatMap { $0 > 0 ? $0 : nil } ?? NativeScreenshotPolicy.scale(
            pointSize: frame.size, backingScale: backingScale
        )
        let width = max(1, Int(ceil(frame.width * backingScale * outputScale)))
        let height = max(1, Int(ceil(frame.height * backingScale * outputScale)))
        return WindowCaptureStreamTarget(
            key: WindowCaptureStreamKey(
                pid: pid,
                processIdentity: processIdentity,
                windowID: candidate.windowID,
                pixelWidth: width,
                pixelHeight: height
            ),
            originX: Double(frame.origin.x),
            originY: Double(frame.origin.y),
            pointWidth: Double(frame.width),
            pointHeight: Double(frame.height),
            pixelsPerPoint: backingScale * outputScale
        )
    }

    static func windowShot(
        from frame: WindowCaptureStreamFrame,
        target: WindowCaptureStreamTarget
    ) -> WindowShot? {
        guard frame.width == target.key.pixelWidth,
              frame.height == target.key.pixelHeight,
              let image = image(from: frame),
              let encoded = pngBase64WithSize(image) else {
            return nil
        }
        return WindowShot(
            base64: encoded.base64,
            width: encoded.width,
            height: encoded.height,
            originX: target.originX,
            originY: target.originY,
            pointWidth: target.pointWidth,
            pointHeight: target.pointHeight,
            windowID: target.key.windowID,
            source: .stream,
            pixelsPerPoint: target.pixelsPerPoint
        )
    }

    private static func image(from frame: WindowCaptureStreamFrame) -> CGImage? {
        let (minimumBytesPerRow, rowOverflow) = frame.width.multipliedReportingOverflow(by: 4)
        let (minimumByteCount, countOverflow) = frame.bytesPerRow.multipliedReportingOverflow(
            by: frame.height
        )
        guard frame.width > 0,
              frame.height > 0,
              !rowOverflow,
              !countOverflow,
              frame.bytesPerRow >= minimumBytesPerRow,
              frame.bytes.count >= minimumByteCount,
              let provider = CGDataProvider(data: frame.bytes as CFData),
              let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) else {
            return nil
        }
        let bitmapInfo = CGBitmapInfo.byteOrder32Little.union(
            CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedFirst.rawValue)
        )
        return CGImage(
            width: frame.width,
            height: frame.height,
            bitsPerComponent: 8,
            bitsPerPixel: 32,
            bytesPerRow: frame.bytesPerRow,
            space: colorSpace,
            bitmapInfo: bitmapInfo,
            provider: provider,
            decode: nil,
            shouldInterpolate: true,
            intent: .defaultIntent
        )
    }
}
