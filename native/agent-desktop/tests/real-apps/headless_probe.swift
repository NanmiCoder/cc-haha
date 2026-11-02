import AppKit
import CoreGraphics

func emit(_ value: [String: Any]) throws {
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]))
    FileHandle.standardOutput.write(Data([10]))
}

func eventDelta(_ before: UInt32, _ after: UInt32) -> UInt32 {
    after &- before
}

let args = CommandLine.arguments
if args.count == 2 && args[1] == "--self-test" {
    precondition(eventDelta(12, 12) == 0)
    precondition(eventDelta(12, 15) == 3)
    precondition(eventDelta(UInt32.max - 1, 1) == 3)
    print("PASS: input counters preserve increments and UInt32 rollover")
    exit(0)
}
guard args.count == 3, let target = Int32(args[1]), target > 0,
      let duration = Double(args[2]), duration.isFinite, duration > 0, duration <= 300,
      let application = NSRunningApplication(processIdentifier: target) else {
    fputs("usage: headless_probe RUNNING_PID DURATION_SECONDS (0 < duration <= 300)\n", stderr)
    exit(2)
}

let events: [(String, CGEventType)] = [
    ("keyDown", .keyDown), ("keyUp", .keyUp), ("flagsChanged", .flagsChanged),
    ("leftMouseDown", .leftMouseDown), ("leftMouseUp", .leftMouseUp),
    ("rightMouseDown", .rightMouseDown), ("rightMouseUp", .rightMouseUp),
    ("otherMouseDown", .otherMouseDown), ("otherMouseUp", .otherMouseUp),
    ("mouseMoved", .mouseMoved), ("leftMouseDragged", .leftMouseDragged),
    ("rightMouseDragged", .rightMouseDragged), ("otherMouseDragged", .otherMouseDragged),
    ("scrollWheel", .scrollWheel)
]
func counters() -> [UInt32] {
    events.map { CGEventSource.counterForEventType(.combinedSessionState, eventType: $0.1) }
}

let start = ProcessInfo.processInfo.systemUptime
var activations: [[String: Any]] = []
let center = NSWorkspace.shared.notificationCenter
let observer = center.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { notice in
    guard let activated = notice.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
    activations.append(["pid": activated.processIdentifier, "elapsedMs": (ProcessInfo.processInfo.systemUptime - start) * 1000])
}
let initialForeground = NSWorkspace.shared.frontmostApplication?.processIdentifier
let initialCounters = counters()
let initialPointer = CGEvent(source: nil)?.location
var pointerChanged = false
var pointerSamples = 0
let timer = Timer.scheduledTimer(withTimeInterval: 0.02, repeats: true) { _ in
    if let position = CGEvent(source: nil)?.location, let initialPointer {
        pointerChanged = pointerChanged || position != initialPointer
        pointerSamples += 1
    }
}
try emit(["event": "ready", "targetPid": target, "frontmostPid": initialForeground ?? -1,
          "durationSeconds": duration, "pointerAvailable": initialPointer != nil])
while ProcessInfo.processInfo.systemUptime - start < duration {
    RunLoop.main.run(until: Date().addingTimeInterval(0.05))
}
timer.invalidate()
center.removeObserver(observer)
let finalCounters = counters()
let deltas = Dictionary(uniqueKeysWithValues: events.indices.map {
    (events[$0].0, eventDelta(initialCounters[$0], finalCounters[$0]))
})
try emit(["event": "complete", "targetPid": target, "targetStillRunning": !application.isTerminated,
          "elapsedMs": (ProcessInfo.processInfo.systemUptime - start) * 1000,
          "initialFrontmostPid": initialForeground ?? -1,
          "finalFrontmostPid": NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1,
          "activations": activations, "inputEventDeltas": deltas,
          "pointerChanged": pointerChanged, "pointerSamples": pointerSamples,
          "scope": "Session-wide counters cannot attribute events to the agent; pointer movement is sampled. No key contents are recorded."])
