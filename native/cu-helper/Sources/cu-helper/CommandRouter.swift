import AppKit
import CoreGraphics
import Foundation
import os

/// Per-mode capability flags handed to ``CommandRouter`` at construction.
///
/// `headless == true` means we are the per-command CLI process (one-shot):
/// the virtual cursor has no overlay window and no animation, and its logical
/// position is persisted to / read from disk so that `cursor_position` and an
/// implicit-`from` `drag` see a best-effort last-known point across processes.
/// `headless == false` is the long-lived daemon: the virtual cursor is
/// overlay-backed and glides, and its position lives in memory.
public struct Capabilities: Sendable {
    public let headless: Bool
    public init(headless: Bool) {
        self.headless = headless
    }
}

/// Pure process-lifetime guard shared by focus-targeted semantic actions.
/// Keeping it independent from AppKit lookup makes the PID-reuse contract
/// directly testable.
enum SnapshotProcessGuard {
    static func validate(
        pid: pid_t,
        snapshot: AXTreeSnapshotEvidence?,
        current: AXTreeProcessIdentity?,
        expected: AXTreeProcessIdentity?
    ) throws {
        guard let snapshot else {
            throw CUError(
                "stale_snapshot",
                "No snapshot exists for PID \(pid). Call get_app_state before typing or pressing keys."
            )
        }
        guard snapshot.processIdentity.isProven,
              current?.isProven == true,
              current == snapshot.processIdentity else {
            throw CUError(
                "stale_process",
                "The target process changed. Call get_app_state before typing or pressing keys."
            )
        }
        if let expected {
            guard expected.isProven,
                  expected == snapshot.processIdentity else {
                throw CUError(
                    "stale_process",
                    "expectedProcessIdentity does not match the current snapshot. Call get_app_state again."
                )
            }
        }
    }
}

/// THE single dispatcher over every Computer-Use contract command.
///
/// Shared verbatim by the CLI one-shot path (`main.swift`) and the daemon
/// (`Daemon.swift`) so each command has exactly one implementation. Marked
/// `@MainActor` because it drives AppKit overlay state, ScreenCaptureKit
/// capture, posts `CGEvent`s in main-run-loop order, AND because every AX call
/// (AXTree / AXAction) is main-actor-isolated (AX APIs are not thread-safe).
///
/// `handle(cmd:payload:)` returns the `result` value for a successful
/// `{ ok: true, result }` envelope, or throws ``CUError`` which the caller
/// serialises to `{ ok: false, error: { message, code } }`.
@MainActor
public final class CommandRouter {
    typealias PasteExecutor = @MainActor (pid_t, String, ClipboardPasteFormat) async throws -> Void
    private let cursor: VirtualCursor
    private let capabilities: Capabilities
    private let inputMonitor: PhysicalInputEpochMonitor
    private let foregroundRuntime: ForegroundLeaseRuntime
    private let windowCaptureProvider: (any WindowCaptureProviding)?
    private let pasteExecutor: PasteExecutor

    /// After a left `mouse_down` (decomposed drag) the held point is parked
    /// here so a following `mouse_up` releases at the same logical location.
    /// Only meaningful in the daemon; in headless mode each process is born
    /// and dies around a single event so the hold cannot span commands.
    private var leftButtonHeldAt: CGPoint?
    private var leftButtonHeldTarget: ProvenProcessTarget?

    init(
        cursor: VirtualCursor,
        capabilities: Capabilities,
        inputMonitor: PhysicalInputEpochMonitor,
        windowCaptureProvider: (any WindowCaptureProviding)? = nil,
        pasteExecutor: @escaping PasteExecutor = { pid, text, format in
            try await AXAction.pasteText(pid: pid, text, format: format)
        }
    ) {
        self.cursor = cursor
        self.capabilities = capabilities
        self.inputMonitor = inputMonitor
        self.foregroundRuntime = .live(monitor: inputMonitor)
        self.windowCaptureProvider = windowCaptureProvider
        self.pasteExecutor = pasteExecutor
    }

    func resetHeldSessionState() {
        leftButtonHeldAt = nil
        leftButtonHeldTarget = nil
    }

    func resetSessionState() {
        resetHeldSessionState()
        AXTree.resetSessionSnapshots()
        Self.lastShotTransform.removeAll()
        Self.lastCaptureDigest.removeAll()
        MutationClock.reset()
        ClipboardPasteReceipt.resetForTurn()
        // Apps we told they were focused must be told they are not, or the
        // belief outlives the session that needed it.
        SyntheticWindowFocus.relinquishAll()
    }

    func invalidateWindowCaptureStream() {
        windowCaptureProvider?.invalidate()
    }

