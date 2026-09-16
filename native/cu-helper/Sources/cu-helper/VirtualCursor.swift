//
//  VirtualCursor.swift
//  cu-helper
//
//  An animated *virtual* cursor overlay. This is the ONLY cursor that "moves"
//  when the AI drives the machine — the real OS cursor is NEVER touched. We do
//  not call CGWarpMouseCursorPosition / CGDisplayMoveCursorToPoint / NSEvent
//  warps anywhere. Input events are posted to a specific target PID elsewhere
//  (see Injection.swift); this file is purely *visual feedback* and the single
//  source of truth for the virtual cursor's logical position.
//
//  Two modes:
//
//  • Daemon (headless == false): one borderless, transparent, click-through
//    NSWindow per NSScreen, kept warm (created once, hidden between turns). The
//    cursor is a CALayer whose `position` is glided with an ease-out-cubic
//    timing function (~2000 pt/s, capped at 0.5s) driven by a CADisplayLink so
//    the animation ticks on the live main run loop. `click()` plays a ripple
//    (raster LensSequence frames if bundled, else a procedural CAShapeLayer
//    ring). Cursor position lives in memory as the source of truth.
//
//  • Headless (CLI one-shot, headless == true): no windows, no animation.
//    `move(animated:)` is instant and persists the logical point to
//    ~/.claude/.runtime/cu-helper.cursor.json; the `position` getter reads that
//    file. A half-finished glide cannot span two one-shot processes, so we just
//    record where the virtual cursor "is".
//
//  Coordinate space throughout: LOGICAL, top-left origin, global points — the
//  same space the TS bridge / screenshots use. We render in a flipped view so
//  layer.position maps 1:1 onto those coordinates.
//

import AppKit
import Foundation
import QuartzCore

// MARK: - Non-animated gradient layer

/// A `CAGradientLayer` that refuses every implicit animation. Without this,
/// each `setFrame:` and each gradient/color mutation triggers Core Animation's
/// default 0.25s fade/move, which makes the cursor's orb smear and lag behind
/// its own motion. Returning `nil` from `action(forKey:)` disables implicit
/// actions for ALL keys on this layer.
///
/// Previously lived in `CaptureGlowOverlay.swift`; it moved here when the glow
/// border was removed, since the virtual cursor is now its only consumer.
final class NonAnimatedGradientLayer: CAGradientLayer {
    override func action(forKey event: String) -> CAAction? {
        // NSNull would also disable; nil is the documented "no action" answer.
        return nil
    }
}

@MainActor
public final class VirtualCursor {

    // MARK: Public API

    public enum ClickKind: Sendable {
        case single
        case doubleClick
        case rightClick
        case press
        case release
    }

    /// `true` => CLI one-shot mode: no windows, instant move, disk-backed position.
    private let headless: Bool

    public init(headless: Bool) {
        self.headless = headless
        if headless {
            // Seed the in-memory mirror from the last persisted point so that a
            // `cursor_position` before any `move_mouse` still returns the most
            // recent known location rather than (0,0).
            self.motionState = CursorMotionState(
                position: Self.readPersistedPoint() ?? .zero
            )
        } else {
            self.motionState = CursorMotionState(position: Self.defaultDaemonStart())
        }
    }

    /// The virtual cursor's logical, top-left, global position in points.
    /// Daemon: the in-memory source of truth. Headless: re-read from disk so a
    /// sibling one-shot process that moved last is reflected.
    public var position: CGPoint {
        if headless {
            if let p = Self.readPersistedPoint() {
                motionState.snap(to: p)
            }
            return motionState.position
        }
        return motionState.position
    }

    /// Create the hidden overlay windows (daemon only). No-op when headless or
    /// already preloaded. Safe to call repeatedly.
    public func preload() {
        guard !headless else { return }
        guard !didPreload else {
            // Screens may have changed since the last preload (resolution,
            // arrangement, hot-plug) — reconcile windows to the current set.
            rebuildScreenWindows()
            return
        }
        didPreload = true

        // We own windows but must never steal focus or appear in the Dock. The
        // process is expected to already be `.accessory` (set by Daemon.run());
        // we don't change activation policy here.
        rebuildScreenWindows()
        registerScreenObservers()
    }

    /// Reveal the virtual cursor (daemon only). Headless: no-op.
    public func show() {
        guard !headless else { return }
        preload()
        isShown = true
        refreshVisualPolicy(positionLayers: true)
    }

    /// Set the visual target independently from Injection's legacy global. A
    /// proven process lifetime is captured so PID reuse cannot reveal overlays.
    func setVisualTarget(_ target: ProvenProcessTarget?) {
        guard !headless else { return }
        visualTarget = target
        refreshVisualPolicy(positionLayers: true)
    }

    /// Park / hide the virtual cursor (daemon only). Headless: no-op. We keep
    /// the windows alive (warm) and only hide the cursor layer + order out, so
    /// the next `show()` is instant.
    public func hide() {
        guard !headless else { return }
        isShown = false
        cancelGlide()
        motionState.stop()
        visualTarget = nil
        lastActionPoint = nil
        visualsVisible = false
        setCursorHidden(true)
        clearTransientVisuals()
        for window in screenWindows.values {
            window.orderOut(nil)
        }
    }

    /// Move the virtual cursor to a logical point. The real OS cursor is never
    /// moved. In daemon mode this glides with spring physics (Codex "scoot":
    /// squash-stretch along travel + a soft, slightly over-damped settle) and only
    /// returns once the glide has visually completed. In headless mode it's instant
    /// and persists the point to disk.
    public func move(to p: CGPoint, animated: Bool) async {
        let target = sanitized(p)

        if headless {
            motionState.snap(to: target)
            Self.persistPoint(target)
            return
        }

        preload()
        let from = motionState.position
        refreshVisualPolicy(positionLayers: false)

        // Compute the duration BEFORE mutating state so a zero-distance move is
        // a cheap snap.
        let distance = hypot(target.x - from.x, target.y - from.y)

        guard animated, isShown, distance > 0.5 else {
            // Instant placement: either animation is off, we're hidden (no point
            // animating an invisible cursor), or the move is negligible.
            snap(to: target)
            return
        }

        let duration = Self.glideDuration(forDistance: distance)
        await runGlide(to: target, duration: duration)
    }

