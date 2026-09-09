import AppKit
import XCTest
@testable import cc_haha_computer_use

@MainActor
final class AXTreePublicationIntegrationTests: XCTestCase {
    private enum FixtureError: Error {
        case timedOut
    }

    private static let fixtureFlag = "CC_HAHA_AX_PUBLICATION_FIXTURE"
    private static let fixtureReadyPath = "CC_HAHA_AX_PUBLICATION_READY"
    private static let fixtureStopPath = "CC_HAHA_AX_PUBLICATION_STOP"
    private static let fixtureTitle = "CC_HAHA_AX_PUBLICATION_TITLE"
    private static let fixtureMismatchedTitle = "CC_HAHA_AX_PUBLICATION_MISMATCHED_TITLE"

    func testPublishedControlBelowDuplicateAncestorClicksImmediatelyAndRejectsOldGeneration() async throws {
        try await verifyPublishedControl(mismatchedWindowTitle: false)
    }

    func testChromeStyleAXTitleCanDifferFromWindowServerTitleWithoutDisablingActions() async throws {
        try await verifyPublishedControl(mismatchedWindowTitle: true)
    }

    private func verifyPublishedControl(mismatchedWindowTitle: Bool) async throws {
        if ProcessInfo.processInfo.environment[Self.fixtureFlag] == "1" {
            try await runFixtureProcess(
                mismatchedWindowTitle: ProcessInfo.processInfo.environment[Self.fixtureMismatchedTitle] == "1"
            )
            // This process is a disposable UI fixture, not another suite run.
            exit(0)
        }
        try XCTSkipUnless(
            AXIsProcessTrusted(),
            "Live AX publication requires Accessibility permission for the test runner"
        )
        if mismatchedWindowTitle {
            try XCTSkipUnless(
                Capture.hasScreenRecordingPermission(),
                "Coordinate publication requires Screen Recording permission for the test runner"
            )
        }

        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("cc-haha-ax-publication-\(UUID().uuidString)")
        let ready = root.appendingPathComponent("ready")
        let stop = root.appendingPathComponent("stop")
        let title = "Computer Use snapshot publication \(UUID().uuidString)"
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        // AXTree requires a proven process lifetime, and querying the test runner's
        // own AX tree cannot exercise a cross-process action. Relaunch this same
        // test as a temporary app bundle so the production AX/WindowServer path
        // supplies every snapshot field instead of a hand-written fixture.
        let fixtureApp = try makeFixtureApp(in: root)
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.arguments = Array(CommandLine.arguments.dropFirst())
        configuration.environment = ProcessInfo.processInfo.environment.merging([
            Self.fixtureFlag: "1",
            Self.fixtureReadyPath: ready.path,
            Self.fixtureStopPath: stop.path,
            Self.fixtureTitle: title,
            Self.fixtureMismatchedTitle: mismatchedWindowTitle ? "1" : "0",
        ]) { _, fixture in fixture }
        configuration.activates = false
        configuration.createsNewApplicationInstance = true
        let process = try await NSWorkspace.shared.openApplication(
            at: fixtureApp,
            configuration: configuration
        )
        defer {
            FileManager.default.createFile(atPath: stop.path, contents: Data())
            if !process.isTerminated { process.terminate() }
        }

        try await waitUntil { FileManager.default.fileExists(atPath: ready.path) }
        let pid = process.processIdentifier
        defer { AXTree.invalidate(pid: pid) }

        let state = try await AXTree.appState(pid: pid, disableDiff: true)
        let windowID = try XCTUnwrap(AXTree.snapshotEvidence(pid: pid)?.keyWindowID)
        XCTAssertEqual(AXTree.currentKeyWindowID(pid: pid), windowID)
        let (handle, line) = try publishedHandle(label: "Bold", state: state)
        XCTAssertEqual(
            AXTree.record(pid: pid, index: handle.index)?.role,
            kAXCheckBoxRole as String
        )
        XCTAssertTrue(line.contains("Value: 0"), line)
        let inputMonitor = PhysicalInputEpochMonitor(counterReader: { _ in 0 })
        _ = inputMonitor.startAndWait()
        defer { inputMonitor.stop() }
        let cursor = VirtualCursor(headless: false)
        defer { cursor.hide() }
        let router = CommandRouter(
            cursor: cursor,
            capabilities: Capabilities(headless: false),
            inputMonitor: inputMonitor
        )
        let click = try await router.handle(
            cmd: "click",
            payload: .object([
                "pid": .int(Int(pid)),
                "index": .string(handle.rawValue),
            ])
        )
        XCTAssertEqual(click, .bool(true))

        let clickedState = try await AXTree.appState(pid: pid, disableDiff: true)
        let (_, clickedLine) = try publishedHandle(label: "Bold", state: clickedState)
        XCTAssertTrue(clickedLine.contains("Value: 1"), clickedLine)

        if mismatchedWindowTitle {
            // Exercise the actual state → screenshot → coordinate action path,
            // using only this disposable fixture window. Previously the image
            // was returned while its coordinate transform was never recorded.
            let captured = try await router.handle(cmd: "get_app_state", payload: .object([
                "pid": .int(Int(pid)), "disableDiff": .bool(true),
            ]))
            let shot = try XCTUnwrap(captured["screenshot"])
            XCTAssertEqual(shot["windowID"]?.asInt, Int(windowID))
            let frame = try XCTUnwrap(AXTree.record(pid: pid, index: handle.index)?.frameGlobal)
            let x = (frame.x + frame.w / 2 - (try XCTUnwrap(shot["originX"]?.asDouble)))
                * Double(try XCTUnwrap(shot["width"]?.asInt))
                / (try XCTUnwrap(shot["pointWidth"]?.asDouble))
            let y = (frame.y + frame.h / 2 - (try XCTUnwrap(shot["originY"]?.asDouble)))
                * Double(try XCTUnwrap(shot["height"]?.asInt))
                / (try XCTUnwrap(shot["pointHeight"]?.asDouble))
            _ = try await router.handle(cmd: "click", payload: .object([
                "pid": .int(Int(pid)), "x": .double(x), "y": .double(y),
            ]))
            let coordinateState = try await AXTree.appState(pid: pid, disableDiff: true)
            let (coordinateHandle, coordinateLine) = try publishedHandle(label: "Bold", state: coordinateState)
            XCTAssertTrue(coordinateLine.contains("Value: 0"), coordinateLine)
            // Restore the checked state for the stale-generation assertion.
            _ = try await router.handle(cmd: "click", payload: .object([
                "pid": .int(Int(pid)), "index": .string(coordinateHandle.rawValue),
            ]))
        }

        AXTree.invalidate(pid: pid)
        let nextState = try await AXTree.appState(pid: pid, disableDiff: true)
        let (nextHandle, _) = try publishedHandle(label: "Bold", state: nextState)
        XCTAssertNotEqual(nextHandle.snapshotID, handle.snapshotID)
        do {
            _ = try await router.handle(
                cmd: "click",
                payload: .object([
                    "pid": .int(Int(pid)),
                    "index": .string(handle.rawValue),
                ])
            )
            XCTFail("the old generation must not reach the action")
        } catch let error as CUError {
            XCTAssertEqual(error.code, "stale_snapshot")
        }
        let unchangedState = try await AXTree.appState(pid: pid, disableDiff: true)
        let (_, unchangedLine) = try publishedHandle(label: "Bold", state: unchangedState)
        XCTAssertTrue(unchangedLine.contains("Value: 1"), unchangedLine)

        FileManager.default.createFile(atPath: stop.path, contents: Data())
        try await waitUntil { process.isTerminated }
    }

