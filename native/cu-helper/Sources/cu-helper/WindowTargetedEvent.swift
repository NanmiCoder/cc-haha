import AppKit
import CoreGraphics
import Foundation

/// Binds a synthesized mouse event to the WINDOW it is aimed at.
///
/// WHY THIS EXISTS — the bug it fixes
/// ----------------------------------
/// `CGEvent.postToPid` delivers an event to a process, but a bare CGEvent has
/// no window association: its window number is 0 and its window-local location
/// is unset. Native AppKit apps cope, because AppKit re-hit-tests the event
/// against its own windows. Chromium/CEF apps do NOT: their input pipeline
/// routes by the window the event claims to belong to, so a window-less event
/// is dropped on the floor. Every click and keystroke aimed at NetEase Music,
/// VS Code, Slack, Discord — any Electron app — silently did nothing while the
/// helper reported "Action completed".
///
/// The fix is to stamp the window identity onto the event before posting:
///
///   1. Mouse events use `+[NSEvent mouseEventWithType:…windowNumber:…]` and its
///      `.cgEvent`. Scroll events use the official private CGEvent field 51
///      (windowNumber), confirmed by its initializer at 0x100714188.
///   2. `kCGMouseEventSubtype = 3` (NX_SUBTYPE_MOUSE_TOUCH) plus fields 91/92
///      (`WindowUnderMousePointer` / `…ThatCanHandleThisEvent`) = the window ID.
///   3. `CGEventSetWindowLocation` with the point expressed in WINDOW-LOCAL
///      coordinates. This is a private SPI (SkyLight's `SLEventSetWindowLocation`
///      re-exported by CoreGraphics), resolved by name at runtime.
///
/// Verified on a real CEF app: click focuses the field, typing lands in it, the
/// search dropdown opens — and the user's real pointer never moves, nor is the
/// target forced to the foreground. Both properties are why this is preferred
/// over posting to the global HID/session tap, which works but hijacks the
/// physical cursor.
///
/// This mirrors what Codex's Computer Use service does (recovered from its
/// `SynthesizedEvent.mouseEvent` implementation), including the easy-to-miss
/// `subtype = 3`.
enum WindowTargetedEvent {
    /// `CGEventSetWindowLocation(CGEventRef, CGPoint)` — private, so resolved by
    /// name. Absent ⇒ we skip the window-local stamp rather than fail: the event
    /// still carries its window number and fields 91/92, which is strictly
    /// better than not posting at all.
    private typealias SetWindowLocation = @convention(c) (CGEvent, CGPoint) -> Void

    private static let setWindowLocation: SetWindowLocation? = {
        guard let handle = dlopen(nil, RTLD_LAZY),
              let symbol = dlsym(handle, "CGEventSetWindowLocation") else {
            return nil
        }
        return unsafeBitCast(symbol, to: SetWindowLocation.self)
    }()

    /// True when the private window-location SPI is available. Surfaced for
    /// diagnostics; actuation degrades rather than fails when it is not.
    static var canStampWindowLocation: Bool { setWindowLocation != nil }

    /// What the last mouse event actually did, so a failing real-machine run can
    /// say WHERE it diverged instead of leaving us to guess.
    ///
    /// This exists because the window-bound path degrades SILENTLY: when the
    /// window cannot be identified we fall back to a plain CGEvent — exactly the
    /// broken behaviour this file was written to fix — and from the outside both
    /// outcomes look identical ("Action completed", nothing happens).
    struct LastEventDiagnostic: Sendable {
        var windowTargeted = false
        var stampedWindowLocation = false
        var nsEventCreated = false
        var windowID: CGWindowID = kCGNullWindowID
        var globalPoint: CGPoint = .zero
        var windowLocalPoint: CGPoint = .zero
        var reason = "no mouse event built yet"
    }

    private final class DiagnosticBox: @unchecked Sendable {
        private let lock = NSLock()
        private var value = LastEventDiagnostic()
        func read() -> LastEventDiagnostic { lock.lock(); defer { lock.unlock() }; return value }
        func write(_ new: LastEventDiagnostic) { lock.lock(); value = new; lock.unlock() }
    }

    private static let diagnosticBox = DiagnosticBox()

    static var lastDiagnostic: LastEventDiagnostic { diagnosticBox.read() }

    static func recordDiagnostic(_ diagnostic: LastEventDiagnostic) {
        diagnosticBox.write(diagnostic)
        appendToLog(diagnostic)
    }