    /// Start the owner-managed spring immediately. Coordinate gestures skip the
    /// visual readability wait; indexed actions retain the visible policy delay.
    /// Hidden/unrequested actions snap. The real OS cursor is never moved.
    public func moveForAction(
        to p: CGPoint, targetPid: pid_t, waitForVisualFeedback: Bool = true
    ) async {
        let target = sanitized(p)
        if headless {
            motionState.snap(to: target)
            Self.persistPoint(target)
            return
        }

        let resolved = Injection.lastResolvedTarget.flatMap {
            $0.pid == targetPid ? $0 : nil
        }
        setVisualTarget(resolved)
        // Exposure is judged at the DESTINATION (inside the target window),
        // not at the cursor's transient position — a glide legitimately
        // crosses empty desktop and other displays on its way there.
        lastActionPoint = target
        preload()
        let decision = currentVisualDecision()
        await CursorActionTiming.perform(
            decision: decision,
            waitForVisualFeedback: waitForVisualFeedback,
            startGlide: { [self] in
                if !startGlide(to: target) {
                    snap(to: target)
                }
            },
            snap: { [self] in snap(to: target) },
            sleep: { delay in
                try? await Task.sleep(for: .seconds(delay))
            }
        )
    }

    /// Play click feedback at a logical point (or at the current cursor position
    /// when `at` is nil). This posts NO input events — it's purely a ripple /
    /// pulse so the user sees where the AI acted. Headless: no-op.
    public func showClick(at p: CGPoint?, kind: ClickKind) {
        guard !headless, isShown else { return }
        preload()
        refreshVisualPolicy(positionLayers: false)
        guard visualsVisible else { return }

        let logical = sanitized(p ?? motionState.position)
        guard let (window, view) = windowAndView(containingLogical: logical) else { return }
        guard let hostLayer = view.layer else { return }

        let local = view.convertFromLogical(logical, in: window)
        let accent = Self.accentColor(for: kind)

        // Prefer bundled raster frames if present; otherwise draw a procedural
        // expanding ring. Either way the cursor layer itself also gives a quick
        // squash pulse so single/press/release are legible even without a ring.
        pulseCursorLayer(in: window, kind: kind)

        if let sprite = makeRasterRipple(at: local, kind: kind) {
            hostLayer.addSublayer(sprite.layer)
            scheduleRippleRemoval(sprite.layer, after: sprite.duration)
        } else {
            let ring = makeProceduralRipple(at: local, color: accent, kind: kind)
            hostLayer.addSublayer(ring.layer)
            scheduleRippleRemoval(ring.layer, after: ring.duration)
        }
    }

    // MARK: - Stored state

    /// Source of truth in daemon mode; mirror of the persisted point in headless.
    private var motionState: CursorMotionState

    private var didPreload = false
    private var isShown = false
    private var visualsVisible = false

    /// Where the current/most recent action lands, in logical (top-left,
    /// global) coordinates. Drives the background-exposure check; cleared on
    /// hide so a stale point cannot keep visuals alive for a later target.
    private var lastActionPoint: CGPoint?
    private var visualTarget: ProvenProcessTarget?

    /// One overlay window per screen, keyed by CGDirectDisplayID.
    private var screenWindows: [CGDirectDisplayID: OverlayWindow] = [:]

    private var activeRipples: [CALayer] = []

    // Glide animation state (daemon only).
    private var displayLink: CADisplayLink?
    private var fallbackTimer: Timer?
    private var glideStartHostTime: CFTimeInterval = 0
    private var glideDuration: CFTimeInterval = 0
    private var glideContinuation: CheckedContinuation<Void, Never>?
    /// Host time of the previous tick, for a real-dt spring integration.
    private var glideLastTick: CFTimeInterval = 0

    // Lazily-loaded raster ripple frames (nil => not bundled => procedural).
    private static let rasterFrames: [CGImage]? = VirtualCursor.loadLensSequence().frames

    // MARK: - Geometry helpers

    /// Clamp NaN/inf to the current cursor position so a malformed payload can
    /// never wedge the overlay at an undefined coordinate.
    private func sanitized(_ p: CGPoint) -> CGPoint {
        let x = p.x.isFinite ? p.x : motionState.position.x
        let y = p.y.isFinite ? p.y : motionState.position.y
        return CGPoint(x: x, y: y)
    }

    /// A sensible starting point for the daemon's virtual cursor: the center of
    /// the primary display, so the first reveal isn't pinned in a corner.
    private static func defaultDaemonStart() -> CGPoint {
        let main = CGMainDisplayID()
        let bounds = CGDisplayBounds(main)
        return CGPoint(x: bounds.midX, y: bounds.midY)
    }

    /// Which screen (logical, top-left, global) contains a point. Falls back to
    /// the primary screen when the point is off all screens (e.g. negative
    /// coordinates from a left-of-primary display that was just unplugged).
    private func screen(forLogical p: CGPoint) -> NSScreen? {
        for screen in NSScreen.screens where logicalFrame(of: screen).contains(p) {
            return screen
        }
        return NSScreen.screens.first { $0.isPrimaryFlippedScreen } ?? NSScreen.screens.first
    }

    private func windowAndView(containingLogical p: CGPoint) -> (OverlayWindow, FlippedOverlayView)? {
        guard let screen = screen(forLogical: p),
              let id = screen.displayID,
              let window = screenWindows[id],
              let view = window.flippedView
        else { return nil }
        return (window, view)
    }

