import AppKit

final class ReceiptView: NSView {
    var completed = 0
    var held = false
    var unpaired = 0
    var otherEvents = 0
    var sources: [Int64] = []
    private var events: [[String: Any]] = []
    private var eventsTruncated = 0
    private var launchBoundaryPassed = false
    private var lastSaved: Data?
    private let maximumRecordedEvents = 256
    let receipt: URL
    let helperPIDFile: URL

    init(receipt: URL, helperPIDFile: URL) {
        self.receipt = receipt
        self.helperPIDFile = helperPIDFile
        super.init(frame: NSRect(x: 0, y: 0, width: 360, height: 280))
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel("Temporary drag canvas")
    }

    required init?(coder: NSCoder) { fatalError("not used") }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDown(with event: NSEvent) {
        guard belongsToHelper(event) else { return }
        if held { unpaired += 1 }
        held = true
        save()
    }
    override func mouseDragged(with event: NSEvent) {
        guard belongsToHelper(event) else { return }
        if !held { unpaired += 1 }
        save()
    }
    override func mouseUp(with event: NSEvent) {
        guard belongsToHelper(event) else { return }
        if !held { unpaired += 1 }
        held = false
        completed += 1
        save()
    }
    override func draw(_ dirtyRect: NSRect) {
        NSColor(calibratedRed: 0.15, green: 0.22, blue: 0.30, alpha: 1).setFill()
        bounds.fill()
        ("Temporary Computer Use fixture" as NSString).draw(at: NSPoint(x: 35, y: 130), withAttributes: [.foregroundColor: NSColor.white])
    }
    func publishReady() {
        launchBoundaryPassed = true
        save()
    }
    func refresh() { save() }
    private func save() {
        guard launchBoundaryPassed else { return }
        let running = NSRunningApplication.current
        let frame = window?.frame ?? .zero
        let launchTime = running.launchDate?.timeIntervalSinceReferenceDate
        let ready = running.processIdentifier > 0
            && running.bundleIdentifier.map { !$0.isEmpty } == true
            && running.executableURL.map { !$0.path.isEmpty } == true
            && launchTime.map { $0.isFinite && $0 > 0 } == true
            && (window?.windowNumber ?? 0) > 0
            && frame.width > 0 && frame.height > 0
            && window?.isVisible == true
        let value: [String: Any] = [
            "ready": ready,
            "pid": Int(running.processIdentifier),
            "bundleID": running.bundleIdentifier as Any? ?? NSNull(),
            "executable": running.executableURL?.path as Any? ?? NSNull(),
            "launchTime": launchTime as Any? ?? NSNull(),
            "windowID": window?.windowNumber ?? 0,
            "windowFrame": ["x": frame.origin.x, "y": frame.origin.y, "width": frame.width, "height": frame.height],
            "visible": window?.isVisible ?? false,
            "hidden": NSApplication.shared.isHidden,
            "onActiveSpace": window?.isOnActiveSpace ?? false,
            "miniaturized": window?.isMiniaturized ?? false,
            "completed": completed, "held": held, "unpaired": unpaired,
            "otherEvents": otherEvents, "sources": sources,
            "events": events, "eventsTruncated": eventsTruncated,
        ]
        if let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), data != lastSaved {
            do {
                try data.write(to: receipt, options: .atomic)
                lastSaved = data
            } catch {
                // Leave lastSaved unchanged so the next timer tick retries.
            }
        }
    }
    private func belongsToHelper(_ event: NSEvent) -> Bool {
        let source = event.cgEvent?.getIntegerValueField(.eventSourceUnixProcessID) ?? -1
        let text = (try? String(contentsOf: helperPIDFile, encoding: .utf8)) ?? ""
        let expected = Int64(text.trimmingCharacters(in: .whitespacesAndNewlines))
        let accepted = expected.map { $0 > 0 && source == $0 } ?? false
        if events.count < maximumRecordedEvents {
            sources.append(source)
            events.append([
                "type": event.type.rawValue,
                "sourcePID": source,
                "expectedHelperPID": expected as Any? ?? NSNull(),
                "accepted": accepted,
                "marker": event.cgEvent?.getIntegerValueField(.eventSourceUserData) ?? -1,
                "windowNumber": event.windowNumber,
                "eventNumber": event.eventNumber,
                "localX": event.locationInWindow.x,
                "localY": event.locationInWindow.y,
                "timestamp": event.timestamp,
                "receivedUptime": ProcessInfo.processInfo.systemUptime,
            ])
        } else {
            eventsTruncated += 1
        }
        if !accepted {
            otherEvents += 1
            save()
            return false
        }
        return true
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
app.finishLaunching()
let view = ReceiptView(receipt: URL(fileURLWithPath: CommandLine.arguments[1]), helperPIDFile: URL(fileURLWithPath: CommandLine.arguments[2]))
let stop = URL(fileURLWithPath: CommandLine.arguments[3])
let window = NSWindow(contentRect: view.frame, styleMask: [.titled, .closable], backing: .buffered, defer: false)
window.title = "Temporary Computer Use fixture"
window.contentView = view
window.setFrameOrigin(NSPoint(x: 60, y: 50))
window.orderFrontRegardless()
// LaunchServices applies background-launch ordering after main starts. Publish
// readiness only after that boundary; never raise the window for each action.
let readyTimer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: false) { _ in
    window.orderFrontRegardless()
    view.publishReady()
}
let stopTimer = Timer.scheduledTimer(withTimeInterval: 0.02, repeats: true) { _ in
    view.refresh()
    if FileManager.default.fileExists(atPath: stop.path) { app.terminate(nil) }
}
let lifetimeTimer = Timer.scheduledTimer(withTimeInterval: 90, repeats: false) { _ in app.terminate(nil) }
app.run()
