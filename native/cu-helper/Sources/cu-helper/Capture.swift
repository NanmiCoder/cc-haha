//
//  Capture.swift
//  cu-helper
//
//  ScreenCaptureKit-backed screen capture for the `screenshot`, `zoom`, and
//  `resolve_prepare_capture` commands.
//
//  Pipeline (matches FULL PLAN + runtime/mac_helper.py parity):
//    CGPreflightScreenCaptureAccess() gate
//      -> CUError("screen_recording_denied") on the HOT path. We NEVER auto-call
//         CGRequestScreenCaptureAccess() here — that belongs to onboarding only,
//         and prompting from the per-command/daemon hot path would be a
//         surprising side effect.
//    SCShareableContent.current
//      -> resolve the target SCDisplay by CGDirectDisplayID
//    SCContentFilter(display:excludingWindows: [])
//      -> full-display content (desktop + dock included, no window filtering in v1)
//    SCStreamConfiguration
//      -> width/height = OUTPUT pixels (already computed by the TS layer; we do
//         NOT re-apply scaleFactor), sourceRect in DISPLAY-LOCAL points for zoom,
//         showsCursor=false, scalesToFit=true, pixelFormat=32BGRA, sRGB color.
//    SCScreenshotManager.captureImage(contentFilter:configuration:)
//      -> CGImage
//    ImageIO (CGImageDestination + kCGImageDestinationLossyCompressionQuality)
//      -> JPEG bytes -> base64
//
//  Reported `width`/`height` are read back from the PRODUCED CGImage (the actual
//  output pixel dimensions), exactly like mac_helper.py reads image.width/height.
//
//  Coordinate contract: every coordinate arriving here is already logical /
//  output-sized by the TypeScript layer (src/utils/computerUse/executor.ts:
//  computeTargetDims). Capture.swift must NOT re-scale.
//

import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

enum WindowShotCaptureSource: String, Equatable, Sendable {
    case stream
    case streamBackedScreenshot
    case screenshotManager
    case screenCaptureCLI

    var isLiveStream: Bool { self == .stream || self == .streamBackedScreenshot }
}

struct WindowShot: Sendable {
    let base64: String
    let width: Int
    let height: Int
    let originX: Double
    let originY: Double
    let pointWidth: Double
    let pointHeight: Double
    let windowID: CGWindowID
    let source: WindowShotCaptureSource
    /// Uniform capture fit before integer pixel-buffer rounding. Legacy shots
    /// may omit this and retain their dimension-derived transform.
    var pixelsPerPoint: Double? = nil
    var mimeType: String = "image/png"
}

struct ModelWindowImage: Sendable {
    let base64: String
    let mimeType: String
}

@available(macOS 14.0, *)
@MainActor
public enum Capture {

    /// Apply the model image budget after capture freshness has been validated.
    /// Window geometry stays in points; returned dimensions name actual pixels.
    static func boundedModelWindowShot(_ shot: WindowShot) -> WindowShot? {
        guard shot.width > 0, shot.height > 0,
              shot.pointWidth.isFinite, shot.pointWidth > 0,
              shot.pointHeight.isFinite, shot.pointHeight > 0 else { return nil }
        let target = NativeScreenshotPolicy.pixelSize(
            pointSize: CGSize(width: shot.pointWidth, height: shot.pointHeight),
            backingScale: 1
        )
        // The production capture already applies this same policy. Preserve
        // its exact pre-rounding transform and pixels without a second resize.
        guard shot.width > Int(target.width) || shot.height > Int(target.height) else {
            return shot
        }
        guard let data = Data(base64Encoded: shot.base64),
              let source = CGImageSourceCreateWithData(data as CFData, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
            return nil
        }
        let scale = min(1, target.width / Double(image.width),
                        target.height / Double(image.height))
        guard let bounded = try? scaleImage(image, scale: scale),
              let encoded = pngBase64WithSize(bounded) else {
            // Keep the existing AX-only degradation; never leak an unbounded
            // image after an allocation/encoding failure.
            return nil
        }
        return WindowShot(
            base64: encoded.base64, width: encoded.width, height: encoded.height,
            originX: shot.originX, originY: shot.originY,
            pointWidth: shot.pointWidth, pointHeight: shot.pointHeight,
            windowID: shot.windowID, source: shot.source,
            pixelsPerPoint: shot.pixelsPerPoint.map { $0 * scale }, mimeType: "image/png"
        )
    }