    /// The screen's frame expressed in LOGICAL top-left global coordinates
    /// (Cocoa screen frames are bottom-left origin; we flip on the primary
    /// screen's height to match CGDisplayBounds / screenshot space).
    private func logicalFrame(of screen: NSScreen) -> CGRect {
        if let id = screen.displayID {
            // CGDisplayBounds is already top-left global — authoritative.
            return CGDisplayBounds(id)
        }
        let primaryHeight = NSScreen.primaryHeight
        let f = screen.frame
        return CGRect(x: f.minX,
                      y: primaryHeight - f.maxY,
                      width: f.width,
                      height: f.height)
    }

    // MARK: - Window lifecycle (daemon)

    private func rebuildScreenWindows() {
        // Re-evaluate before creating or ordering any hot-plugged window.
        refreshVisualPolicy(positionLayers: false)
        var liveIDs = Set<CGDirectDisplayID>()

        for screen in NSScreen.screens {
            guard let id = screen.displayID else { continue }
            liveIDs.insert(id)

            let logical = logicalFrame(of: screen)
            // Cocoa window frames are bottom-left; convert our top-left logical
            // frame back to the screen's own (bottom-left) frame for AppKit.
            let cocoaFrame = screen.frame

            if let existing = screenWindows[id] {
                existing.setFrame(cocoaFrame, display: false)
                existing.flippedView?.logicalOrigin = logical.origin
                existing.flippedView?.syncContentsScale(screen.backingScaleFactor)
            } else {
                let window = OverlayWindow(
                    contentRect: cocoaFrame,
                    styleMask: .borderless,
                    backing: .buffered,
                    defer: false,
                    screen: screen
                )
                window.configureAsCursorOverlay()
                window.flippedView?.logicalOrigin = logical.origin
                window.flippedView?.syncContentsScale(screen.backingScaleFactor)
                window.flippedView?.installCursorLayer()
                screenWindows[id] = window
                if visualsVisible {
                    window.orderFrontRegardless()
                }
            }
        }

        // Drop windows for screens that went away.
        for (id, window) in screenWindows where !liveIDs.contains(id) {
            window.orderOut(nil)
            window.close()
            screenWindows.removeValue(forKey: id)
        }

        positionCursorLayers(animated: false)
        setCursorHidden(!visualsVisible)
    }