    /// Dispatch one command. The payload is the raw decoded JSON object the
    /// bridge sent (or `.object([:])` for the empty-payload commands). Returns
    /// the `result` ``JSONValue``; throws ``CUError`` on any failure.
    public func handle(cmd: String, payload: JSONValue) async throws -> JSONValue {
        if Self.explicitTargetCommands.contains(cmd) {
            _ = try AppTargetResolver.requiredSelector(payload: payload)
        }
        switch cmd {

        // ── No-op preparation verbs (v1 hides nothing) ─────────────────────
        case "prepare_for_action", "preview_hide_set":
            // mac_helper returns []. prepare_for_action -> string[] of hidden
            // bundle ids; preview_hide_set -> [{bundleId,displayName}]. v1
            // hides nothing, so an empty array satisfies both.
            return .array([])

        // ── Displays (TCC-free, CoreGraphics only) ─────────────────────────
        case "get_display_size":
            let display = try Displays.get(payload["displayId"]?.asInt)
            return try encode(display)

        case "list_displays":
            return try encode(Displays.list())

        case "find_window_displays":
            let bundleIds = stringArray(payload["bundleIds"])
            return try encode(Displays.findWindowDisplays(bundleIds: bundleIds))

        // ── Capture (needs Screen Recording) ───────────────────────────────
        case "screenshot":
            return try await handleScreenshot(payload)

        case "resolve_prepare_capture":
            return try await handleResolvePrepareCapture(payload)

        case "zoom":
            return try await handleZoom(payload)

        // ── Keyboard (needs Accessibility) ─────────────────────────────────
        case "key":
            guard let seq = payload["keySequence"]?.asString else {
                throw CUError("bad_payload", "key requires a 'keySequence' string")
            }
            let count = payload["repeat"]?.asInt ?? 1
            return try await handleLegacyKey(seq, count: max(1, count))

        case "hold_key":
            let keyNames = stringArray(payload["keyNames"])
            let durationMs = payload["durationMs"]?.asInt ?? 0
            return try await handleLegacyHoldKey(
                keyNames,
                durationMs: max(0, durationMs)
            )

        case "type":
            let text = payload["text"]?.asString ?? ""
            return try await handleLegacyType(text)

        // ── Clipboard ──────────────────────────────────────────────────────
        case "paste_clipboard":
            return try await handleLegacyPasteClipboard()

        case "read_clipboard":
            return .string(Clipboard.read())

        case "write_clipboard":
            let text = payload["text"]?.asString ?? ""
            Clipboard.write(text)
            return .bool(true)

        // ── Mouse (legacy coordinate verbs) + virtual cursor ───────────────
        // NOTE: `click`/`drag`/`scroll` below are the COMPUTER-USE CONTRACT
        // commands (AX-first, target-resolving). The decomposed
        // `mouse_down`/`mouse_up`/`move_mouse` + `cursor_position` remain the
        // low-level overlay-driving verbs used by the self-test / CLI path.
        case "mouse_down":
            guard !capabilities.headless else {
                throw CUError(
                    "daemon_required",
                    "mouse_down requires the persistent helper daemon"
                )
            }
            return try await handleMouseDown()

        case "mouse_up":
            guard !capabilities.headless else {
                throw CUError(
                    "daemon_required",
                    "mouse_up requires the persistent helper daemon"
                )
            }
            return try await handleMouseUp()

        case "cursor_position":
            let p = cursor.position
            return try encode(Point(x: p.x, y: p.y))

        case "move_mouse":
            return try await handleMoveMouse(payload)

        // ── Apps (TCC-free) ────────────────────────────────────────────────
        case "frontmost_app":
            guard let app = Apps.frontmost() else { return .null }
            return try encode(app)

        case "app_under_point":
            guard let x = payload["x"]?.asDouble, let y = payload["y"]?.asDouble else {
                throw CUError("bad_payload", "app_under_point requires numeric 'x' and 'y'")
            }
            guard let app = Apps.underPoint(x: x, y: y) else { return .null }
            return try encode(app)

        case "list_installed_apps":
            return try encode(Apps.listInstalled())

        case "list_apps":
            return try encode(await Apps.listApps())

        case "list_running_apps":
            return try encode(Apps.listRunning())

        case "resolve_app_target":
            return try handleResolveAppTarget(payload)

        case "open_app":
            guard let bundleId = payload["bundleId"]?.asString, !bundleId.isEmpty else {
                throw CUError("bad_payload", "open_app requires a 'bundleId' string")
            }
            try await Apps.open(bundleId: bundleId)
            return .bool(true)

        // ── Computer-Use contract: AX-tree perception ──────────────────────
        case "get_app_state":
            return try await handleGetAppState(payload)

        // ── Computer-Use contract: AX-first actuation by index/coordinate ──
        case "click":
            return try await handleClick(payload)

        case "set_value":
            return try await handleSetValue(payload)

        case "select_text":
            return try await handleSelectText(payload)

        case "perform_secondary_action":
            return try await handlePerformSecondaryAction(payload)

        case "scroll":
            return try await handleScroll(payload)

        case "type_text":
            return try await handleTypeText(payload)

        case "paste":
            return try await handlePaste(payload)

        case "press_key":
            return try await handlePressKey(payload)

        case "drag":
            return try await handleDrag(payload)

        // ── Permissions (onboarding / self-test; both modes) ───────────────
        case "check_permissions":
            return Permissions.snapshot()

        // Internal smoke/diagnostic command. Not advertised through MCP.
        case "input_monitor_state":
            let snapshot = inputMonitor.snapshot
            return .object([
                "epoch": .string(String(snapshot.epoch)),
                "available": .bool(snapshot.available),
                "continuityGeneration": .string(
                    String(snapshot.continuityGeneration)
                ),
            ])

        // No key contents are collected: this exposes the focus protocol and
        // continuity evidence needed to distinguish a dispatched input from
        // an application that can actually receive it.
        case "focus_monitor_state":
            let monitor = FocusEventMonitor.shared
            let diagnostic = monitor.diagnostic
            var fields: [String: JSONValue] = [
                "available": .bool(diagnostic.available),
                "reason": .string(diagnostic.reason),
                "continuityGeneration": .string(String(diagnostic.continuityGeneration)),
                "frontmostPID": .int(Int(NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0)),
                "targets": .array(SyntheticWindowFocus.beliefs.sorted { $0.key < $1.key }.map { pid, belief in
                    .object([
                        "pid": .int(Int(pid)),
                        "observedActive": .bool(belief.applicationIsActive),
                        "believesActive": .bool(belief.applicationBelievesItIsActive),
                        "believesFocused": .bool(belief.applicationBelievesItHasFocus),
                        "generation": .string(String(belief.generation)),
                    ])
                }),
            ]
            if let event = diagnostic.lastEvent {
                fields["lastEvent"] = .object([
                    "type": .int(Int(event.type)),
                    "subtype": .string(String(event.subtype)),
                    "sourcePID": .int(Int(event.sourcePID)),
                    "targetPID": .int(Int(event.targetPID)),
                    "focusPID": .int(Int(event.focusPID)),
                    "focusToken": .string(String(event.focusToken)),
                ])
            }
            if let prepared = SyntheticWindowFocus.lastPreparedWindow {
                fields["lastPreparation"] = .object([
                    "pid": .int(Int(prepared.pid)),
                    "windowID": .int(Int(prepared.window?.id ?? 0)),
                    "activationPointAvailable": .bool(prepared.window.map { $0.activationPoint != nil } ?? false),
                    "activationPoint": prepared.window?.resolvedActivationPoint.map {
                        .object(["x": .double($0.x), "y": .double($0.y)])
                    } ?? .null,
                ])
            }
            if let capture = windowCaptureProvider as? WindowCaptureStreamManager {
                let stream = capture.diagnostic()
                var streamFields: [String: JSONValue] = ["generation": .string(String(stream.generation))]
                streamFields["pid"] = stream.activeKey.map { JSONValue.int(Int($0.pid)) } ?? .null
                streamFields["windowID"] = stream.activeKey.map { JSONValue.int(Int($0.windowID)) } ?? .null
                streamFields["hasFailed"] = stream.hasFailed.map(JSONValue.bool) ?? .null
                streamFields["latestFrameSequence"] = stream.latestFrameSequence.map { JSONValue.string(String($0)) } ?? .null
                streamFields["latestFrameAgeSeconds"] = stream.latestFrameAgeSeconds.map(JSONValue.double) ?? .null
                streamFields["sampleCount"] = stream.sampleCount.map { JSONValue.string(String($0)) } ?? .null
                streamFields["latestSampleStatus"] = stream.latestSampleStatus.map { JSONValue.int(Int($0)) } ?? .null
                streamFields["latestSampleAgeSeconds"] = stream.latestSampleAgeSeconds.map(JSONValue.double) ?? .null
                fields["windowStream"] = .object(streamFields)
            }
            if let paste = ClipboardPasteReceipt.lastDiagnostic {
                fields["lastPaste"] = .object([
                    "status": .string(paste.status),
                    "pastePosted": .bool(paste.pastePosted),
                    "dataRequested": .bool(paste.dataRequested),
                    "dataSupplied": .bool(paste.dataSupplied),
                    "providerFinished": .bool(paste.providerFinished),
                    "readElapsedMilliseconds": paste.readElapsedMilliseconds.map(JSONValue.double) ?? .null,
                    "elapsedMilliseconds": .double(paste.elapsedMilliseconds),
                    "ownedBeforeRestore": .bool(paste.ownedBeforeRestore),
                    "restored": .bool(paste.restored),
                ])
            }
            return .object(fields)

        // Internal smoke/diagnostic command. Not advertised through MCP.
        // Answers "did the last click actually get bound to a window?" — the
        // window-bound path degrades silently to the old broken behaviour, so
        // without this a failing run cannot say where it diverged.
        case "last_injection_state":
            let d = WindowTargetedEvent.lastDiagnostic
            return .object([
                "windowTargeted": .bool(d.windowTargeted),
                "stampedWindowLocation": .bool(d.stampedWindowLocation),
                "nsEventCreated": .bool(d.nsEventCreated),
                "windowID": .int(Int(d.windowID)),
                "globalX": .double(d.globalPoint.x),
                "globalY": .double(d.globalPoint.y),
                "localX": .double(d.windowLocalPoint.x),
                "localY": .double(d.windowLocalPoint.y),
                "reason": .string(d.reason),
                "windowLocationSPI": .bool(WindowTargetedEvent.canStampWindowLocation),
                "focusSPI": .bool(WindowKeyFocus.isAvailable),
            ])

        // Internal smoke/diagnostic command. Not advertised through MCP.
        case "held_input_state":
            return Injection.heldInputState()

        default:
            throw CUError("bad_command", "Unknown command: \(cmd)")
        }
    }

    /// Every semantic command that can observe or mutate an application's UI
    /// is target-explicit. `list_apps` is the sole target-free public command.
    private static let explicitTargetCommands: Set<String> = [
        "resolve_app_target",
        "get_app_state",
        "click",
        "set_value",
        "select_text",
        "perform_secondary_action",
        "scroll",
        "type_text",
        "press_key",
        "drag",
    ]

    // MARK: - Capture handlers