    /// Mirror each decision to a file under the runtime directory.
    ///
    /// An in-memory field is only readable through a helper command, and the
    /// helper refuses commands from anything but the signed app — so nobody
    /// debugging a failed run can actually read it. A file can be read after
    /// the fact by whoever is looking, which is the entire point of a
    /// diagnostic. Best-effort: a logging failure must never affect actuation.
    private static func appendToLog(_ d: LastEventDiagnostic) {
        guard let dir = runtimeDirectory else { return }
        var fields: [String] = []
        fields.append("\"windowTargeted\":\(d.windowTargeted)")
        fields.append("\"stampedWindowLocation\":\(d.stampedWindowLocation)")
        fields.append("\"nsEventCreated\":\(d.nsEventCreated)")
        fields.append("\"windowID\":\(d.windowID)")
        fields.append("\"globalX\":\(d.globalPoint.x)")
        fields.append("\"globalY\":\(d.globalPoint.y)")
        fields.append("\"localX\":\(d.windowLocalPoint.x)")
        fields.append("\"localY\":\(d.windowLocalPoint.y)")
        fields.append("\"windowLocationSPI\":\(canStampWindowLocation)")
        fields.append("\"focusSPI\":\(WindowKeyFocus.isAvailable)")
        fields.append("\"reason\":\"\(d.reason)\"")
        let line = "{" + fields.joined(separator: ",") + "}\n"
        guard let data = line.data(using: .utf8) else { return }
        let url = dir.appendingPathComponent("cu-helper.injection.log")
        if let handle = try? FileHandle(forWritingTo: url) {
            defer { try? handle.close() }
            _ = try? handle.seekToEnd()
            try? handle.write(contentsOf: data)
        } else {
            try? data.write(to: url)
        }
    }

    private static let runtimeDirectory: URL? = {
        let config = ProcessInfo.processInfo.environment["CLAUDE_CONFIG_DIR"]
            .flatMap { $0.isEmpty ? nil : ($0 as NSString).expandingTildeInPath }
            ?? (NSHomeDirectory() as NSString).appendingPathComponent(".claude")
        let dir = URL(fileURLWithPath: config)
            .appendingPathComponent(".runtime")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }()

    /// AppKit requires a distinct, monotonically increasing event number per
    /// synthesized event; reusing one makes a burst read as a single event.
    /// Lock-guarded rather than actor-isolated because event construction runs
    /// on whichever thread the command router is on.
    private final class EventNumberCounter: @unchecked Sendable {
        private let lock = NSLock()
        private var value = 0

        func next() -> Int {
            lock.lock()
            defer { lock.unlock() }
            value &+= 1
            if value < 1 { value = 1 }
            return value
        }
    }

    private static let eventNumbers = EventNumberCounter()

    static func nextEventNumber() -> Int { eventNumbers.next() }

    /// Window-local point for a global (Quartz, top-left) screen point.
    ///
    /// Top-left origin, NOT flipped. The reference implementation flips only
    /// when the target window reports flipped coordinates, and we could not
    /// read that per-window flag from outside the app — so this is settled
    /// empirically: against a live CEF window the unflipped point landed
    /// exactly on target twice (search field, and a collapse control 15pt from
    /// the top), while flipping put the click at the opposite edge and opened
    /// the player. If a window ever turns out to want the flip, the symptom is
    /// distinctive — clicks land mirrored about the window's horizontal centre.
    static func windowLocalPoint(
        globalPoint: CGPoint,
        windowBounds: CGRect
    ) -> CGPoint {
        CGPoint(
            x: globalPoint.x - windowBounds.origin.x,
            y: globalPoint.y - windowBounds.origin.y
        )
    }