    /// Presentation encoding only: keep the bounded lossless shot as the
    /// freshness/identical-capture evidence and retain its coordinate geometry.
    static func modelWindowImage(
        _ shot: WindowShot,
        quality: Double = NativeScreenshotPolicy.jpegQuality,
        encodeJPEG: @MainActor (CGImage, Double) -> String? = jpegBase64
    ) -> ModelWindowImage {
        let lossless = ModelWindowImage(base64: shot.base64, mimeType: shot.mimeType)
        guard quality.isFinite, (0...1).contains(quality),
              let data = Data(base64Encoded: shot.base64),
              let source = CGImageSourceCreateWithData(data as CFData, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
              image.width == shot.width, image.height == shot.height,
              let base64 = encodeJPEG(image, quality), !base64.isEmpty else {
            return lossless
        }
        return ModelWindowImage(base64: base64, mimeType: "image/jpeg")
    }

    // MARK: - Permission gates

    /// Passive Screen Recording check. Never prompts.
    ///
    /// `CGPreflightScreenCaptureAccess()` is authoritative when it returns true.
    /// A single `false` is not always authoritative for a freshly relaunched,
    /// stably-signed binary that was previously granted (TCC can lag the first
    /// query), but for the capture hot path we treat false as "denied" and
    /// surface a typed error rather than silently attempting a capture that
    /// macOS would answer with a black frame.
    public static func hasScreenRecordingPermission() -> Bool {
        Permissions.screenRecordingGrantedAuthoritative()
    }

    /// Triggers the OS Screen Recording prompt. ONBOARDING ONLY — never called
    /// from the capture hot path.
    @discardableResult
    public static func requestScreenRecordingPermission() -> Bool {
        CGRequestScreenCaptureAccess()
    }

    // MARK: - screenshot

    /// Full-display capture.
    ///
    /// - Parameters:
    ///   - displayId: CGDirectDisplayID as Int; `nil` selects the primary display.
    ///   - targetWidth/targetHeight: OUTPUT pixel dimensions (already computed by
    ///       the TS layer). When either is nil, falls back to the display's native
    ///       physical pixel size (logical points × scaleFactor), matching the
    ///       Python helper's "no resize" path.
    ///   - jpegQuality: 0.0...1.0 lossy quality.
    public static func screenshot(
        displayId: Int?,
        targetWidth: Int?,
        targetHeight: Int?,
        jpegQuality: Double
    ) async throws -> ScreenshotResult {
        try ensureScreenRecording()

        let geometry = try Displays.get(displayId)
        let scDisplay = try await resolveSCDisplay(displayId: geometry.displayId)

        let (outW, outH) = resolveOutputSize(
            targetWidth: targetWidth,
            targetHeight: targetHeight,
            fallbackLogicalWidth: geometry.width,
            fallbackLogicalHeight: geometry.height,
            scaleFactor: geometry.scaleFactor
        )

        let config = makeConfiguration(width: outW, height: outH, sourceRect: nil)
        let image = try await captureImage(display: scDisplay, configuration: config)

        guard let base64 = jpegBase64(image, quality: jpegQuality) else {
            throw CUError("encode_failed", "Failed to JPEG-encode the captured image")
        }

        return ScreenshotResult(
            base64: base64,
            width: image.width,          // ACTUAL produced pixels
            height: image.height,
            displayWidth: geometry.width, // source logical points
            displayHeight: geometry.height,
            displayId: geometry.displayId,
            originX: geometry.originX,
            originY: geometry.originY,
            display: geometry
        )
    }

    // MARK: - zoom

    /// Region capture. `x`/`y`/`width`/`height` are GLOBAL logical points (the TS
    /// layer passes the model's region verbatim, in the global top-left point
    /// space). SCK's `sourceRect` is DISPLAY-LOCAL, so we subtract the containing
    /// display's origin before handing it off.
    ///
    /// Returns only `{base64,width,height}` — mirrors `capture_region` in
    /// mac_helper.py which omits display geometry for zoom.
    public static func zoom(
        x: Double,
        y: Double,
        width: Double,
        height: Double,
        targetWidth: Int?,
        targetHeight: Int?,
        jpegQuality: Double
    ) async throws -> ZoomResult {
        try ensureScreenRecording()

        guard width > 0, height > 0 else {
            throw CUError("bad_payload", "zoom region must have positive width and height")
        }

        // Find the display whose bounds contain the region's top-left. Fall back
        // to the primary display if the point lands in a gap between monitors.
        let regionOrigin = CGPoint(x: x, y: y)
        let displays = Displays.list()
        let containingMatch = displays.first { geo in
            let bounds = CGRect(
                x: Double(geo.originX),
                y: Double(geo.originY),
                width: Double(geo.width),
                height: Double(geo.height)
            )
            return bounds.contains(regionOrigin)
        }
        let containing = try containingMatch ?? Displays.get(nil)

        let scDisplay = try await resolveSCDisplay(displayId: containing.displayId)

        // Global logical -> display-local points.
        let localRect = CGRect(
            x: x - Double(containing.originX),
            y: y - Double(containing.originY),
            width: width,
            height: height
        )

        let (outW, outH) = resolveOutputSize(
            targetWidth: targetWidth,
            targetHeight: targetHeight,
            fallbackLogicalWidth: Int(width.rounded()),
            fallbackLogicalHeight: Int(height.rounded()),
            scaleFactor: containing.scaleFactor
        )

        let config = makeConfiguration(width: outW, height: outH, sourceRect: localRect)
        let image = try await captureImage(display: scDisplay, configuration: config)

        guard let base64 = jpegBase64(image, quality: jpegQuality) else {
            throw CUError("encode_failed", "Failed to JPEG-encode the zoom region")
        }

        return ZoomResult(base64: base64, width: image.width, height: image.height)
    }

    // MARK: - resolve_prepare_capture

    /// v1 behavior: a straight full-display capture of the preferred display with
    /// `hidden: []` and `resolvedDisplayId == displayId`. The Codex
    /// co-location/app-chase resolver and app-hiding are deferred (the TS layer's
    /// autoResolve/doHide flags are intentionally ignored here — this matches the
    /// existing Python parity where resolve_prepare_capture is `capture_display`
    /// plus the two extra fields).
    ///
    /// On capture failure we do NOT throw: we surface `captureError` in the result
    /// so the agent loop can degrade gracefully, mirroring the `captureError?`
    /// field the TS `ResolvePrepareCaptureResult` carries. The Screen-Recording
    /// permission gate, however, still throws before we get this far — a denied
    /// permission is a hard, actionable error, not a transient capture hiccup.
    public static func resolvePrepareCapture(
        preferredDisplayId: Int?,
        targetWidth: Int?,
        targetHeight: Int?,
        jpegQuality: Double
    ) async throws -> ResolvePrepareCaptureResult {
        try ensureScreenRecording()

        let geometry = try Displays.get(preferredDisplayId)

        let (outW, outH) = resolveOutputSize(
            targetWidth: targetWidth,
            targetHeight: targetHeight,
            fallbackLogicalWidth: geometry.width,
            fallbackLogicalHeight: geometry.height,
            scaleFactor: geometry.scaleFactor
        )

        do {
            let scDisplay = try await resolveSCDisplay(displayId: geometry.displayId)
            let config = makeConfiguration(width: outW, height: outH, sourceRect: nil)
            let image = try await captureImage(display: scDisplay, configuration: config)

            guard let base64 = jpegBase64(image, quality: jpegQuality) else {
                throw CUError("encode_failed", "Failed to JPEG-encode the captured image")
            }

            return ResolvePrepareCaptureResult(
                base64: base64,
                width: image.width,
                height: image.height,
                displayWidth: geometry.width,
                displayHeight: geometry.height,
                displayId: geometry.displayId,
                originX: geometry.originX,
                originY: geometry.originY,
                display: geometry,
                hidden: [],
                resolvedDisplayId: geometry.displayId,
                captureError: nil
            )
        } catch let error as CUError {
            // Permission denial already threw above; any CUError here is a real
            // capture/encode failure. Report it inline (empty base64) instead of
            // throwing so the caller still learns the resolved display.
            return ResolvePrepareCaptureResult(
                base64: "",
                width: 0,
                height: 0,
                displayWidth: geometry.width,
                displayHeight: geometry.height,
                displayId: geometry.displayId,
                originX: geometry.originX,
                originY: geometry.originY,
                display: geometry,
                hidden: [],
                resolvedDisplayId: geometry.displayId,
                captureError: error.message
            )
        } catch {
            return ResolvePrepareCaptureResult(
                base64: "",
                width: 0,
                height: 0,
                displayWidth: geometry.width,
                displayHeight: geometry.height,
                displayId: geometry.displayId,
                originX: geometry.originX,
                originY: geometry.originY,
                display: geometry,
                hidden: [],
                resolvedDisplayId: geometry.displayId,
                captureError: error.localizedDescription
            )
        }
    }

    // MARK: - JPEG encoding (shared)

    /// Encode a CGImage to base64 JPEG via ImageIO. Returns nil on failure.
    static func jpegBase64(_ image: CGImage, quality: Double) -> String? {
        let data = NSMutableData()
        let type = UTType.jpeg.identifier as CFString
        guard let dest = CGImageDestinationCreateWithData(data, type, 1, nil) else {
            return nil
        }
        let clamped = min(max(quality, 0.0), 1.0)
        let options: [CFString: Any] = [
            kCGImageDestinationLossyCompressionQuality: clamped
        ]
        CGImageDestinationAddImage(dest, image, options as CFDictionary)
        guard CGImageDestinationFinalize(dest) else {
            return nil
        }
        return (data as Data).base64EncodedString()
    }

    // MARK: - Internals

    private static func ensureScreenRecording() throws {
        guard hasScreenRecordingPermission() else {
            throw CUError(
                "screen_recording_denied",
                "Screen Recording permission is not granted for cu-helper. "
                    + "Grant it in System Settings > Privacy & Security > Screen Recording."
            )
        }
    }

    /// Resolve the `SCDisplay` matching `displayId` from the current shareable
    /// content. Throws `display_not_found` if the display vanished between the
    /// CoreGraphics enumeration and the SCK query (e.g. a monitor unplugged), or
    /// `capture_failed` if SCK could not enumerate content at all.
    private static func resolveSCDisplay(displayId: Int) async throws -> SCDisplay {
        let content: SCShareableContent
        do {
            content = try await SCShareableContent.current
        } catch {
            throw CUError(
                "capture_failed",
                "SCShareableContent.current failed: \(error.localizedDescription)"
            )
        }

        guard let match = content.displays.first(where: { Int($0.displayID) == displayId }) else {
            throw CUError(
                "display_not_found",
                "No ScreenCaptureKit display with id \(displayId)"
            )
        }
        return match
    }

    private static func captureImage(
        display: SCDisplay,
        configuration: SCStreamConfiguration
    ) async throws -> CGImage {
        let filter = SCContentFilter(display: display, excludingWindows: [])
        do {
            return try await SCScreenshotManager.captureImage(
                contentFilter: filter,
                configuration: configuration
            )
        } catch {
            throw CUError(
                "capture_failed",
                "SCScreenshotManager.captureImage failed: \(error.localizedDescription)"
            )
        }
    }

    /// Build a screenshot `SCStreamConfiguration`.
    ///
    /// `width`/`height` are the OUTPUT pixel dimensions. `sourceRect` (zoom only)
    /// is in display-local points. `scalesToFit` lets SCK fit the source region
    /// into the output buffer while preserving aspect; the TS layer already picks
    /// an aspect-correct output size so there is no letterboxing in practice.
    private static func makeConfiguration(
        width: Int,
        height: Int,
        sourceRect: CGRect?
    ) -> SCStreamConfiguration {
        let config = SCStreamConfiguration()
        config.width = max(1, width)
        config.height = max(1, height)
        config.showsCursor = false                 // the REAL cursor; we never capture it
        config.scalesToFit = true
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.colorSpaceName = CGColorSpace.sRGB   // stable color across displays
        config.captureResolution = .best            // sharp Retina downscale source
        if let rect = sourceRect {
            config.sourceRect = rect
        }
        return config
    }

    /// Resolve final output pixel dimensions. When the TS layer supplied an
    /// explicit target size we honor it verbatim (it is already the
    /// resize-to-fit-the-API-budget result). Otherwise fall back to native
    /// physical pixels = logical points × scaleFactor (rounded), matching the
    /// Python helper's no-resize path.
    private static func resolveOutputSize(
        targetWidth: Int?,
        targetHeight: Int?,
        fallbackLogicalWidth: Int,
        fallbackLogicalHeight: Int,
        scaleFactor: Double
    ) -> (Int, Int) {
        if let w = targetWidth, let h = targetHeight, w > 0, h > 0 {
            return (w, h)
        }
        let scale = scaleFactor > 0 ? scaleFactor : 1.0
        let physW = Int((Double(fallbackLogicalWidth) * scale).rounded())
        let physH = Int((Double(fallbackLogicalHeight) * scale).rounded())
        return (max(1, physW), max(1, physH))
    }

    // MARK: - windowShot (get_app_state companion, blueprint §5)
    //
    //  A *window-locked* capture used by the daemon's `get_app_state`: it pins the
    //  target app's single most-relevant window, captures only that window (not the
    //  full display, not the desktop, not other apps), downscales by `scale`
    //  (default native App fit), and returns lossless PNG base64 in the screenshot-pixel space (top-left
    //  origin) for the server's affine map. It is the only capture path tied to a
    //  *pid* rather than a *display*.
    //
    //  Contract divergence from the throwing `screenshot`/`zoom`/`resolve*` family
    //  (deliberate): `windowShot` NEVER throws and NEVER prompts — it returns `nil`
    //  on any failure (no permission, no window, SCK timeout, screencapture failure,
    //  PNG/base64 failure). The blueprint mandates the caller wraps it in `try?` so
    //  `get_app_state` always returns the AX text even when pixels are unavailable.
    //  A single hung capture must not wedge the daemon, so every failure is a quiet
    //  `nil`, never a thrown error and never a black frame.
    //
    //  SCK-wedge guard: SCScreenshotManager can hang indefinitely (off-screen /
    //  minimized window, GPU stall). We run it in a *detached* Task and bound it
    //  with `DispatchSemaphore.wait(2.5s)`. Crucially the blocking wait itself runs
    //  on a background thread (bridged back via a continuation) so it suspends — and
    //  never *blocks* — this @MainActor run loop. On timeout we cancel the SCK task
    //  and fall back to `/usr/sbin/screencapture -l <windowID>` (3s, terminate →
    //  SIGKILL escalation). If both miss, `nil`.

    /// Window-locked screenshot of the most-relevant window owned by `pid`.
    ///
    /// - Parameters:
    ///   - pid: the target application's process id (the app whose AX tree
    ///     `get_app_state` just rendered).
    ///   - scale: an explicit factor applied to native pixels; nil uses the
    ///     native App policy (point resolution, long/short side limits).
    /// - Returns: `(base64, width, height, originX, originY, pointWidth,
    ///   pointHeight, windowID)` — lossless PNG capture evidence in screenshot-pixel space (top-left origin)
    ///   PLUS the captured window's GLOBAL Quartz top-left origin and its size
    ///   in POINTS. The caller uses the uniform `pixelsPerPoint` capture fit
    ///   to invert image-pixel coordinates back into the
    ///   global-point space that clicks/cursor/glow all live in. `nil` on any
    ///   failure. Never throws; never prompts.
    static func windowShot(
        pid: pid_t,
        preferredWindowID: CGWindowID? = nil,
        scale: Double? = nil,
        allowCLIFallback: Bool = true
    ) async -> WindowShot? {
        // Passive permission gate — no prompt on the hot path. A denied grant
        // means SCK would hand us a black frame, so bail to `nil` early and let
        // the caller fall back to AX-text-only.
        guard hasScreenRecordingPermission() else { return nil }

        guard let target = bestWindow(
            forPid: pid,
            preferredWindowID: preferredWindowID
        ) else { return nil }

        let backingScale = backingScaleFactor(forWindowFrame: target.frame)
        let outputScale = scale.flatMap { $0 > 0 ? $0 : nil } ?? NativeScreenshotPolicy.scale(
            pointSize: target.frame.size, backingScale: backingScale
        )
        // The captured window's global Quartz top-left frame (points). Threaded
        // to every return point so the caller can build the inverse transform.
        let f = target.frame

        // ① ScreenCaptureKit, bounded by a 2.5s off-main-actor semaphore wait.
        if let image = await screenCaptureKitWindow(
            windowID: target.windowID,
            frame: target.frame,
            scale: outputScale
        ) {
            if let encoded = pngBase64WithSize(image) {
                return WindowShot(
                    base64: encoded.base64,
                    width: encoded.width,
                    height: encoded.height,
                    originX: Double(f.origin.x),
                    originY: Double(f.origin.y),
                    pointWidth: Double(f.width),
                    pointHeight: Double(f.height),
                    windowID: target.windowID,
                    source: .screenshotManager,
                    pixelsPerPoint: backingScale * outputScale
                )
            }
            // SCK produced pixels but image encoding failed — degrade to `nil`
            // rather than re-capturing; the caller still gets AX text.
            return nil
        }

        guard allowCLIFallback else { return nil }
        // ② Fallback: /usr/sbin/screencapture -l <windowID> (SCK hung or failed).
        if let raw = screencaptureWindow(windowID: target.windowID) {
            let scaledImage = try? scaleImage(raw, scale: outputScale)
            let scaled = scaledImage ?? raw
            if let encoded = pngBase64WithSize(scaled) {
                return WindowShot(
                    base64: encoded.base64,
                    width: encoded.width,
                    height: encoded.height,
                    originX: Double(f.origin.x),
                    originY: Double(f.origin.y),
                    pointWidth: Double(f.width),
                    pointHeight: Double(f.height),
                    windowID: target.windowID,
                    source: .screenCaptureCLI,
                    pixelsPerPoint: scaledImage == nil ? nil : backingScale * outputScale
                )
            }
        }

        return nil
    }

    // MARK: - windowShot internals

    /// A capture candidate: the CoreGraphics window id plus its global Quartz
    /// frame (top-left origin) used to size the SCK output buffer.
    struct WindowCandidate {
        let windowID: CGWindowID
        let frame: CGRect
    }

    /// Pick the single best window owned by `pid` via a TCC-free
    /// `CGWindowListCopyWindowInfo` walk. Rank (blueprint §5, mirrors the
    /// OpenCodexLabs reference scoring): `area + 1_000_000 (on-screen) +
    /// 2_000_000 (active/frontmost)`. The highest score wins, so an on-screen
    /// frontmost window always beats a backgrounded or off-screen one, and among
    /// peers the larger area wins. When AX supplied `preferredWindowID`, only
    /// that exact owner window may be returned. Zero-area and 1px sliver windows
    /// are dropped.
    ///
    /// Note we intentionally do *not* reuse `Displays.onScreenWindows()`: that
    /// helper discards the `windowID` (which SCK needs to match a specific
    /// `SCWindow`) and filters to layer-0 only. For a window-locked capture we
    /// want the owner's frontmost window regardless of layer, keyed by id.
    static func bestWindow(
        forPid pid: pid_t,
        preferredWindowID: CGWindowID?
    ) -> WindowCandidate? {
        let options: CGWindowListOption = [.optionAll, .excludeDesktopElements]
        guard
            let raw = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]]
        else {
            return nil
        }