    private func registerScreenObservers() {
        NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.rebuildScreenWindows()
            }
        }
        // Hide the orb the moment the user switches to a DIFFERENT app than the one
        // Computer Use is driving (especially our own host app), so it never strands
        // on top of what they're now looking at; reveal it again when the controlled
        // app is frontmost. Mirrors Codex's ComputerUseCursor app-frontmost monitor.
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.refreshVisualPolicy(positionLayers: true)
            }
        }
    }

    private func currentVisualDecision() -> OverlayPolicy.Decision {
        let verifiedPid: pid_t?
        if let target = visualTarget,
           let pid = target.validatedPid(
               currentIdentity: AXTree.currentProcessIdentity(pid: target.pid)
           ) {
            verifiedPid = pid
        } else {
            verifiedPid = nil
        }
        let frontmostPid = NSWorkspace.shared.frontmostApplication?.processIdentifier
        // Window-list round trip only when it can change the answer: a proven
        // BACKGROUND target with a known action point.
        var exposed = false
        if let pid = verifiedPid, frontmostPid != pid, let point = lastActionPoint {
            exposed = WindowExposure.targetWindowExposed(at: point, targetPid: pid)
        }
        return OverlayPolicy.decision(
            targetPid: verifiedPid,
            frontmostPid: frontmostPid,
            overlayRequested: isShown,
            targetWindowExposed: exposed
        )
    }

    /// Re-evaluate immediately before every order-front/tick/ripple. This keeps
    /// screen rebuilds and in-flight motion from re-exposing a background cursor.
    private func refreshVisualPolicy(positionLayers: Bool) {
        guard !headless else { return }
        let decision = currentVisualDecision()
        let wasVisible = visualsVisible
        visualsVisible = decision.visible

        if decision.visible {
            if !wasVisible {
                for window in screenWindows.values { window.orderFrontRegardless() }
            }
            if positionLayers { positionCursorLayers(animated: false) }
            setCursorHidden(false)
        } else {
            setCursorHidden(true)
            if decision.shouldClearTransientVisuals { clearTransientVisuals() }
            if wasVisible {
                for window in screenWindows.values { window.orderOut(nil) }
            }
        }
    }

    private func clearTransientVisuals() {
        for ripple in activeRipples { ripple.removeFromSuperlayer() }
        activeRipples.removeAll()
        for window in screenWindows.values {
            window.flippedView?.cursorLayer?.removeAnimation(forKey: "clickPulse")
        }
    }

    // MARK: - Cursor layer placement

    /// Place the cursor layer on whichever screen-window currently contains the
    /// logical position, and hide it on the others. When `animated` is false we
    /// suppress implicit CALayer animations for an instant snap.
    private func positionCursorLayers(animated: Bool) {
        let target = motionState.position
        let activeScreenID = screen(forLogical: target)?.displayID

        for (id, window) in screenWindows {
            guard let view = window.flippedView, let cursorLayer = view.cursorLayer else { continue }
            if id == activeScreenID {
                let local = view.convertFromLogical(target, in: window)
                if animated {
                    cursorLayer.position = local
                } else {
                    CATransaction.begin()
                    CATransaction.setDisableActions(true)
                    cursorLayer.position = local
                    cursorLayer.isHidden = !visualsVisible
                    CATransaction.commit()
                }
                if animated { cursorLayer.isHidden = !visualsVisible }
            } else {
                CATransaction.begin()
                CATransaction.setDisableActions(true)
                cursorLayer.isHidden = true
                CATransaction.commit()
            }
        }
    }

    private func setCursorHidden(_ hidden: Bool) {
        let activeScreenID = screen(forLogical: motionState.position)?.displayID
        for (id, window) in screenWindows {
            guard let cursorLayer = window.flippedView?.cursorLayer else { continue }
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            cursorLayer.isHidden = hidden || (id != activeScreenID)
            CATransaction.commit()
        }
    }

    // MARK: - Glide animation (daemon)

    /// Safety ceiling for a spring glide. Motion is now spring-driven and settles
    /// on its own (~0.3–0.5s); this is only the longest the awaiting `move()` will
    /// wait before force-finishing, so it can never hang. Distance-independent.
    private static func glideDuration(forDistance distance: CGFloat) -> CFTimeInterval {
        return 1.5
    }

    private func runGlide(to target: CGPoint, duration: CFTimeInterval) async {
        prepareGlide(to: target, duration: duration)
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            glideContinuation = continuation
            startTicker()
        }
    }

    @discardableResult
    private func startGlide(to target: CGPoint) -> Bool {
        let distance = hypot(
            target.x - motionState.position.x,
            target.y - motionState.position.y
        )
        guard distance > 0.5 else { return false }
        prepareGlide(to: target, duration: Self.glideDuration(forDistance: distance))
        startTicker()
        return true
    }

    private func prepareGlide(to target: CGPoint, duration: CFTimeInterval) {
        // Redirect from the current animated point. Stopping the owner ticker
        // does not reset velocity; CursorMotionState carries it into the turn.
        cancelGlide()
        motionState.startGlide(to: target)
        glideDuration = duration
        glideStartHostTime = CACurrentMediaTime()
        glideLastTick = glideStartHostTime
        positionCursorLayers(animated: false)
    }

    private func snap(to target: CGPoint) {
        cancelGlide()
        motionState.snap(to: target)
        refreshVisualPolicy(positionLayers: false)
        positionCursorLayers(animated: false)
    }

    /// Start the per-frame ticker for the active glide. On macOS the only way to
    /// get a CADisplayLink is `NSScreen/NSView/NSWindow.displayLink(target:
    /// selector:)` (macOS 14+); `CADisplayLink(target:selector:)` is
    /// unavailable here. We drive the link off the destination screen so it runs
    /// at that display's refresh rate. If, improbably, no screen is available,
    /// we degrade to a ~60Hz Timer so the glide still completes (and the
    /// awaiting `move` never hangs).
    private func startTicker() {
        let proxy = DisplayLinkProxy { [weak self] in
            self?.stepGlide()
        }

        if let screen = activeGlideScreen() {
            let link = screen.displayLink(target: proxy, selector: #selector(DisplayLinkProxy.tick))
            // Keep the proxy alive for the lifetime of the link without a
            // strong self-cycle.
            objc_setAssociatedObject(link, &Self.proxyKey, proxy, .OBJC_ASSOCIATION_RETAIN)
            link.add(to: .main, forMode: .common) // .common => ticks in modal/tracking loops too
            displayLink = link
            return
        }

        // No NSScreen — fall back to a timer so the glide still finishes.
        let timer = Timer(timeInterval: 1.0 / 60.0, repeats: true) { _ in
            MainActor.assumeIsolated { proxy.tick() }
        }
        RunLoop.main.add(timer, forMode: .common)
        fallbackTimer = timer
    }

    private static var proxyKey: UInt8 = 0

    private func activeGlideScreen() -> NSScreen? {
        // Drive the link off the screen the glide ends on (matching refresh rate
        // of the destination display).
        motionState.destination.flatMap(screen(forLogical:)) ?? NSScreen.main
    }

    private func stepGlide() {
        let now = CACurrentMediaTime()
        var dt = now - glideLastTick
        glideLastTick = now
        if dt <= 0 || dt > 0.1 { dt = 1.0 / 60.0 } // clamp first/pathological frames
        let dtf = CGFloat(dt)

        motionState.tick(deltaTime: TimeInterval(dtf))
        refreshVisualPolicy(positionLayers: false)
        positionCursorLayers(animated: false)
        applyStretch(velX: motionState.velocity.dx, velY: motionState.velocity.dy)

        if (motionState.remainingDistance < 0.5 && motionState.speed < 6)
            || (now - glideStartHostTime) > glideDuration {
            if let destination = motionState.destination {
                motionState.snap(to: destination)
            }
            positionCursorLayers(animated: false)
            applyStretch(velX: 0, velY: 0) // back to a round disc at rest
            finishGlide()
        }
    }

    /// Squash-and-stretch the orb along its velocity (Codex "scoot" stretch): the
    /// faster it travels the more it stretches along the direction of motion and
    /// squashes perpendicular, snapping back to round as it settles. Driven every
    /// tick from the spring velocity.
    private func applyStretch(velX: CGFloat, velY: CGFloat) {
        let speed = hypot(velX, velY)
        let maxStretch: CGFloat = 0.22
        let stretch = speed < 30 ? 0 : min(maxStretch, (speed / 2000) * maxStretch)
        var t = CATransform3DIdentity
        if stretch > 0.001 {
            let angle = atan2(velY, velX)
            t = CATransform3DRotate(t, angle, 0, 0, 1)
            t = CATransform3DScale(t, 1 + stretch, 1 - stretch * 0.5, 1)
            t = CATransform3DRotate(t, -angle, 0, 0, 1)
        }
        for window in screenWindows.values {
            window.flippedView?.cursorLayer?.transform = t
        }
    }

    private func finishGlide() {
        stopTicker()
        if let cont = glideContinuation {
            glideContinuation = nil
            cont.resume()
        }
    }

    /// Tear down an in-flight glide without leaving the awaiting `move` hung.
    private func cancelGlide() {
        guard displayLink != nil || fallbackTimer != nil || glideContinuation != nil else { return }
        stopTicker()
        if let cont = glideContinuation {
            glideContinuation = nil
            cont.resume()
        }
    }

    private func stopTicker() {
        displayLink?.invalidate()
        displayLink = nil
        fallbackTimer?.invalidate()
        fallbackTimer = nil
    }

    // MARK: - Click feedback

    private func pulseCursorLayer(in window: OverlayWindow, kind: ClickKind) {
        guard let cursorLayer = window.flippedView?.cursorLayer else { return }
        let pulse = CABasicAnimation(keyPath: "transform.scale")
        pulse.fromValue = 1.0
        switch kind {
        case .press:
            pulse.toValue = 0.82
            pulse.autoreverses = false
            pulse.duration = 0.12
        case .release:
            pulse.fromValue = 0.82
            pulse.toValue = 1.0
            pulse.autoreverses = false
            pulse.duration = 0.12
        default:
            pulse.toValue = 0.78
            pulse.autoreverses = true
            pulse.duration = 0.09
        }
        pulse.timingFunction = CAMediaTimingFunction(name: .easeOut)
        cursorLayer.add(pulse, forKey: "clickPulse")
    }

    private struct RippleSprite {
        let layer: CALayer
        let duration: CFTimeInterval
    }

    private func makeProceduralRipple(at local: CGPoint, color: NSColor, kind: ClickKind) -> RippleSprite {
        let startRadius: CGFloat = 7
        let endRadius: CGFloat
        let duration: CFTimeInterval
        switch kind {
        case .doubleClick:
            endRadius = 34
            duration = 0.42
        case .rightClick:
            endRadius = 30
            duration = 0.40
        case .press:
            endRadius = 22
            duration = 0.30
        case .release:
            endRadius = 26
            duration = 0.34
        case .single:
            endRadius = 28
            duration = 0.38
        }

        let ring = CAShapeLayer()
        ring.contentsScale = nearestContentsScale(forLocal: local)
        ring.bounds = CGRect(x: 0, y: 0, width: endRadius * 2, height: endRadius * 2)
        ring.position = local
        ring.fillColor = NSColor.clear.cgColor
        ring.strokeColor = color.cgColor
        ring.lineWidth = 2.5
        ring.path = CGPath(ellipseIn: CGRect(x: endRadius - startRadius,
                                             y: endRadius - startRadius,
                                             width: startRadius * 2,
                                             height: startRadius * 2),
                           transform: nil)

        // Expand the ring while fading it out.
        let scale = CABasicAnimation(keyPath: "transform.scale")
        scale.fromValue = 0.35
        scale.toValue = 1.0
        scale.timingFunction = CAMediaTimingFunction(name: .easeOut)

        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 0.9
        fade.toValue = 0.0
        fade.timingFunction = CAMediaTimingFunction(name: .easeOut)

        let group = CAAnimationGroup()
        group.animations = [scale, fade]
        group.duration = duration
        group.isRemovedOnCompletion = true
        group.fillMode = .forwards
        ring.opacity = 0
        ring.add(group, forKey: "ripple")

        return RippleSprite(layer: ring, duration: duration)
    }

    private func makeRasterRipple(at local: CGPoint, kind: ClickKind) -> RippleSprite? {
        guard let frames = Self.rasterFrames, !frames.isEmpty else { return nil }

        let size: CGFloat = 64
        let layer = CALayer()
        layer.contentsScale = nearestContentsScale(forLocal: local)
        layer.bounds = CGRect(x: 0, y: 0, width: size, height: size)
        layer.position = local
        layer.contents = frames.first
        layer.opacity = 1

        let fps = 30.0
        let duration = Double(frames.count) / fps

        let keys = CAKeyframeAnimation(keyPath: "contents")
        keys.values = frames
        keys.calculationMode = .discrete
        keys.duration = duration
        keys.isRemovedOnCompletion = true

        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 1.0
        fade.toValue = 0.0
        fade.beginTime = duration * 0.6
        fade.duration = duration * 0.4
        fade.fillMode = .forwards

        let group = CAAnimationGroup()
        group.animations = [keys, fade]
        group.duration = duration
        group.isRemovedOnCompletion = true
        layer.add(group, forKey: "rasterRipple")

        return RippleSprite(layer: layer, duration: duration)
    }

    private func scheduleRippleRemoval(_ layer: CALayer, after duration: CFTimeInterval) {
        activeRipples.append(layer)
        let ns = UInt64((duration + 0.05) * 1_000_000_000)
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: ns)
            layer.removeFromSuperlayer()
            self?.activeRipples.removeAll { $0 === layer }
        }
    }

    private func nearestContentsScale(forLocal local: CGPoint) -> CGFloat {
        screen(forLogical: motionState.position)?.backingScaleFactor ?? 2.0
    }

    private static func accentColor(for kind: ClickKind) -> NSColor {
        switch kind {
        case .rightClick:
            return NSColor.systemOrange
        case .doubleClick:
            return NSColor.systemTeal
        case .press, .release:
            return NSColor.systemYellow
        case .single:
            return NSColor(calibratedRed: 0.30, green: 0.62, blue: 1.0, alpha: 1.0)
        }
    }

    // MARK: - Headless disk persistence

    private static func runtimeDir() -> URL {
        let config = ProcessInfo.processInfo.environment["CLAUDE_CONFIG_DIR"]
            .flatMap { $0.isEmpty ? nil : ($0 as NSString).expandingTildeInPath }
            ?? (NSHomeDirectory() as NSString).appendingPathComponent(".claude")
        let dir = URL(fileURLWithPath: config).appendingPathComponent(".runtime", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private static func cursorFile() -> URL {
        runtimeDir().appendingPathComponent("cu-helper.cursor.json", isDirectory: false)
    }

    private struct PersistedPoint: Codable {
        let x: Double
        let y: Double
    }

    private static func readPersistedPoint() -> CGPoint? {
        let url = cursorFile()
        guard let data = try? Data(contentsOf: url),
              let p = try? JSONDecoder().decode(PersistedPoint.self, from: data),
              p.x.isFinite, p.y.isFinite
        else { return nil }
        return CGPoint(x: p.x, y: p.y)
    }

    private static func persistPoint(_ p: CGPoint) {
        let url = cursorFile()
        let payload = PersistedPoint(x: Double(p.x), y: Double(p.y))
        guard let data = try? JSONEncoder().encode(payload) else { return }
        // Atomic write so a sibling reader never sees a half-written file.
        try? data.write(to: url, options: .atomic)
    }

    // MARK: - Raster ripple loading

    /// Load optional click-ripple PNG frames bundled under
    /// `Resources/LensSequence`. Frames are sorted by filename so `frame_000`,
    /// `frame_001`, … animate in order. Missing or unreadable optional frames
    /// leave `frames` nil, so `showClick` uses the procedural ring. The resource
    /// probe calls this same loader without creating a cursor or posting input.
    static func loadLensSequence(from bundle: Bundle = .main) -> (directory: URL?, frames: [CGImage]?) {
        let fm = FileManager.default

        // SwiftPM's generated Bundle.module accessor traps when its bundle is
        // absent from the app root and the absolute build-machine path. Our
        // signed app instead puts resources in Contents/Resources. Never invoke
        // that accessor for optional visuals: discover only runtime-relative
        // locations, including the sibling bundle of a bare SwiftPM executable.
        let moduleName = "cu-helper_cc-haha-computer-use.bundle"
        var candidates = [bundle.resourceURL, bundle.bundleURL, bundle.executableURL?.deletingLastPathComponent()]
            .compactMap { $0 }
            .map { $0.appendingPathComponent(moduleName, isDirectory: true)
                .appendingPathComponent("LensSequence", isDirectory: true) }
        if let resources = bundle.resourceURL {
            candidates.append(resources.appendingPathComponent("LensSequence", isDirectory: true))
        }
        let directory = candidates.first { candidate in
            var isDirectory: ObjCBool = false
            return fm.fileExists(atPath: candidate.path, isDirectory: &isDirectory) && isDirectory.boolValue
        }

        guard let dir = directory,
              let entries = try? fm.contentsOfDirectory(
                at: dir,
                includingPropertiesForKeys: nil,
                options: [.skipsHiddenFiles]
              )
        else { return (directory, nil) }

        let pngs = entries
            .filter { $0.pathExtension.lowercased() == "png" }
            .sorted { $0.lastPathComponent.localizedStandardCompare($1.lastPathComponent) == .orderedAscending }

        guard !pngs.isEmpty else { return (directory, nil) }

        var images: [CGImage] = []
        images.reserveCapacity(pngs.count)
        for url in pngs {
            guard let nsImage = NSImage(contentsOf: url) else { continue }
            var rect = CGRect(origin: .zero, size: nsImage.size)
            guard let cg = nsImage.cgImage(forProposedRect: &rect, context: nil, hints: nil) else { continue }
            images.append(cg)
        }
        return (directory, images.isEmpty ? nil : images)
    }
}

// MARK: - Display link proxy

/// Bridges the ObjC selector-based CADisplayLink target to a Swift closure
/// without a strong self-cycle. `@objc` on a final class method is fine under
/// strict concurrency; the closure hops are all on the main actor.
@MainActor
private final class DisplayLinkProxy: NSObject {
    private let onTick: () -> Void
    init(onTick: @escaping () -> Void) {
        self.onTick = onTick
        super.init()
    }
    @objc func tick() {
        onTick()
    }
}

// MARK: - Overlay window

/// A borderless, transparent, click-through window that floats above
/// everything (including full-screen apps) and never accepts key/main status —
/// so it can show the virtual cursor without stealing focus from the app the
/// AI is driving.
@MainActor
private final class OverlayWindow: NSWindow {

    var flippedView: FlippedOverlayView? { contentView as? FlippedOverlayView }

    func configureAsCursorOverlay() {
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        ignoresMouseEvents = true              // click-through
        level = NSWindow.Level(rawValue: Int(CGShieldingWindowLevel()))
        collectionBehavior = [
            .canJoinAllSpaces,
            .stationary,
            .ignoresCycle,
            .fullScreenAuxiliary,
        ]
        // Never participate in window restoration / Exposé / cycling.
        isExcludedFromWindowsMenu = true
        isReleasedWhenClosed = false
        animationBehavior = .none
        // Keep the window itself transparent to hit-testing entirely.
        hidesOnDeactivate = false

        let view = FlippedOverlayView(frame: CGRect(origin: .zero, size: frame.size))
        view.wantsLayer = true
        view.layer?.backgroundColor = NSColor.clear.cgColor
        view.layer?.masksToBounds = false
        contentView = view
    }

    // A borderless window normally cannot become key; make that explicit so we
    // never grab focus even if something calls makeKey on us.
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
    override var acceptsFirstResponder: Bool { false }
}

// MARK: - Flipped overlay view

/// Top-left origin so layer coordinates map onto logical / screenshot space.
/// Hosts the cursor CALayer and any transient ripple layers.
@MainActor
private final class FlippedOverlayView: NSView {

    /// Logical (top-left, global) origin of THIS screen — subtract from a global
    /// logical point to get a view-local point.
    var logicalOrigin: CGPoint = .zero

    private(set) var cursorLayer: CALayer?

    override var isFlipped: Bool { true }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) unavailable") }

    override func hitTest(_ point: NSPoint) -> NSView? {
        // Fully click-through regardless of layer content.
        nil
    }

    func syncContentsScale(_ scale: CGFloat) {
        layer?.contentsScale = scale
        cursorLayer?.contentsScale = scale
        for sub in cursorLayer?.sublayers ?? [] {
            sub.contentsScale = scale
        }
    }

    /// Convert a global LOGICAL point to this view's local coordinates.
    func convertFromLogical(_ p: CGPoint, in window: NSWindow) -> CGPoint {
        CGPoint(x: p.x - logicalOrigin.x, y: p.y - logicalOrigin.y)
    }

    /// Build the cursor layer once, in the configured style.
    func installCursorLayer() {
        guard cursorLayer == nil, let host = layer else { return }
        let cursor = VirtualCursorStyle.current == .fog
            ? Self.makeOrbCursorLayer()
            : Self.makeArrowCursorLayer()
        cursor.contentsScale = host.contentsScale
        cursor.isHidden = true
        host.addSublayer(cursor)
        cursorLayer = cursor
    }

    /// The AI's virtual cursor as an actual POINTER — a macOS-shaped arrow.
    ///
    /// This is the default because a cursor's job is to point: a round blob has
    /// no tip, so it cannot show *which pixel* is about to be clicked, and it
    /// does not read as a mouse pointer at all. Codex ships both looks
    /// (`SoftwareCursorStyle` = `arrow` | `fog`); we default to the arrow and
    /// keep the orb available via `VirtualCursorStyle`.
    ///
    /// It must never be mistaken for the user's real pointer, so the silhouette
    /// is the familiar arrow while the fill is the product accent with a white
    /// keyline — recognisable as a pointer, obviously not the system one.
    /// Hot-spot is the TIP (anchorPoint 0,0 in this geometry-flipped layer).
    private static func makeArrowCursorLayer() -> CALayer {
        let path = VirtualCursorStyle.arrowPath()
        let box = path.boundingBox

        let container = CALayer()
        container.bounds = CGRect(x: 0, y: 0, width: box.maxX, height: box.maxY)
        // (0,0) is the tip: the layer's position IS the point being acted on.
        container.anchorPoint = .zero

        // Halo first, so it renders behind the silhouette.
        let halo = makeHaloLayer(centeredOn: CGPoint(x: box.midX, y: box.midY),
                                 arrowHeight: box.maxY)
        container.addSublayer(halo)

        let shape = CAShapeLayer()
        shape.path = path
        shape.frame = container.bounds
        shape.fillColor = NSColor(srgbRed: 0.0, green: 0.46, blue: 0.95, alpha: 1).cgColor
        // White keyline keeps the silhouette readable over dark UI.
        shape.strokeColor = NSColor.white.cgColor
        shape.lineWidth = 1.5
        shape.lineJoin = .round
        // Soft drop shadow so the arrow separates from same-coloured content.
        // It belongs on the silhouette, NOT the container: a container shadow is
        // derived from every sublayer's alpha, so the halo would cast a large
        // blurred smudge instead of the arrow casting a crisp one.
        shape.shadowColor = NSColor.black.cgColor
        shape.shadowOpacity = 0.35
        shape.shadowRadius = 3
        shape.shadowOffset = CGSize(width: 0, height: 1)
        shape.shadowPath = path
        container.addSublayer(shape)

        // Liveness. The bob rides the silhouette rather than the container
        // because `clickPulse` animates the container's `transform.scale`, and
        // two animations on sibling key paths of one `transform` fight.
        halo.add(Self.haloBreathAnimations(), forKey: "haloBreath")
        shape.add(Self.idleBobAnimation(), forKey: "idleBob")

        // Position/transform are driven per tick; kill implicit animations so
        // Core Animation does not double-animate the glide.
        container.actions = [
            "position": NSNull(),
            "bounds": NSNull(),
            "hidden": NSNull(),
            "transform": NSNull(),
        ]
        return container
    }

    /// The soft aura behind the arrow: a radial fade from the product accent to
    /// clear, centred on the silhouette rather than on the tip so the glow looks
    /// like it belongs to the pointer instead of leaking out of its point.
    private static func makeHaloLayer(
        centeredOn center: CGPoint,
        arrowHeight: CGFloat
    ) -> CALayer {
        let diameter = VirtualCursorStyle.haloDiameter(forArrowHeight: arrowHeight)
        let halo = CAGradientLayer()
        halo.type = .radial
        let accent = NSColor(srgbRed: 0.15, green: 0.55, blue: 1.0, alpha: 1)
        halo.colors = [
            accent.withAlphaComponent(0.42).cgColor,
            accent.withAlphaComponent(0.16).cgColor,
            accent.withAlphaComponent(0.0).cgColor,
        ]
        halo.locations = [0.0, 0.55, 1.0]
        halo.startPoint = CGPoint(x: 0.5, y: 0.5)
        halo.endPoint = CGPoint(x: 1.0, y: 1.0)
        halo.bounds = CGRect(x: 0, y: 0, width: diameter, height: diameter)
        halo.anchorPoint = CGPoint(x: 0.5, y: 0.5)
        halo.position = center
        // The halo is decoration only — it must never be mistaken for the
        // silhouette, and it must not intercept the geometry the tip promises.
        halo.actions = ["opacity": NSNull(), "transform": NSNull()]
        return halo
    }

    /// Swell-and-fade, run forever. Scale and opacity share one period so the
    /// halo reads as a single breath rather than two overlapping effects.
    private static func haloBreathAnimations() -> CAAnimationGroup {
        let period = VirtualCursorStyle.haloBreathPeriod

        let scale = CABasicAnimation(keyPath: "transform.scale")
        scale.fromValue = 0.86
        scale.toValue = 1.14

        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 0.5
        fade.toValue = 1.0

        let group = CAAnimationGroup()
        group.animations = [scale, fade]
        // autoreverses doubles the duration, so one leg is half a period.
        group.duration = period / 2
        group.autoreverses = true
        group.repeatCount = .infinity
        group.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        // Keep breathing while the overlay is hidden between actions; otherwise
        // the first frame after it reappears is a visible jump to full size.
        group.isRemovedOnCompletion = false
        return group
    }

    /// A small vertical drift, run forever, so a cursor waiting out a long model
    /// turn still reads as alive. Amplitude is capped in `VirtualCursorStyle`
    /// precisely because the tip is a claim about where the click will land.
    private static func idleBobAnimation() -> CABasicAnimation {
        let amplitude = VirtualCursorStyle.idleBobAmplitude
        let bob = CABasicAnimation(keyPath: "transform.translation.y")
        bob.fromValue = -amplitude
        bob.toValue = amplitude
        bob.duration = VirtualCursorStyle.idleBobPeriod / 2
        bob.autoreverses = true
        bob.repeatCount = .infinity
        bob.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        bob.isRemovedOnCompletion = false
        return bob
    }

    /// The AI's virtual cursor, rendered as a soft blue "fog orb" (Codex parity)
    /// instead of an arrow: a radial-gradient disc (deep-blue core → cyan-white
    /// rim) with a white glint orbiting inside it, plus an outer blue glow so it
    /// reads over any background and is clearly NOT the user's real pointer. The
    /// hot-spot is the orb's CENTER (anchorPoint 0.5,0.5) — a round cursor points
    /// with its middle, not a tip. Colours sampled pixel-for-pixel from Codex's
    /// Lens frames; drawn purely with CALayer/CAGradient (no bundled raster).
    private static func makeOrbCursorLayer() -> CALayer {
        let diameter: CGFloat = 24
        let container = CALayer()
        container.bounds = CGRect(x: 0, y: 0, width: diameter, height: diameter)
        container.anchorPoint = CGPoint(x: 0.5, y: 0.5)

        // Radial disc: deep-blue core → cyan → bright-white rim (sampled colours).
        let orb = NonAnimatedGradientLayer()
        orb.type = .radial
        orb.frame = container.bounds
        orb.colors = [
            NSColor(srgbRed: 0.000, green: 0.463, blue: 0.949, alpha: 1).cgColor, // #0076F2 core
            NSColor(srgbRed: 0.020, green: 0.502, blue: 0.961, alpha: 1).cgColor, // #0580F5
            NSColor(srgbRed: 0.071, green: 0.580, blue: 0.988, alpha: 1).cgColor, // #1294FC
            NSColor(srgbRed: 0.349, green: 0.773, blue: 0.996, alpha: 1).cgColor, // #59C5FE cyan rim
            NSColor(srgbRed: 0.855, green: 0.949, blue: 0.996, alpha: 1).cgColor, // #DAF2FE bright edge
        ]
        orb.locations = [0.0, 0.5, 0.7, 0.88, 1.0]
        orb.startPoint = CGPoint(x: 0.5, y: 0.5)
        orb.endPoint = CGPoint(x: 1.0, y: 1.0)
        orb.cornerRadius = diameter / 2
        orb.masksToBounds = true
        container.addSublayer(orb)

        // White glint orbiting near the rim — the "light refracting in glass" look
        // that makes Codex's orb feel alive. A soft white dot circling the centre.
        let glint = CALayer()
        let glintD: CGFloat = 6
        glint.bounds = CGRect(x: 0, y: 0, width: glintD, height: glintD)
        glint.cornerRadius = glintD / 2
        glint.backgroundColor = NSColor.white.cgColor
        glint.opacity = 0.85
        glint.shadowColor = NSColor.white.cgColor
        glint.shadowRadius = 2.5
        glint.shadowOpacity = 0.9
        glint.shadowOffset = .zero
        let orbitR: CGFloat = diameter * 0.26
        let centre = CGPoint(x: diameter / 2, y: diameter / 2)
        glint.position = CGPoint(x: centre.x, y: centre.y - orbitR)
        let orbit = CAKeyframeAnimation(keyPath: "position")
        orbit.path = CGPath(
            ellipseIn: CGRect(x: centre.x - orbitR, y: centre.y - orbitR, width: orbitR * 2, height: orbitR * 2),
            transform: nil
        )
        orbit.duration = 1.3
        orbit.calculationMode = .paced
        orbit.repeatCount = .infinity
        orbit.isRemovedOnCompletion = false
        glint.add(orbit, forKey: "orbit")
        container.addSublayer(glint)

        // Outer blue glow so the orb is visible over varied backgrounds.
        container.shadowColor = NSColor(srgbRed: 0.0, green: 0.46, blue: 0.95, alpha: 1).cgColor
        container.shadowOpacity = 0.55
        container.shadowRadius = 6
        container.shadowOffset = .zero

        // We drive position/transform ourselves every tick; kill implicit
        // animations so CA doesn't double-animate.
        container.actions = [
            "position": NSNull(),
            "bounds": NSNull(),
            "hidden": NSNull(),
            "transform": NSNull(),
        ]
        return container
    }
}

// MARK: - NSScreen helpers

private extension NSScreen {
    /// The CGDirectDisplayID backing this screen, if available.
    var displayID: CGDirectDisplayID? {
        let key = NSDeviceDescriptionKey("NSScreenNumber")
        return deviceDescription[key] as? CGDirectDisplayID
    }

    /// Whether this screen is the primary (its CGDisplayBounds origin is (0,0)).
    var isPrimaryFlippedScreen: Bool {
        guard let id = displayID else { return false }
        let b = CGDisplayBounds(id)
        return b.origin == .zero
    }

    /// Primary screen height in points — the pivot for Quartz(top-left) ↔
    /// Cocoa(bottom-left) flips.
    static var primaryHeight: CGFloat {
        // The first screen in `screens` is the one with the menu bar (primary).
        NSScreen.screens.first?.frame.height ?? CGDisplayBounds(CGMainDisplayID()).height
    }
}