    private func runFixtureProcess(mismatchedWindowTitle: Bool) async throws {
        let environment = ProcessInfo.processInfo.environment
        let readyPath = try XCTUnwrap(environment[Self.fixtureReadyPath])
        let stopPath = try XCTUnwrap(environment[Self.fixtureStopPath])
        let title = try XCTUnwrap(environment[Self.fixtureTitle])

        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        app.finishLaunching()
        let window = NSWindow(
            contentRect: NSRect(x: 200, y: 200, width: 420, height: 180),
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
        window.title = title
        if mismatchedWindowTitle {
            // Chrome exposes a decorated AX title while WindowServer uses the
            // page title (and may add an audio indicator). Both refer to the
            // same window. Reproduce that mismatch without a real browser.
            window.setAccessibilityTitle("\(title) - Google Chrome - Fixture")
        }
        // TextEdit exposes formatting and alignment segments as two sibling
        // AXGroups whose own fingerprints are identical. Their description-only
        // children are the first semantic evidence that distinguishes the paths.
        let formattingControls = ["Bold", "Italic", "Underline"].map { label -> NSButton in
            let button = NSButton(checkboxWithTitle: "", target: nil, action: nil)
            button.setAccessibilityLabel(label)
            return button
        }
        let alignmentControls = ["Align Left", "Align Center", "Align Right"].map {
            label -> NSButton in
            let button = NSButton(checkboxWithTitle: "", target: nil, action: nil)
            button.setAccessibilityLabel(label)
            return button
        }
        let formattingGroup = NSStackView(views: formattingControls)
        formattingGroup.frame = NSRect(x: 20, y: 60, width: 180, height: 60)
        formattingGroup.orientation = .horizontal
        formattingGroup.spacing = 12
        formattingGroup.setAccessibilityElement(true)
        formattingGroup.setAccessibilityRole(.group)
        let alignmentGroup = NSStackView(views: alignmentControls)
        alignmentGroup.frame = NSRect(x: 220, y: 60, width: 180, height: 60)
        alignmentGroup.orientation = .horizontal
        alignmentGroup.spacing = 12
        alignmentGroup.setAccessibilityElement(true)
        alignmentGroup.setAccessibilityRole(.group)
        let content = NSView(frame: NSRect(x: 0, y: 0, width: 420, height: 180))
        content.addSubview(formattingGroup)
        content.addSubview(alignmentGroup)
        window.contentView = content
        window.makeKeyAndOrderFront(nil)
        app.activate()
        defer {
            window.orderOut(nil)
            window.close()
        }
        try await Task.sleep(for: .milliseconds(100))

        FileManager.default.createFile(atPath: readyPath, contents: Data())
        while !FileManager.default.fileExists(atPath: stopPath) {
            try await Task.sleep(for: .milliseconds(20))
        }
    }

    private func waitUntil(
        _ predicate: () -> Bool,
        timeout: Duration = .seconds(5)
    ) async throws {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: timeout)
        while clock.now < deadline {
            if predicate() { return }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTFail("Timed out waiting for AX fixture")
        throw FixtureError.timedOut
    }

    private func makeFixtureApp(in root: URL) throws -> URL {
        let app = root.appendingPathComponent("AXPublicationFixture.app", isDirectory: true)
        let contents = app.appendingPathComponent("Contents", isDirectory: true)
        let macOS = contents.appendingPathComponent("MacOS", isDirectory: true)
        try FileManager.default.createDirectory(at: macOS, withIntermediateDirectories: true)

        let executable = macOS.appendingPathComponent("AXPublicationFixture")
        try FileManager.default.copyItem(
            at: URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath(),
            to: executable
        )
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o755],
            ofItemAtPath: executable.path
        )
        let info: [String: Any] = [
            "CFBundleExecutable": "AXPublicationFixture",
            "CFBundleIdentifier": "dev.cchaha.tests.ax-publication-fixture",
            "CFBundleName": "AXPublicationFixture",
            "CFBundlePackageType": "APPL",
            "CFBundleVersion": "1",
        ]
        let plist = try PropertyListSerialization.data(
            fromPropertyList: info,
            format: .xml,
            options: 0
        )
        try plist.write(to: contents.appendingPathComponent("Info.plist"), options: .atomic)
        return app
    }

    private func publishedHandle(
        label: String,
        state: AXTree.Result
    ) throws -> (SnapshotElementHandle, String) {
        let line = try XCTUnwrap(
            state.axText.split(separator: "\n").first {
                $0.contains("Description: \(label)")
            }.map(String.init),
            state.axText
        )
        let rawHandle = try XCTUnwrap(
            line.trimmingCharacters(in: .whitespaces).split(separator: " ").first.map(String.init)
        )
        return (try XCTUnwrap(SnapshotElementHandle(rawValue: rawHandle)), line)
    }
}