        let frontmostPID = NSWorkspace.shared.frontmostApplication?.processIdentifier

        var best: WindowCandidate?
        var bestScore = -Double.greatestFiniteMagnitude

        for window in raw {
            // Owner pid filter.
            guard
                let ownerPID = (window[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
                ownerPID == pid
            else {
                continue
            }
            guard
                let windowNumber = (window[kCGWindowNumber as String] as? NSNumber)?.uint32Value
            else {
                continue
            }
            guard
                let boundsDict = window[kCGWindowBounds as String] as? NSDictionary,
                let bounds = CGRect(dictionaryRepresentation: boundsDict)
            else {
                continue
            }
            // Drop zero-area / 1px tracking slivers — they cannot be the key
            // window and would size a degenerate output buffer.
            if bounds.width <= 1 || bounds.height <= 1 { continue }

            let candidate = WindowCandidate(
                windowID: windowNumber,
                frame: bounds
            )
            if let preferredWindowID, windowNumber == preferredWindowID {
                return candidate
            }

            // Absent on-screen key means on-screen (matches CG's default).
            let isOnScreen = (window[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? true
            let isActive = (frontmostPID == pid) && isOnScreen

            var score = Double(bounds.width * bounds.height)
            if isOnScreen { score += 1_000_000 }
            if isActive { score += 2_000_000 }

            if score > bestScore {
                bestScore = score
                best = candidate
            }
        }

        // When AX supplied a concrete key-window identity, capturing some other
        // window would bind screenshot coordinates to the wrong semantic tree.
        // Fail pixel capture closed instead; AX text remains available.
        if preferredWindowID != nil { return nil }
        return best
    }

    /// ScreenCaptureKit window-locked capture, hard-bounded at 2.5s.
    ///
    /// The SCK work (resolve `SCWindow`, build a `desktopIndependentWindow`
    /// filter, `SCScreenshotManager.captureImage`) runs in a detached Task. We
    /// bridge a `DispatchSemaphore.wait(2.5s)` onto a background queue via a
    /// continuation so this @MainActor function *suspends* (does not block the
    /// run loop) while waiting. On timeout we cancel the SCK task and return
    /// `nil` so `windowShot` can fall back to `screencapture`.
    private static func screenCaptureKitWindow(
        windowID: CGWindowID,
        frame: CGRect,
        scale: Double
    ) async -> CGImage? {
        await withCheckedContinuation { (continuation: CheckedContinuation<CGImage?, Never>) in
            // Hop off the main actor so the blocking semaphore wait never stalls
            // the daemon's run loop. The continuation is resumed exactly once.
            DispatchQueue.global(qos: .userInitiated).async {
                let semaphore = DispatchSemaphore(value: 0)
                let box = ResultBox()

                let task = Task.detached(priority: .userInitiated) {
                    let image = await captureSCWindow(
                        windowID: windowID,
                        frame: frame,
                        scale: scale
                    )
                    box.set(image)
                    semaphore.signal()
                }

                let waitResult = semaphore.wait(timeout: .now() + kWindowShotSCKTimeout)
                if waitResult == .timedOut {
                    // SCK is wedged — abandon it and let the caller fall back.
                    task.cancel()
                    continuation.resume(returning: nil)
                } else {
                    continuation.resume(returning: box.get())
                }
            }
        }
    }

    /// The actual SCK capture, run inside the detached/bounded task. Returns
    /// `nil` (never throws) so a thrown SCK error degrades to the fallback path.
    private static func captureSCWindow(
        windowID: CGWindowID,
        frame: CGRect,
        scale: Double
    ) async -> CGImage? {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(
                false,
                onScreenWindowsOnly: false
            )
            guard let scWindow = content.windows.first(where: { $0.windowID == windowID }) else {
                return nil
            }

            // desktopIndependentWindow pins exactly this window: no desktop, no
            // other apps, no shadow of neighbours — the blueprint's single-window
            // lock.
            let filter = SCContentFilter(desktopIndependentWindow: scWindow)

            let backingScale = backingScaleFactor(forWindowFrame: frame)
            // Native window pixels = points × backing scale, then × requested
            // downscale. Clamp to >= 1 so a tiny window never yields a 0-dim
            // buffer.
            let config = makeWindowShotConfiguration(
                width: max(1, Int(ceil(frame.width * backingScale * scale))),
                height: max(1, Int(ceil(frame.height * backingScale * scale)))
            )

            return try await SCScreenshotManager.captureImage(
                contentFilter: filter,
                configuration: config
            )
        } catch {
            return nil
        }
    }

    static func makeWindowShotConfiguration(width: Int, height: Int) -> SCStreamConfiguration {
        let config = SCStreamConfiguration()
        config.width = max(1, width)
        config.height = max(1, height)
        config.showsCursor = false
        config.scalesToFit = true
        config.preservesAspectRatio = true
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.colorSpaceName = CGColorSpace.sRGB
        config.captureResolution = .best
        // SCScreenshotManager includes this window's shadow by default. That
        // shrinks/pads the image while our click transform still names the
        // shadow-free window bounds, particularly after a cold background start.
        config.ignoreShadowsSingleWindow = true
        config.ignoreShadowsDisplay = true
        if #available(macOS 14.2, *) {
            // The sharing indicator can become an attached child above the
            // window. Capturing that union shrinks/offsets the main content
            // without changing SCWindow.frame or filter.contentRect, breaking
            // screenshot-to-click coordinates. The target is this exact window.
            config.includeChildWindows = false
        }
        return config
    }

    /// CLI fallback when SCK hangs/fails: `/usr/sbin/screencapture -l <windowID>
    /// -x -o <tmp.png>`. `-x` = no capture sound, `-o` = omit the window shadow.
    /// Bounded at 3s with a `terminate` → `SIGKILL` escalation. Returns the
    /// decoded (unscaled) `CGImage`, or `nil` on any failure. Never throws.
    private static func screencaptureWindow(windowID: CGWindowID) -> CGImage? {
        let tmpURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("cu-helper-windowshot-\(windowID)-\(UUID().uuidString).png")
        defer { try? FileManager.default.removeItem(at: tmpURL) }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        process.arguments = ["-l", "\(windowID)", "-x", "-o", tmpURL.path]

        do {
            try process.run()
        } catch {
            return nil
        }

        // Bounded poll: terminate (SIGTERM) then SIGKILL if it overstays.
        let deadline = Date().addingTimeInterval(kWindowShotScreencaptureTimeout)
        while process.isRunning && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.05)
        }
        if process.isRunning {
            process.terminate()
            Thread.sleep(forTimeInterval: 0.15)
            if process.isRunning {
                kill(process.processIdentifier, SIGKILL)
            }
            return nil
        }