    private func handleScreenshot(_ payload: JSONValue) async throws -> JSONValue {
        guard #available(macOS 14.0, *) else {
            throw CUError("capture_failed", "ScreenCaptureKit requires macOS 14 or newer")
        }
        let result = try await Capture.screenshot(
            displayId: payload["displayId"]?.asInt,
            targetWidth: payload["targetWidth"]?.asInt,
            targetHeight: payload["targetHeight"]?.asInt,
            jpegQuality: payload["jpegQuality"]?.asDouble ?? 0.75
        )
        return try encode(result)
    }

    private func handleResolvePrepareCapture(_ payload: JSONValue) async throws -> JSONValue {
        guard #available(macOS 14.0, *) else {
            throw CUError("capture_failed", "ScreenCaptureKit requires macOS 14 or newer")
        }
        let result = try await Capture.resolvePrepareCapture(
            preferredDisplayId: payload["preferredDisplayId"]?.asInt,
            targetWidth: payload["targetWidth"]?.asInt,
            targetHeight: payload["targetHeight"]?.asInt,
            jpegQuality: payload["jpegQuality"]?.asDouble ?? 0.75
        )
        return try encode(result)
    }

    private func handleZoom(_ payload: JSONValue) async throws -> JSONValue {
        guard #available(macOS 14.0, *) else {
            throw CUError("capture_failed", "ScreenCaptureKit requires macOS 14 or newer")
        }
        guard
            let x = payload["x"]?.asDouble,
            let y = payload["y"]?.asDouble,
            let width = payload["width"]?.asDouble,
            let height = payload["height"]?.asDouble
        else {
            throw CUError("bad_payload", "zoom requires numeric 'x', 'y', 'width', 'height'")
        }
        let result = try await Capture.zoom(
            x: x, y: y, width: width, height: height,
            targetWidth: payload["targetWidth"]?.asInt,
            targetHeight: payload["targetHeight"]?.asInt,
            jpegQuality: payload["jpegQuality"]?.asDouble ?? 0.75
        )
        return try encode(result)
    }

    // MARK: - Legacy mutations (exact target + foreground lease)

    private func handleLegacyKey(
        _ sequence: String,
        count: Int
    ) async throws -> JSONValue {
        let target = try Injection.resolveKeyboardTarget()
        setResolvedTarget(target)
        return try await withForegroundLease(command: "key", target: target) {
            try await Injection.key(
                sequence,
                repeat: count,
                target: target
            )
            return .bool(true)
        }
    }

    private func handleLegacyHoldKey(
        _ keyNames: [String],
        durationMs: Int
    ) async throws -> JSONValue {
        let target = try Injection.resolveKeyboardTarget()
        setResolvedTarget(target)
        return try await withForegroundLease(
            command: "hold_key",
            target: target
        ) {
            try await Injection.holdKey(
                keyNames,
                durationMs: durationMs,
                target: target
            )
            return .bool(true)
        }
    }

    private func handleLegacyType(_ text: String) async throws -> JSONValue {
        let target = try Injection.resolveKeyboardTarget()
        setResolvedTarget(target)
        return try await withForegroundLease(command: "type", target: target) {
            try await Injection.type(text, target: target)
            return .bool(true)
        }
    }

    private func handleLegacyPasteClipboard() async throws -> JSONValue {
        let target = try Injection.resolveKeyboardTarget()
        setResolvedTarget(target)
        return try await withForegroundLease(
            command: "paste_clipboard",
            target: target
        ) {
            try await Clipboard.paste(target: target)
            return .bool(true)
        }
    }

    // MARK: Low-level mouse handlers (overlay-driving; self-test path)

    private func handleMouseDown() async throws -> JSONValue {
        let p = cursor.position
        let target = try Injection.resolveExactCoordinateTarget(atLogical: p)
        setResolvedTarget(target)
        return try await withForegroundLease(
            command: "mouse_down",
            target: target
        ) { [self] in
            cursor.showClick(at: p, kind: .press)
            try await Injection.mouseDown(.left, at: p, target: target)
            leftButtonHeldAt = p
            leftButtonHeldTarget = target
            return .bool(true)
        }
    }

    private func handleMouseUp() async throws -> JSONValue {
        // Release where the button is being held if we know it (daemon),
        // otherwise at the cursor's current logical position.
        let p = leftButtonHeldAt ?? cursor.position
        let target = try Injection.validateAuthorizedTarget(
            leftButtonHeldTarget
                ?? Injection.heldButtonTarget(.left)
                ?? Injection.resolveExactCoordinateTarget(atLogical: p)
        )
        setResolvedTarget(target)
        return try await withForegroundLease(
            command: "mouse_up",
            target: target
        ) { [self] in
            cursor.showClick(at: p, kind: .release)
            try await Injection.mouseUp(.left, at: p, target: target)
            leftButtonHeldAt = nil
            leftButtonHeldTarget = nil
            return .bool(true)
        }
    }

    private func handleMoveMouse(_ payload: JSONValue) async throws -> JSONValue {
        guard let x = payload["x"]?.asDouble, let y = payload["y"]?.asDouble else {
            throw CUError("bad_payload", "move_mouse requires numeric 'x' and 'y'")
        }
        // Animate the VIRTUAL cursor only. The real cursor must not move.
        await cursor.move(to: CGPoint(x: x, y: y), animated: !capabilities.headless)
        return .bool(true)
    }

    // MARK: - get_app_state (AX tree + window screenshot)

    /// Resolve an explicit selector without launching or activating it. This is
    /// the native permission-preflight seam used before a public tool decides
    /// whether the user has authorized the real bundle identity.
    private func handleResolveAppTarget(_ payload: JSONValue) throws -> JSONValue {
        let selector = try AppTargetResolver.requiredSelector(payload: payload)
        let outcome: UnlaunchedAppTarget
        if let running = try AppTargetResolver.resolveRunning(
            selector: selector
        ) {
            outcome = .running(running)
        } else {
            outcome = try AppTargetResolver.resolveWithoutLaunching(
                selector: selector,
                runningCandidates: [],
                installedCandidates: Apps.installedTargets(for: selector)
            )
        }

        switch outcome {
        case .running(let resolved):
            let target = try authorizeResolvedTarget(resolved)
            guard let app = NSRunningApplication(processIdentifier: target.pid),
                  let bundleID = target.identity.bundleID,
                  let executablePath = target.identity.executablePath,
                  let launchTime = target.identity.launchTime,
                  let bundlePath = (
                    app.bundleURL?.standardizedFileURL.path
                        ?? resolved.bundleURL?.standardizedFileURL.path
                  ) else {
                throw CUError(
                    "stale_process",
                    "The resolved application changed before its identity could be returned."
                )
            }
            let object: [String: JSONValue] = [
                "pid": .int(Int(target.pid)),
                "bundleId": .string(bundleID),
                "displayName": .string(app.localizedName ?? bundleID),
                "executablePath": .string(executablePath),
                "launchTime": .double(launchTime),
                "path": .string(bundlePath),
                "processIdentity": processIdentityJSON(
                    target.identity,
                    pid: target.pid
                ),
            ]
            return .object(object)

        case .installed(let installed):
            return .object([
                "bundleId": .string(installed.bundleIdentifier),
                "displayName": .string(installed.displayName),
                "path": .string(installed.bundleURL.standardizedFileURL.path),
            ])
        }
    }

    /// Hash of the last capture per app, to notice when a new one is the same
    /// image. Hashes rather than the images themselves — these are megabytes.
    private static var lastCaptureDigest: [pid_t: Int] = [:]

    /// The notice for a repeated capture, and nil for a fresh one.
    private static func identicalCaptureNotice(
        pid: pid_t,
        base64: String,
        windowID: CGWindowID,
        liveStreamActive: Bool
    ) -> String? {
        let digest = base64.hashValue
        defer { lastCaptureDigest[pid] = digest }
        guard let previous = lastCaptureDigest[pid], previous == digest else { return nil }
        return TargetVisibilityPolicy.identicalCaptureNotice(
            windowIsCovered: WindowGeometry.isFullyCovered(windowID: windowID),
            liveStreamActive: liveStreamActive
        )
    }

    private static func appendAXNotice(
        _ notice: String,
        to object: inout [String: JSONValue]
    ) {
        let existing = object["axText"]?.asString ?? ""
        object["axText"] = .string(existing + "\n\n" + notice)
    }

    private func handleGetAppState(
        _ payload: JSONValue,
        windowChangeRetriesRemaining: Int = 1,
        forceFullSnapshot: Bool = false
    ) async throws -> JSONValue {
        let requestedDisableDiff = try optionalBoolean(payload, key: "disableDiff") ?? false
        let disableDiff = Self.effectiveDisableDiff(
            requested: requestedDisableDiff,
            forceFullSnapshot: forceFullSnapshot
        )
        let selector = try AppTargetResolver.requiredSelector(payload: payload)
        try requireAXTrusted()
        // Resolve a RUNNING match first; if an app was named but isn't running,
        // LAUNCH it (Codex parity) rather than silently falling back to the
        // frontmost app — which is the host (Claude Code Haha) and was the cause of
        // "get_app_state read / the glow framed our own window, and the model had to
        // shell out to `open -a`". Missing targets fail before TCC or launch.
        let resolved: ResolvedAppTarget
        if let running = try resolveRunningTarget(selector) {
            resolved = running
        } else {
            let installedOutcome = try AppTargetResolver.resolveWithoutLaunching(
                selector: selector,
                runningCandidates: [],
                installedCandidates: Apps.installedTargets(for: selector)
            )
            guard case .installed(let installed) = installedOutcome else {
                throw CUError("target_not_running", "The requested target app is not running")
            }
            let identifier = installed.bundleURL.standardizedFileURL.path
            guard let launched = await AppTargetResolver.launch(
                identifier: identifier,
                activate: false
            ) else {
                throw CUError("no_target", "get_app_state: couldn't find or launch '\(identifier)' — pass an app name, bundle id, or .app path")
            }
            resolved = launched
        }
        let target = try authorizeResolvedTarget(resolved)
        try Self.validateExpectedProcessTarget(
            target,
            expected: Self.expectedProcessTarget(payload)
        )
        let pid = target.pid
        // Re-aim the capture glow at the app we're reading (the get_app_state
        // target), not whatever happens to be frontmost.
        setResolvedTarget(target)

        // A hidden, minimized, or other-Space window has no on-screen geometry
        // that later input can bind to. Recover only this explicit, authorized
        // target; ordinary background windows remain background-readable.
        _ = try await TargetWindowRecovery.recoverIfNeeded(target: target)

        let result = try await AXTree.appState(pid: pid, disableDiff: disableDiff)
        var object = try encode(result).asObject ?? [:]
        guard let snapshotEvidence = AXTree.snapshotEvidence(pid: pid) else {
            throw CUError("stale_snapshot", "get_app_state did not publish target identity")
        }
        object["processIdentity"] = processIdentityJSON(
            snapshotEvidence.processIdentity,
            pid: pid
        )
        if let windowID = snapshotEvidence.keyWindowID {
            object["windowID"] = .int(Int(windowID))
        }

        // A failed or mismatched fresh capture must not leave coordinates from
        // an older state actionable.
        Self.invalidateShotTransform(pid: pid)

        if #available(macOS 14.0, *) {
            // Let the UI finish whatever the last action started before we
            // photograph it, otherwise the model reasons about a half-drawn
            // frame. Costs nothing when no action is pending, applies only to
            // this target PID, and is consumed by this single capture.
            let pendingMutation = MutationClock.takeMutation(pid: pid)
            let streamedShot = await Self.captureSettledWindowShot(
                appIsBusy: result.axText.contains("progress indicator"),
                lastMutationAt: pendingMutation
            ) {
                await windowCaptureProvider?.windowShot(
                    pid: pid,
                    processIdentity: snapshotEvidence.processIdentity,
                    preferredWindowID: snapshotEvidence.keyWindowID,
                    scale: nil,
                    newerThanUptime: pendingMutation
                )
            }
            guard TargetVisibilityPolicy.captureTargetStillMatches(
                snapshotWindowID: snapshotEvidence.keyWindowID,
                currentWindowID: AXTree.currentKeyWindowID(pid: pid)
            ) else {
                windowCaptureProvider?.invalidate()
                guard windowChangeRetriesRemaining > 0 else {
                    throw CUError(
                        "stale_snapshot",
                        "The target key window changed while get_app_state was capturing it"
                    )
                }
                return try await handleGetAppState(
                    payload,
                    windowChangeRetriesRemaining: windowChangeRetriesRemaining - 1,
                    forceFullSnapshot: true
                )
            }

            var windowIsCovered = snapshotEvidence.keyWindowID.map {
                WindowGeometry.isFullyCovered(windowID: $0)
            } ?? false
            var shot: WindowShot?
            if let streamedShot {
                shot = streamedShot
            } else if TargetVisibilityPolicy.permitsOneShotFallback(
                windowIsCovered: windowIsCovered,
                streamProviderInstalled: windowCaptureProvider != nil
            ) {
                shot = await Capture.windowShot(
                    pid: pid,
                    preferredWindowID: snapshotEvidence.keyWindowID,
                    scale: nil
                )
            } else {
                // A one-shot capture can repeat compositor-cached pixels for a
                // covered Chromium/CEF window. Returning no image is safer than
                // presenting that stale fallback as post-action evidence; AX
                // state remains available and the live stream stays installed
                // for the next read.
                shot = nil
            }

            // A fallback capture can itself wait for SCK/CLI. Revalidate both
            // identity and coverage after that await so a newly opened sheet or
            // newly covering foreground window cannot turn a safe decision into
            // a stale screenshot attachment.
            guard TargetVisibilityPolicy.captureTargetStillMatches(
                snapshotWindowID: snapshotEvidence.keyWindowID,
                currentWindowID: AXTree.currentKeyWindowID(pid: pid)
            ) else {
                windowCaptureProvider?.invalidate()
                guard windowChangeRetriesRemaining > 0 else {
                    throw CUError(
                        "stale_snapshot",
                        "The target key window changed while get_app_state was capturing it"
                    )
                }
                return try await handleGetAppState(
                    payload,
                    windowChangeRetriesRemaining: windowChangeRetriesRemaining - 1,
                    forceFullSnapshot: true
                )
            }
            windowIsCovered = snapshotEvidence.keyWindowID.map {
                WindowGeometry.isFullyCovered(windowID: $0)
            } ?? false
            if windowIsCovered,
               windowCaptureProvider != nil,
               shot?.source.isLiveStream != true {
                shot = nil
            }

            if windowIsCovered {
                Self.appendAXNotice(
                    TargetVisibilityPolicy.coveredCaptureNotice(
                        liveStreamActive: shot?.source.isLiveStream == true
                    ),
                    to: &object
                )
            }

            // Keep stream/frame validation in its native capture dimensions.
            // Publish and map coordinates using the same final model image.
            if let shot = shot.flatMap(Capture.boundedModelWindowShot),
               AXTree.currentProcessIdentity(pid: pid) == snapshotEvidence.processIdentity {
                // An identical capture is the other half of the same problem:
                // the pixels cannot say whether the action missed or the window
                // is not painting, and the model reading them cannot tell
                // either. Said even when the window is visible, because a
                // stalled renderer is not the only way to get here.
                if let notice = Self.identicalCaptureNotice(
                    pid: pid,
                    base64: shot.base64,
                    windowID: shot.windowID,
                    liveStreamActive: shot.source.isLiveStream
                ) {
                    Self.appendAXNotice(notice, to: &object)
                }
                // Lossless bytes above establish identical-frame evidence;
                // presentation encoding does not rescale or change geometry.
                let modelImage = Capture.modelWindowImage(shot)
                var screenshot: [String: JSONValue] = [
                    "base64": .string(modelImage.base64),
                    "mimeType": .string(modelImage.mimeType),
                    "width": .int(shot.width),
                    "height": .int(shot.height),
                    "originX": .double(shot.originX),
                    "originY": .double(shot.originY),
                    "pointWidth": .double(shot.pointWidth),
                    "pointHeight": .double(shot.pointHeight),
                    "windowID": .int(Int(shot.windowID)),
                    "captureSource": .string(shot.source.rawValue),
                ]
                if let pixelsPerPoint = shot.pixelsPerPoint {
                    screenshot["pixelsPerPoint"] = .double(pixelsPerPoint)
                }
                object["screenshot"] = .object(screenshot)
                // Cache the inverse transform so a later coordinate click/scroll/
                // drag (which arrives in image-pixel space) can be mapped back to
                // global points. `ppp` = image pixels per window point.
                if snapshotEvidence.keyWindowID == shot.windowID {
                    Self.recordShotTransform(
                        pid: pid,
                        originX: shot.originX,
                        originY: shot.originY,
                        pointWidth: shot.pointWidth,
                        pointHeight: shot.pointHeight,
                        imageWidth: shot.width,
                        imageHeight: shot.height,
                        processIdentity: snapshotEvidence.processIdentity,
                        windowID: shot.windowID,
                        pixelsPerPoint: shot.pixelsPerPoint
                    )
                }
            }
        }

        return .object(object)
    }

    /// Keep the wait and the actual capture in one production boundary so an
    /// action-to-screenshot regression can exercise both without live AX/TCC.
    static func captureSettledWindowShot(
        appIsBusy: Bool,
        lastMutationAt: TimeInterval?,
        capture: () async -> WindowShot?
    ) async -> WindowShot? {
        await MutationClock.awaitSettle(
            lastMutationAt: lastMutationAt,
            appIsBusy: appIsBusy
        )
        return await capture()
    }

    /// A snapshot discarded by an internal key-window retry was never delivered
    /// to the model, so it cannot become the baseline for a returned diff.
    static func effectiveDisableDiff(
        requested: Bool,
        forceFullSnapshot: Bool
    ) -> Bool {
        requested || forceFullSnapshot
    }

    /// The inverse of `windowShot`'s image-pixel space: a window's global Quartz
    /// top-left origin (points) plus image-pixels-per-window-point. Used to map a
    /// model-supplied image-pixel coordinate back to the global-point space that
    /// clicks / virtual cursor / glow all share.
    struct ShotTransform {
        let originX: Double
        let originY: Double
        let pixelsPerPointX: Double
        let pixelsPerPointY: Double
        let imageWidth: Int
        let imageHeight: Int
        let processIdentity: AXTreeProcessIdentity
        let windowID: CGWindowID
    }

    /// Most recent per-pid inverse transform from the last get_app_state shot.
    private static var lastShotTransform: [pid_t: ShotTransform] = [:]

    /// Cache a screenshot transform only when it is bound to a proven process
    /// lifetime and concrete Window Server identity.
    static func recordShotTransform(
        pid: pid_t,
        originX: Double,
        originY: Double,
        pointWidth: Double,
        pointHeight: Double,
        imageWidth: Int,
        imageHeight: Int,
        processIdentity: AXTreeProcessIdentity,
        windowID: CGWindowID,
        pixelsPerPoint: Double? = nil
    ) {
        guard pid > 0,
              processIdentity.isProven,
              windowID != kCGNullWindowID,
              originX.isFinite,
              originY.isFinite,
              pointWidth.isFinite,
              pointHeight.isFinite,
              pointWidth > 0,
              pointHeight > 0,
              pixelsPerPoint.map({ $0.isFinite && $0 > 0 }) ?? true,
              imageWidth > 0,
              imageHeight > 0 else {
            lastShotTransform.removeValue(forKey: pid)
            return
        }
        let transform = ShotTransform(
            originX: originX,
            originY: originY,
            pixelsPerPointX: pixelsPerPoint ?? Double(imageWidth) / pointWidth,
            pixelsPerPointY: pixelsPerPoint ?? Double(imageHeight) / pointHeight,
            imageWidth: imageWidth,
            imageHeight: imageHeight,
            processIdentity: processIdentity,
            windowID: windowID
        )
        lastShotTransform[pid] = transform
    }

    static func invalidateShotTransform(pid: pid_t) {
        lastShotTransform.removeValue(forKey: pid)
    }

    static func clearShotTransformsForTesting() {
        lastShotTransform.removeAll()
    }

    /// Convert screenshot pixels to global points only when the exact target
    /// process and AX key window still match the captured snapshot.
    static func toGlobalPoint(
        x: Double,
        y: Double,
        pid: pid_t,
        currentProcessIdentity: AXTreeProcessIdentity?,
        currentWindowID: CGWindowID?
    ) throws -> CGPoint {
        guard x.isFinite, y.isFinite else {
            throw CUError("bad_payload", "Coordinates must be finite numbers")
        }
        guard let transform = lastShotTransform[pid] else {
            throw CUError(
                "stale_snapshot",
                "No screenshot snapshot exists for this target. Call get_app_state before using coordinates."
            )
        }
        guard transform.processIdentity.isProven,
              currentProcessIdentity?.isProven == true,
              currentProcessIdentity == transform.processIdentity else {
            lastShotTransform.removeValue(forKey: pid)
            throw CUError(
                "stale_process",
                "The target process changed. Call get_app_state before using coordinates."
            )
        }
        guard let currentWindowID,
              currentWindowID == transform.windowID else {
            lastShotTransform.removeValue(forKey: pid)
            throw CUError(
                "target_window_changed",
                "The target window changed. Call get_app_state before using coordinates."
            )
        }
        guard transform.pixelsPerPointX.isFinite,
              transform.pixelsPerPointY.isFinite,
              transform.pixelsPerPointX > 0,
              transform.pixelsPerPointY > 0 else {
            lastShotTransform.removeValue(forKey: pid)
            throw CUError("stale_snapshot", "The screenshot transform is invalid")
        }
        guard x >= 0,
              y >= 0,
              x < Double(transform.imageWidth),
              y < Double(transform.imageHeight) else {
            throw CUError(
                "bad_payload",
                "Coordinates (\(x), \(y)) are outside the latest get_app_state screenshot bounds " +
                    "(width \(transform.imageWidth), height \(transform.imageHeight))."
            )
        }
        return CGPoint(
            x: transform.originX + x / transform.pixelsPerPointX,
            y: transform.originY + y / transform.pixelsPerPointY
        )
    }

    private static func validatedGlobalPoint(
        x: Double,
        y: Double,
        pid: pid_t
    ) throws -> CGPoint {
        try toGlobalPoint(
            x: x,
            y: y,
            pid: pid,
            currentProcessIdentity: AXTree.currentProcessIdentity(pid: pid),
            currentWindowID: AXTree.currentKeyWindowID(pid: pid)
        )
    }

    struct ExpectedProcessTarget: Equatable {
        let pid: pid_t?
        let identity: AXTreeProcessIdentity
    }

    static func expectedProcessTarget(
        _ payload: JSONValue
    ) throws -> ExpectedProcessTarget? {
        guard let raw = payload["expectedProcessIdentity"] else { return nil }
        guard case .object = raw,
              let bundleID = raw["bundleId"]?.asString,
              !bundleID.isEmpty,
              let executablePath = raw["executablePath"]?.asString,
              executablePath.hasPrefix("/"),
              let launchValue = raw["launchTime"] else {
            throw CUError(
                "bad_payload",
                "expectedProcessIdentity requires bundleId, absolute executablePath, and finite launchTime"
            )
        }
        let launchTime: Double
        switch launchValue {
        case .int(let value):
            launchTime = Double(value)
        case .double(let value):
            launchTime = value
        default:
            throw CUError(
                "bad_payload",
                "expectedProcessIdentity.launchTime must be a finite number"
            )
        }
        guard launchTime.isFinite else {
            throw CUError(
                "bad_payload",
                "expectedProcessIdentity.launchTime must be a finite number"
            )
        }
        let expectedPID: pid_t?
        if let rawPID = raw["pid"] {
            guard case .int(let value) = rawPID,
                  value > 0,
                  let pid = pid_t(exactly: value) else {
                throw CUError(
                    "bad_payload",
                    "expectedProcessIdentity.pid must be a positive 32-bit integer"
                )
            }
            expectedPID = pid
        } else {
            expectedPID = nil
        }
        return ExpectedProcessTarget(
            pid: expectedPID,
            identity: AXTreeProcessIdentity(
                bundleID: bundleID,
                executablePath: executablePath,
                launchTime: launchTime
            )
        )
    }

    private func requireSnapshotProcess(
        target: ProvenProcessTarget,
        expected: ExpectedProcessTarget?
    ) throws {
        if let expectedPID = expected?.pid, expectedPID != target.pid {
            throw CUError(
                "stale_process",
                "The target PID does not match expectedProcessIdentity. Call get_app_state again."
            )
        }
        try SnapshotProcessGuard.validate(
            pid: target.pid,
            snapshot: AXTree.snapshotEvidence(pid: target.pid),
            current: AXTree.currentProcessIdentity(pid: target.pid),
            expected: expected?.identity
        )
    }

    private static func validateExpectedProcessTarget(
        _ target: ProvenProcessTarget,
        expected: ExpectedProcessTarget?
    ) throws {
        guard let expected else { return }
        guard (expected.pid == nil || expected.pid == target.pid),
              expected.identity.isProven,
              expected.identity == target.identity else {
            throw CUError(
                "stale_process",
                "expectedProcessIdentity does not match the resolved process. Call get_app_state again."
            )
        }
    }

    private func processIdentityJSON(
        _ identity: AXTreeProcessIdentity,
        pid: pid_t
    ) -> JSONValue {
        .object([
            "pid": .int(Int(pid)),
            "bundleId": identity.bundleID.map(JSONValue.string) ?? .null,
            "executablePath": identity.executablePath.map(JSONValue.string) ?? .null,
            "launchTime": identity.launchTime.map(JSONValue.double) ?? .null,
        ])
    }

    // MARK: - AX-first actuation (click / set_value / perform / scroll / type / key)

    /// `click`: act on a generation-bound handle copied from get_app_state, or
    /// on a coordinate in the latest get_app_state screenshot via `x`/`y`. `click_count`
    /// and `mouse_button` are optional. Coordinate clicks skip the snapshot
    /// guards (no element required); handle clicks validate snapshot generation,
    /// range, process liveness, and current semantic topology.
    private func handleClick(_ payload: JSONValue) async throws -> JSONValue {
        try requireAXTrusted()
        let button = try Self.parseMouseButton(payload)
        let clickCount = try Self.parseClickCount(payload)
        let handle = try elementHandle(payload)

        // Coordinate click: no snapshot needed, but the model's x/y are in the
        // get_app_state screenshot's image-pixel space — convert to global points
        // BEFORE clicking (and before moving the cursor) so hit-testing, the glow
        // retarget, and the visible cursor all land on the right window.
        if handle == nil,
           let x = Self.strictNumber(payload["x"]),
           let y = Self.strictNumber(payload["y"]) {
            let target = try resolveTarget(payload)
            _ = try Self.validatedGlobalPoint(x: x, y: y, pid: target.pid)
            setResolvedTarget(target)
            // Lease acquisition is intentionally before visible cursor motion.
            return try await withForegroundLease(
                command: "click",
                target: target
            ) { [self] in
                let g = try Self.validatedGlobalPoint(
                    x: x,
                    y: y,
                    pid: target.pid
                )
                // Official coordinate click/drag dispatch does not await a
                // cursor animation. Start feedback without delaying input.
                await cursor.moveForAction(
                    to: g, targetPid: target.pid, waitForVisualFeedback: false
                )
                _ = try Self.validatedGlobalPoint(
                    x: x,
                    y: y,
                    pid: target.pid
                )
                _ = try Injection.validateAuthorizedTarget(target)
                // Coordinate clicks PREFER AX (hit-test the element under the point and
                // press it) so Chromium/CEF apps — whose tree we can't traverse — still
                // click; the synthetic postToPid click is the fallback.
                let tag = try await AXAction.clickAtPoint(
                    pid: target.pid,
                    x: g.x,
                    y: g.y,
                    clickCount: clickCount,
                    button: button
                )
                // %{public}s on purpose: the default redacts interpolated
                // strings to <private>, which made the one record of WHICH path
                // a click took unreadable. Diagnosing a dead click then needed
                // an inference from what did NOT happen instead of a log line.
                os_log(
                    "[cu-helper] click point=(%{public}d,%{public}d) pid=%{public}d -> %{public}s",
                    Int(g.x), Int(g.y), target.pid, tag
                )
                cursor.showClick(
                    at: g,
                    kind: clickKind(button: button, clickCount: clickCount)
                )
                return .bool(true)
            }
        }

        // Index click (Codex first-class path): resolve target + guard staleness.
        guard let handle else {
            throw CUError("bad_payload", "click requires an opaque snapshot handle copied from get_app_state, or numeric 'x'/'y'")
        }
        let index = handle.index
        let target = try resolveTarget(payload)
        setResolvedTarget(target)
        try guardStaleness(pid: target.pid, handle: handle)
        // Cursor movement is itself visible, so validate the current semantic
        // locator before moving it. AXAction refetches once more immediately before
        // mutating the target, closing the gap introduced by the animation.
        _ = try AXTree.refetch(pid: target.pid, index: index)
        // Glide the virtual cursor to the element's global center before the AX
        // click. `frameGlobal` is global Quartz top-left — the same space as
        // VirtualCursor.move.
        let center = AXTree.record(pid: target.pid, index: index)?.frameGlobal.map {
            CGPoint(x: $0.x + $0.w / 2, y: $0.y + $0.h / 2)
        }
        return try await withForegroundLease(
            command: "click",
            target: target
        ) { [self] in
            _ = try await CursorIndexedActionGate.perform(
                moveForAction: { [cursor] in
                    if let center {
                        await cursor.moveForAction(
                            to: center,
                            targetPid: target.pid
                        )
                    }
                },
                recheckStaleness: { [self] in
                    try guardStaleness(pid: target.pid, handle: handle)
                },
                mutate: {
                    try await AXAction.click(
                        pid: target.pid,
                        index: index,
                        clickCount: clickCount,
                        button: button
                    )
                }
            )
            cursor.showClick(
                at: center,
                kind: clickKind(button: button, clickCount: clickCount)
            )
            return .bool(true)
        }
    }

    /// `set_value`: write `value` into the element at `index` via AX (gated on
    /// settability inside AXAction). Returns `{ before, after }` so the caller
    /// can confirm the write landed.
    private func handleSetValue(_ payload: JSONValue) async throws -> JSONValue {
        try requireAXTrusted()
        guard let handle = try elementHandle(payload) else {
            throw CUError("bad_payload", "set_value requires an opaque snapshot handle copied from get_app_state")
        }
        let index = handle.index
        let value = payload["value"]?.asString ?? ""
        let target = try resolveTargetForMutation(payload)
        setResolvedTarget(target)
        try guardStaleness(pid: target.pid, handle: handle)
        return try await withForegroundLease(
            command: "set_value",
            target: target
        ) {
            let change = try AXAction.setValue(
                pid: target.pid,
                index: index,
                value: value
            )
            return .object([
                "before": change.before.map { JSONValue.string($0) } ?? .null,
                "after": change.after.map { JSONValue.string($0) } ?? .null,
            ])
        }
    }

    /// `select_text`: guard the opaque generation-bound handle, then select a
    /// unique UTF-16 text occurrence or place the caret around it. AXAction does
    /// the authoritative refetch immediately before writing the range.
    private func handleSelectText(_ payload: JSONValue) async throws -> JSONValue {
        try requireAXTrusted()
        guard let handle = try elementHandle(payload) else {
            throw CUError("bad_payload", "select_text requires an opaque snapshot handle copied from get_app_state")
        }
        guard let text = payload["text"]?.asString, !text.isEmpty else {
            throw CUError("bad_payload", "select_text requires a non-empty 'text' string")
        }
        let prefix = try optionalString(payload, key: "prefix")
        let suffix = try optionalString(payload, key: "suffix")
        let selectionRaw = try optionalString(payload, key: "selection") ?? "text"
        guard let selection = TextEditing.SelectionMode(rawValue: selectionRaw) else {
            throw CUError(
                "bad_payload",
                "selection must be one of text/cursor_before/cursor_after"
            )
        }

        let target = try resolveTargetForMutation(payload)
        setResolvedTarget(target)
        try guardStaleness(pid: target.pid, handle: handle)
        return try await withForegroundLease(
            command: "select_text",
            target: target
        ) {
            let range = try AXAction.selectText(
                pid: target.pid,
                index: handle.index,
                text: text,
                prefix: prefix,
                suffix: suffix,
                mode: selection
            )
            return .object([
                "location": .int(range.location),
                "length": .int(range.length),
            ])
        }
    }

    /// `perform_secondary_action`: invoke a secondary AX action on `index`. The
    /// model passes the PRETTY name it saw in the tree (e.g. "Raise", "Expand");
    /// AXAction translates pretty→raw before performing.
    private func handlePerformSecondaryAction(
        _ payload: JSONValue
    ) async throws -> JSONValue {
        try requireAXTrusted()
        guard let handle = try elementHandle(payload) else {
            throw CUError("bad_payload", "perform_secondary_action requires an opaque snapshot handle copied from get_app_state")
        }
        let index = handle.index
        guard let action = payload["action"]?.asString, !action.isEmpty else {
            throw CUError("bad_payload", "perform_secondary_action requires a non-empty 'action' string")
        }
        let target = try resolveTargetForMutation(payload)
        setResolvedTarget(target)
        try guardStaleness(pid: target.pid, handle: handle)
        return try await withForegroundLease(
            command: "perform_secondary_action",
            target: target
        ) {
            try AXAction.performSecondary(
                pid: target.pid,
                index: index,
                action: action
            )
            return .bool(true)
        }
    }

    /// `scroll`: element-domain when `index` is present, else point-domain when
    /// `x`/`y` are present. `direction` is required; `pages` defaults to 1.
    private func handleScroll(_ payload: JSONValue) async throws -> JSONValue {
        try requireAXTrusted()
        guard let direction = payload["direction"]?.asString, !direction.isEmpty else {
            throw CUError("bad_payload", "scroll requires a 'direction' (up/down/left/right)")
        }
        guard ["up", "down", "left", "right"].contains(direction.lowercased()) else {
            throw CUError("bad_payload", "Invalid scroll direction: \(direction)")
        }
        let pages = try Self.parsePages(payload)
        let target = try resolveTarget(payload)
        setResolvedTarget(target)

        let handle = try elementHandle(payload)
        let index = handle?.index
        if let handle {
            // Element-domain scroll: guard staleness like every index op.
            try guardStaleness(pid: target.pid, handle: handle)
        }
        // Point-domain scroll coordinates arrive in image-pixel space — map back
        // to global points (same inverse transform as a coordinate click).
        let rawX = Self.strictNumber(payload["x"])
        let rawY = Self.strictNumber(payload["y"])
        if handle == nil, (rawX == nil || rawY == nil) {
            throw CUError(
                "bad_payload",
                "point-domain scroll requires numeric 'x' and 'y'"
            )
        }
        if handle == nil, let rawX, let rawY {
            _ = try Self.validatedGlobalPoint(
                x: rawX,
                y: rawY,
                pid: target.pid
            )
        }
        return try await withForegroundLease(command: "scroll", target: target) {
            _ = try Injection.validateAuthorizedTarget(target)
            var x: Double?
            var y: Double?
            if handle == nil, let rawX, let rawY {
                let point = try Self.validatedGlobalPoint(
                    x: rawX,
                    y: rawY,
                    pid: target.pid
                )
                x = point.x
                y = point.y
            }
            try await AXAction.scroll(
                pid: target.pid,
                index: index,
                x: x,
                y: y,
                direction: direction,
                pages: pages
            )
            return .bool(true)
        }
    }

    /// `type_text`: replace the focused element's selection / insert at its
    /// caret, with PID-directed Unicode and clipboard fallbacks in AXAction.
    private func handleTypeText(_ payload: JSONValue) async throws -> JSONValue {
        try requireAXTrusted()
        guard let text = payload["text"]?.asString else {
            throw CUError("bad_payload", "type_text requires a 'text' string")
        }
        let expected = try Self.expectedProcessTarget(payload)
        let target = try resolveTargetForMutation(payload)
        setResolvedTarget(target)
        try requireSnapshotProcess(target: target, expected: expected)
        return try await withForegroundLease(
            command: "type_text",
            target: target
        ) {
            _ = try Injection.validateAuthorizedTarget(target)
            try self.requireSnapshotProcess(target: target, expected: expected)
            try await AXAction.typeText(pid: target.pid, text)
            return .bool(true)
        }
    }

    /// `paste`: bypass AX/Unicode typing and use the target app's in-process
    /// paste focus. This is the reliable recovery path for Chromium/CEF fields
    /// such as NeteaseMusic's search box. The clipboard lease restores every
    /// original pasteboard item unless the user copied something meanwhile.
    private func handlePaste(_ payload: JSONValue) async throws -> JSONValue {
        try requireAXTrusted()
        guard let text = payload["text"]?.asString else {
            throw CUError("bad_payload", "paste requires a 'text' string")
        }
        guard let rawFormat = payload["format"]?.asString,
              let format = ClipboardPasteFormat(rawValue: rawFormat) else {
            throw CUError("bad_payload", "paste format must be 'text', 'md', or 'html'")
        }
        let expected = try Self.expectedProcessTarget(payload)
        let target = try resolveTargetForMutation(payload)
        setResolvedTarget(target)
        try requireSnapshotProcess(target: target, expected: expected)
        return try await withForegroundLease(command: "paste", target: target) {
            _ = try Injection.validateAuthorizedTarget(target)
            try self.requireSnapshotProcess(target: target, expected: expected)
            try await pasteExecutor(target.pid, text, format)
            return .bool(true)
        }
    }

    /// `press_key`: send an xdotool-style key spec (e.g. "super+c", "Return",
    /// "Tab", "KP_0", "Prior") to the target app via postToPid.
    private func handlePressKey(_ payload: JSONValue) async throws -> JSONValue {
        try requireAXTrusted()
        guard let key = payload["key"]?.asString, !key.isEmpty else {
            throw CUError("bad_payload", "press_key requires a non-empty 'key' string")
        }
        let systemKeyCombos = try SystemKeyPolicy.parseGrant(
            payload["systemKeyCombos"]
        )
        let chords = try KeyboardCommandSequence.prepare(key, systemKeyCombos: systemKeyCombos)
        let expected = try Self.expectedProcessTarget(payload)
        let target = try resolveTargetForMutation(payload)
        setResolvedTarget(target)
        try requireSnapshotProcess(target: target, expected: expected)
        try await KeyboardCommandSequence.run(chords: chords) { batch in
            try await self.withForegroundLease(command: "press_key", target: target) {
                _ = try Injection.validateAuthorizedTarget(target)
                try self.requireSnapshotProcess(target: target, expected: expected)
                try await AXAction.pressKey(pid: target.pid, chords: batch)
            }
        }
        return .bool(true)
    }

    /// `drag`: coordinate-only press→drag→release between screenshot-local points.
    /// Coordinate-domain, so no element snapshot is required.
    private func handleDrag(_ payload: JSONValue) async throws -> JSONValue {
        try requireAXTrusted()
        guard let rawFrom = point(from: payload["from"]) else {
            throw CUError("bad_payload", "drag requires a 'from' object with numeric 'x' and 'y'")
        }
        guard let rawTo = point(from: payload["to"]) else {
            throw CUError("bad_payload", "drag requires a 'to' object with numeric 'x' and 'y'")
        }
        let button = try Self.parseMouseButton(payload)

        let target = try resolveTarget(payload)
        _ = try Self.validatedGlobalPoint(
            x: rawFrom.x,
            y: rawFrom.y,
            pid: target.pid
        )
        _ = try Self.validatedGlobalPoint(
            x: rawTo.x,
            y: rawTo.y,
            pid: target.pid
        )
        setResolvedTarget(target)

        // Park then glide the VIRTUAL overlay along the gesture; the real OS
        // cursor is never touched (AXAction.drag posts to a pid, not the HID tap).
        // Lease acquisition is intentionally before either visible cursor move.
        return try await withForegroundLease(command: "drag", target: target) { [self] in
            let from = try Self.validatedGlobalPoint(
                x: rawFrom.x,
                y: rawFrom.y,
                pid: target.pid
            )
            let to = try Self.validatedGlobalPoint(
                x: rawTo.x,
                y: rawTo.y,
                pid: target.pid
            )
            await cursor.move(to: from, animated: false)
            await cursor.moveForAction(
                to: to, targetPid: target.pid, waitForVisualFeedback: false
            )

            _ = try Self.validatedGlobalPoint(
                x: rawFrom.x,
                y: rawFrom.y,
                pid: target.pid
            )
            _ = try Self.validatedGlobalPoint(
                x: rawTo.x,
                y: rawTo.y,
                pid: target.pid
            )
            _ = try Injection.validateAuthorizedTarget(target)
            try await AXAction.drag(
                pid: target.pid,
                from: from,
                to: to,
                button: button
            )
            leftButtonHeldAt = nil
            leftButtonHeldTarget = nil
            return .bool(true)
        }
    }

    // MARK: - Target resolution + staleness guards

    private func setResolvedTarget(_ target: ProvenProcessTarget) {
        Injection.recordResolvedTarget(target)
        cursor.setVisualTarget(target)
    }

    private func withForegroundLease<T>(
        command: String,
        target: ProvenProcessTarget,
        action: () async throws -> T
    ) async throws -> T {
        guard CommandForegroundPolicy.requiresLease(command) else {
            throw CUError(
                "bad_command",
                "Mutation command \(command) is missing foreground isolation policy"
            )
        }
        // A locked screen still accepts synthesized input but no app ever sees
        // it, so the action would report success and change nothing. Refuse
        // before acting rather than hand back a receipt we cannot stand behind.
        // (Codex gates identically — ServerErrorCode.screenLocked.)
        guard !ScreenLockState.isLocked() else {
            throw CUError(
                "screen_locked",
                "The screen is locked, so the action was not run. Unlock the Mac and try again."
            )
        }
        let lease = try ForegroundLease.acquire(
            target: target,
            runtime: foregroundRuntime
        )
        return try await ForegroundMutationRunner.run(
            lease: lease,
            targetPID: target.pid,
            action: action
        )
    }

    /// Throw a typed `not_trusted` error unless Accessibility is granted to us.
    /// Shared by get_app_state and every AX-first actuation command.
    private func requireAXTrusted() throws {
        guard AXIsProcessTrusted() else {
            throw CUError(
                "not_trusted",
                "Accessibility permission is required. Grant cc-haha-computer-use in System Settings ▸ Privacy & Security ▸ Accessibility."
            )
        }
    }

    /// Resolve a selected RUNNING target — no launch or frontmost fallback.
    /// Selection precedence is locked before this call: `pid`, then `bundleId`,
    /// then `app`. Our OWN pid is excluded everywhere.
    /// Returns nil when nothing running matches — callers decide whether to launch,
    /// use frontmost, or throw.
    private func resolveRunningTarget(
        _ selector: AppTargetSelector?
    ) throws -> ResolvedAppTarget? {
        try AppTargetResolver.resolveRunning(selector: selector)
    }

    /// Resolve the explicit target required by semantic pointer actions. A
    /// coordinate owner or the frontmost app must never substitute for a missing
    /// `pid` / `bundleId` / `app` selector.
    private func resolveTarget(
        _ payload: JSONValue
    ) throws -> ProvenProcessTarget {
        guard let selector = try AppTargetResolver.selector(payload: payload) else {
            throw CUError("no_target", "Computer Use requires an explicit target app for this action")
        }
        guard let resolved = try resolveRunningTarget(selector) else {
            throw CUError("target_not_running", "The requested target app is not running")
        }
        _ = try TargetRoutingPolicy.pid(
            explicit: resolved.pid,
            coordinateOwner: nil
        )
        let target = try authorizeResolvedTarget(resolved)
        try Self.validateExpectedProcessTarget(
            target,
            expected: Self.expectedProcessTarget(payload)
        )
        return target
    }

    /// Resolve an explicit target for an injection command. There is no
    /// frontmost fallback: focus can change between tool planning and dispatch.
    private func resolveTargetForMutation(
        _ payload: JSONValue
    ) throws -> ProvenProcessTarget {
        try resolveTarget(payload)
    }

    /// Authorize only after an actual running pid and bundle have resolved.
    /// Numeric PID, localized name, bundle ID, frontmost, and launch all enter
    /// through this same seam.
    private func authorizeResolvedTarget(
        _ resolved: ResolvedAppTarget
    ) throws -> ProvenProcessTarget {
        try ResolvedTargetAuthorization.authorize(
            resolved: resolved,
            currentIdentity: AXTree.currentProcessIdentity(pid: resolved.pid)
        )
    }

    /// Run the coarse staleness guards before a handle-addressed action.
    /// These are diagnostics only; AXTree.refetch is the authoritative semantic
    /// freshness check immediately before every index mutation.
    ///   ① no snapshot taken for this pid → the model must re-query first.
    ///   ② handle epoch differs from the current proven key-window epoch → stale.
    ///   ③ sparse ID is absent from the current locator dictionary.
    ///   ④ target process gone → the session is dead.
    /// Each throws a `CUError` whose message matches Codex's wording so the
    /// bridge can surface it verbatim and the model self-corrects.
    private func guardStaleness(pid: pid_t, handle: SnapshotElementHandle) throws {
        // ① never snapshotted
        guard let membership = AXTree.handleMembership(pid: pid) else {
            let appName = NSRunningApplication(processIdentifier: pid)?.localizedName
                ?? NSRunningApplication(processIdentifier: pid)?.bundleIdentifier
                ?? "PID=\(pid)"
            throw CUError(
                "stale_snapshot",
                "The user changed '\(appName)'. Re-query the latest state with get_app_state before sending more actions."
            )
        }
        let currentProcessIdentity = AXTree.currentProcessIdentity(pid: pid)
        guard membership.matchesCurrentProcess(currentProcessIdentity) else {
            throw CUError(
                "stale_process",
                "The target process changed. Re-query the latest state with get_app_state before sending more actions."
            )
        }
        // ② the handle must name the current process/key-window epoch. Stable
        // IDs from an earlier explicit refresh remain valid only in this epoch.
        guard handle.snapshotID == membership.snapshotID else {
            throw CUError(
                "stale_snapshot",
                "Snapshot handle \(handle.rawValue) is stale. Re-query the latest state with get_app_state before sending more actions."
            )
        }
        // ③ sparse stable-ID membership. Count is diagnostic only; IDs above
        // the count can remain valid after lower IDs are removed.
        let count = AXTree.elementCount(pid: pid)
        guard membership.contains(
            handle,
            currentProcessIdentity: currentProcessIdentity
        ) else {
            throw CUError(
                "bad_index",
                "Element handle \(handle.rawValue) not found in snapshot (has \(count) elements)."
            )
        }
        // ④ process gone
        try requireLiveProcess(pid: pid)
    }

    /// Guard ③ in isolation: throw if the target process has exited. Used by
    /// the focus-targeted commands (type_text / press_key) which act on the
    /// app's focused element rather than a snapshot index.
    private func requireLiveProcess(pid: pid_t) throws {
        guard NSRunningApplication(processIdentifier: pid) != nil else {
            throw CUError(
                "process_gone",
                "The target app (PID \(pid)) is no longer running. Re-query the latest state with get_app_state."
            )
        }
    }

    // MARK: - Encoding helpers

    /// Re-encode a `Codable` result model into a dynamic ``JSONValue`` so the
    /// caller can frame it into the `{ ok, result }` envelope uniformly.
    private func encode<T: Encodable>(_ value: T) throws -> JSONValue {
        do {
            let data = try JSONEncoder().encode(value)
            return try JSONValue(jsonString: String(decoding: data, as: UTF8.self))
        } catch {
            throw CUError("encode_failed", "Failed to encode result: \(error)")
        }
    }

    // MARK: - Payload decoding helpers

    private func stringArray(_ value: JSONValue?) -> [String] {
        value?.asArray?.compactMap { $0.asString } ?? []
    }

    private func point(from value: JSONValue?) -> CGPoint? {
        guard let value,
              let x = Self.strictNumber(value["x"]),
              let y = Self.strictNumber(value["y"]) else {
            return nil
        }
        return CGPoint(x: x, y: y)
    }

    private static func strictNumber(_ value: JSONValue?) -> Double? {
        guard let value else { return nil }
        let number: Double
        switch value {
        case .int(let integer): number = Double(integer)
        case .double(let double): number = double
        default: return nil
        }
        return number.isFinite ? number : nil
    }

    private func optionalString(_ payload: JSONValue, key: String) throws -> String? {
        guard let value = payload[key], !value.isNull else { return nil }
        guard let string = value.asString else {
            throw CUError("bad_payload", "\(key) must be a string")
        }
        return string
    }

    private func optionalBoolean(_ payload: JSONValue, key: String) throws -> Bool? {
        guard let value = payload[key] else { return nil }
        guard case let .bool(boolean) = value else {
            throw CUError("bad_payload", "\(key) must be a boolean")
        }
        return boolean
    }

    /// Parse the model-visible opaque handle. Both wire aliases are accepted,
    /// but numbers, bare numeric strings, malformed handles, and conflicting
    /// duplicate aliases fail closed instead of binding to the latest snapshot.
    private func elementHandle(_ payload: JSONValue) throws -> SnapshotElementHandle? {
        let primary = payload["index"]
        let alias = payload["element_index"]
        if let primary, let alias, primary != alias {
            throw CUError("bad_payload", "index and element_index must not conflict")
        }
        guard let value = primary ?? alias, !value.isNull else { return nil }
        guard let rawValue = value.asString,
              let handle = SnapshotElementHandle(rawValue: rawValue)
        else {
            throw CUError(
                "bad_payload",
                "element_index must be the opaque handle copied from the beginning of a get_app_state line (for example g17:4)"
            )
        }
        return handle
    }

    static func parseClickCount(_ payload: JSONValue) throws -> Int {
        let primary = payload["click_count"]
        let alias = payload["clickCount"]
        if let primary, let alias, primary != alias {
            throw CUError("bad_payload", "click_count and clickCount must not conflict")
        }
        guard let value = primary ?? alias else { return 1 }
        guard case .int(let count) = value, (1...3).contains(count) else {
            throw CUError("bad_payload", "click_count must be an integer from 1 through 3")
        }
        return count
    }

    static func parsePages(_ payload: JSONValue) throws -> Double {
        guard let value = payload["pages"] else { return 1 }
        let pages: Double
        switch value {
        case .int(let count):
            pages = Double(count)
        case .double(let count):
            pages = count
        default:
            throw CUError("bad_payload", "pages must be a finite number")
        }
        guard pages.isFinite, pages > 0, pages <= 10 else {
            throw CUError("bad_payload", "pages must be greater than 0 and at most 10")
        }
        return pages
    }

    /// Unsupported or malformed contract values must never silently degrade to
    /// a left click.
    static func parseMouseButton(_ payload: JSONValue) throws -> MouseButton {
        let primary = payload["button"]
        let alias = payload["mouse_button"]
        if let primary, let alias, primary != alias {
            throw CUError("bad_payload", "button and mouse_button must not conflict")
        }
        guard let value = primary ?? alias else { return .left }
        guard case .string(let raw) = value,
              let button = MouseButton(rawValue: raw) else {
            throw CUError(
                "bad_payload",
                "mouse_button must be one of left, middle, right, back, or forward"
            )
        }
        return button
    }

    private func clickKind(
        button: MouseButton,
        clickCount: Int
    ) -> VirtualCursor.ClickKind {
        if button == .right { return .rightClick }
        if clickCount > 1 { return .doubleClick }
        return .single
    }
}