    /// Build a window-targeted mouse event, or nil when AppKit refuses to make
    /// one (caller falls back to a plain CGEvent).
    ///
    /// - Parameters:
    ///   - point: global Quartz (top-left) screen point.
    ///   - windowID: target window; 0 means "unknown", and the window stamps are
    ///     skipped so the event is still posted rather than mis-addressed.
    ///   - windowBounds: target window frame in the same global space, for the
    ///     window-local stamp. Nil skips only that stamp.
    static func makeMouseEvent(
        type: CGEventType,
        nsType: NSEvent.EventType,
        point: CGPoint,
        button: MouseButton,
        clickCount: Int,
        windowID: CGWindowID,
        windowBounds: CGRect?,
        // A press and the release that ends it must carry the SAME number:
        // that pairing is how AppKit ties two events into one click. Taking a
        // fresh number per event — which is what this did when the caller
        // passed nothing — hands the target a press and a release it has no
        // reason to associate. Callers building a gesture pass the shared
        // number explicitly; a lone event may still take the next one.
        eventNumber: Int? = nil
    ) -> CGEvent? {
        guard let nsEvent = NSEvent.mouseEvent(
            with: nsType,
            location: point,
            modifierFlags: [],
            // Zero here on purpose: the authoritative timestamp is stamped
            // immediately before posting, so a queued event is never stale.
            timestamp: 0,
            windowNumber: Int(windowID),
            context: nil,
            eventNumber: eventNumber ?? nextEventNumber(),
            clickCount: clickCount,
            // Constant 1.0 for every mouse event, including the up — matching
            // the reference implementation. A 0-pressure release is not what a
            // real mouse produces, and some hit-tests read it.
            pressure: 1.0
        ), let event = nsEvent.cgEvent else {
            var failed = LastEventDiagnostic()
            failed.globalPoint = point
            failed.windowID = windowID
            failed.reason = "NSEvent.mouseEvent or .cgEvent returned nil"
            recordDiagnostic(failed)
            return nil
        }
        var diagnostic = LastEventDiagnostic()
        diagnostic.nsEventCreated = true
        diagnostic.globalPoint = point
        diagnostic.windowID = windowID

        event.location = point
        event.setIntegerValueField(.mouseEventButtonNumber, value: Int64(button.cg.rawValue))
        // NX_SUBTYPE_MOUSE_TOUCH, copied from the reference implementation.
        //
        // NOT load-bearing, and the comment here used to claim it was: a
        // single-variable A/B on a live CEF target showed the click focuses and
        // typing lands with this line removed. Kept anyway — it costs nothing,
        // it matches what a real mouse event carries, and the reference sets it
        // — but do not treat it as the fix if targeting ever breaks. The three
        // stamps that DO carry the routing are the window number (baked in via
        // NSEvent above), fields 91/92, and the window-local location below.
        event.setIntegerValueField(mouseSubtypeField, value: 3)

        if windowID != kCGNullWindowID {
            event.setIntegerValueField(windowUnderPointerField, value: Int64(windowID))
            event.setIntegerValueField(windowThatCanHandleField, value: Int64(windowID))
            diagnostic.windowTargeted = true
            if let windowBounds, let stamp = setWindowLocation {
                let local = windowLocalPoint(globalPoint: point, windowBounds: windowBounds)
                stamp(event, local)
                diagnostic.windowLocalPoint = local
                diagnostic.stampedWindowLocation = true
                diagnostic.reason = "ok"
            } else {
                diagnostic.reason = windowBounds == nil
                    ? "window bounds unknown — no window-local stamp"
                    : "CGEventSetWindowLocation unavailable"
            }
        } else {
            diagnostic.reason = "no window identified — fell back to a window-less event"
        }
        recordDiagnostic(diagnostic)
        return event
    }

    /// Stamp a fresh timestamp and deliver. Separated from construction because
    /// a burst is allocated up front (so a mid-burst failure cannot leave a
    /// button held) but must carry send-time timestamps.
    static func post(_ event: CGEvent, to pid: pid_t) {
        event.timestamp = DispatchTime.now().uptimeNanoseconds
        event.postToPid(pid)
    }

    static func makeScrollEvent(
        source: CGEventSource,
        point: CGPoint,
        deltaX: Int32,
        deltaY: Int32,
        window: WindowGeometry.Window
    ) -> CGEvent? {
        // Keep two usable axes. The inspected official version passes one and
        // consequently loses horizontal deltas; reproducing that bug is not
        // required for its pixel/page contract.
        guard let event = CGEvent(scrollWheelEvent2Source: source, units: .pixel,
                                  wheelCount: 2, wheel1: deltaY, wheel2: deltaX, wheel3: 0) else { return nil }
        event.location = point
        event.setIntegerValueField(CGEventField(rawValue: 51)!, value: Int64(window.id))
        event.setIntegerValueField(windowUnderPointerField, value: Int64(window.id))
        event.setIntegerValueField(windowThatCanHandleField, value: Int64(window.id))
        if let stamp = setWindowLocation {
            stamp(event, windowLocalPoint(globalPoint: point, windowBounds: window.bounds))
        }
        return event
    }

    // CGEventField has no public constants for these three.
    private static let mouseSubtypeField = CGEventField(rawValue: 7)!
    private static let windowUnderPointerField = CGEventField(rawValue: 91)!
    private static let windowThatCanHandleField = CGEventField(rawValue: 92)!
}