        guard process.terminationStatus == 0 else { return nil }

        guard
            let data = try? Data(contentsOf: tmpURL),
            let source = CGImageSourceCreateWithData(data as CFData, nil),
            let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
        else {
            return nil
        }
        return image
    }

    /// Downscale a `CGImage` by `scale` (1:1 returns the original). Used to apply
    /// the requested scale to the `screencapture` fallback, which always captures
    /// at native resolution. Throws only on a `CGContext` allocation failure so
    /// the caller can fall back to the unscaled image.
    private static func scaleImage(_ image: CGImage, scale: Double) throws -> CGImage {
        guard scale > 0, scale != 1.0 else { return image }
        let outW = max(1, Int(ceil(Double(image.width) * scale)))
        let outH = max(1, Int(ceil(Double(image.height) * scale)))
        if outW == image.width && outH == image.height { return image }

        guard let colorSpace = image.colorSpace ?? CGColorSpace(name: CGColorSpace.sRGB) else {
            throw CUError("encode_failed", "windowShot: no color space for downscale")
        }
        guard let context = CGContext(
            data: nil,
            width: outW,
            height: outH,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else {
            throw CUError("encode_failed", "windowShot: failed to allocate downscale context")
        }
        context.interpolationQuality = .high
        context.draw(image, in: CGRect(x: 0, y: 0, width: outW, height: outH))
        guard let scaled = context.makeImage() else {
            throw CUError("encode_failed", "windowShot: failed to materialize downscaled image")
        }
        return scaled
    }

    /// Keep capture/freshness evidence lossless. The model attachment is JPEG
    /// encoded only after the bound window and captured frame are validated.
    static func pngBase64WithSize(
        _ image: CGImage
    ) -> (base64: String, width: Int, height: Int)? {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            data, UTType.png.identifier as CFString, 1, nil
        ) else { return nil }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return ((data as Data).base64EncodedString(), image.width, image.height)
    }

    /// Native App screenshots use the official default JPEG quality. The
    /// byte format is reported explicitly instead of relying on a fixed MIME
    /// label in a downstream wrapper. Encoding failure degrades to AX text.
    static func appScreenshotBase64WithSize(
        _ image: CGImage
    ) -> (base64: String, width: Int, height: Int)? {
        let data = NSMutableData()
        let type = UTType.jpeg.identifier as CFString
        guard let dest = CGImageDestinationCreateWithData(data, type, 1, nil) else {
            return nil
        }
        CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: NativeScreenshotPolicy.jpegQuality] as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { return nil }
        return (
            (data as Data).base64EncodedString(),
            image.width,
            image.height
        )
    }

    /// Backing scale factor (Retina = 2.0) for the screen hosting `frame`. Used
    /// to size the SCK output buffer in native pixels before the requested
    /// downscale. Falls back to the main screen, then 2.0.
    static func backingScaleFactor(forWindowFrame frame: CGRect) -> Double {
        if let screen = NSScreen.screens.first(where: { $0.frame.intersects(frame) }) {
            return Double(screen.backingScaleFactor)
        }
        return Double(NSScreen.main?.backingScaleFactor ?? 2.0)
    }
}

// MARK: - windowShot timeouts (file-scope, non-isolated)
//
//  Read from a background queue inside `screenCaptureKitWindow`'s detached
//  closure, so they must NOT be `@MainActor`-isolated (which a `static let` on
//  the `@MainActor enum Capture` would be). File-scope `let`s of a value type
//  are non-isolated and trivially `Sendable`.

/// SCK capture wedge bound (blueprint §5).
private let kWindowShotSCKTimeout: TimeInterval = 2.5
/// `screencapture` CLI fallback bound (blueprint §5).
private let kWindowShotScreencaptureTimeout: TimeInterval = 3.0

/// A tiny `@unchecked Sendable` one-shot box to hand a `CGImage?` result out of
/// the detached SCK task back across the semaphore boundary. `CGImage` is not
/// `Sendable`, but the access is strictly happens-before: the detached task
/// `set`s and signals; the waiter `get`s only after the semaphore resolves, so
/// there is no concurrent access. A lock guards the (theoretical) timeout-race
/// where the producer writes after the waiter has already given up.
private final class ResultBox: @unchecked Sendable {
    private let lock = NSLock()
    private var image: CGImage?

    func set(_ value: CGImage?) {
        lock.lock()
        image = value
        lock.unlock()
    }

    func get() -> CGImage? {
        lock.lock()
        defer { lock.unlock() }
        return image
    }
}
