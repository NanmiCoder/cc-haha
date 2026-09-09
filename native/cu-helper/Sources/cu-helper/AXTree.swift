//
//  AXTree.swift
//  cu-helper
//
//  THE perception core of the Codex-parity redesign: read a target app's KEY
//  WINDOW accessibility tree into a flat, stable-indexed, model-friendly text
//  tree — what `get_app_state` returns alongside the window screenshot. This
//  replaces the old "screenshot the whole display and let the model guess pixel
//  coordinates" loop.
//
//  Why AX (vs synthesizing pixel events + visual grounding):
//   • The model addresses elements by a stable `index` (semantic) — no pixel
//     hunting, no drift when the UI shifts a few points. `index` is a first-class
//     citizen the way it is for Codex's `computer-use` MCP.
//   • Reading structure is cheaper than encoding+shipping a full-screen JPEG every
//     step, and it's exact.
//   • Acting via AX (see AXAction) bypasses Secure Input and is reliable on
//     Chromium/Electron once their tree is force-exposed.
//
//  Chromium/Electron: their AX tree is OFF by default. We flip
//  `AXManualAccessibility` + `AXEnhancedUserInterface` on the app element so the
//  renderer exposes a real tree, and then aggressively ELIDE/flatten the thousands
//  of empty wrapper `AXGroup`/`AXWebArea` nodes Chromium emits — without that step
//  the cap is exhausted on noise before any usable control is reached (the real
//  reason "Electron looks like it can't read the tree").
//
//  Text format: this renderer emits the EXACT Codex `get_app_state` shape (verified
//  against captured 1.0.770 samples in
//  docs/.../tool-call-samples-2026-04-17.md): no `[index]` brackets, `\t` per depth,
//  HUMANIZED `kAXRoleDescription` (`standard window`/`split group`/`scroll area`/
//  `outline`/`row`/`button`…), `(traits)` list, bare title, `Description:`/`Help:`/
//  `URL:`/` ID:`(`_NS:`-filtered)/`Value:`(or bare)/`Placeholder:`/`Secondary
//  Actions:`(pretty + denylist), NO frame in the text, a trailing `The focused UI
//  element is …` line, 160-char `...` truncation with `\n`-escaped newlines.
//
//  Threading: `@MainActor`. AX APIs are NOT thread-safe and prior background-queue
//  use crashed the daemon — so ALL AX traffic stays on the main actor. Every app's
//  messages are bounded with `AXUIElementSetMessagingTimeout` (set on the app
//  element → app-wide) and depth + node count are capped so a huge or unresponsive
//  tree can never wedge the run loop.
//

import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

@MainActor
public enum AXTree {

    // MARK: - Result models (contract)

    /// Geometry kept INTERNALLY (global, Quartz top-left) for actuation /
    /// hit-testing; it is never printed into `axText`.
    public struct Frame: Encodable, Sendable {
        public let x: Double
        public let y: Double
        public let w: Double
        public let h: Double
    }

    /// One addressable element. `index` remains internal actuation metadata; the
    /// model receives an opaque snapshot handle in `axText` instead.
    public struct Element: Encodable, Sendable {
        public let index: Int
        public let windowIndex: Int
        public let path: [Int]
        public let role: String          // raw AXRole (e.g. "AXButton")
        public let roleText: String      // humanized roleDescription (e.g. "button")
        public let title: String?
        public let value: String?
        public let settable: Bool        // is kAXValue settable
        public let frameGlobal: Frame?   // global quartz frame, internal (injection)
        public let rawActions: [String]  // unfiltered AX action names (injection)
        public let depth: Int
    }

    public struct Result: Encodable, Sendable {
        public let pid: Int32
        public let appName: String?
        public let bundleId: String?
        public let windowTitle: String?
        public let elementCount: Int
        public let truncated: Bool
        public let durationMs: Int
        /// A full tree, diff, or no-change view. The TS MCP layer wraps this in
        /// the `<app_state>…</app_state>` envelope.
        public let axText: String
        public let elements: [Element]
        /// Per-app guidance for the host envelope's `<app_specific_instructions>`.
        public let appInstructions: String?
    }

    // MARK: - Tunables

    /// App-wide AX message timeout (seconds). Set on the app element so a slow
    /// renderer can never hang the daemon's run loop. Lowered from 8s → 2s: a CEF
    /// renderer's unreadable nodes were dragging single attribute reads toward the
    /// old 8s ceiling, doubling get_app_state latency on apps like NeteaseMusic.
    /// 2s is still far above a healthy AX round-trip; anything slower is a wedge we
    /// want to abandon, not wait on.
    private static let messagingTimeout: Float = 2.0
    /// Depth ceiling. Blueprint §2: ~16-20 once elision is in place.
    private static let maxDepth = 20
    /// Emitted-node ceiling. Blueprint §2: ~1200-1500.
    private static let maxEmitted = 1500
    /// Visible-row cap per outline/list/table. Blueprint §2.
    private static let maxVisibleRows = 20
    /// Per-string truncation. Blueprint §1: 160 + "...".
    private static let maxTextLen = 160

    private static let axWebAreaRole = "AXWebArea"
    private static let axLinkRole = "AXLink"
    private static let axContentsAttribute = "AXContents"
    private static let axVisibleChildrenAttribute = "AXVisibleChildren"
    private static let menuBarWindowIndex = -1

    // MARK: - Per-pid session cache (blueprint §3 / §6)

    /// A root locator is deliberately stronger than the snapshot-time position in
    /// the AX windows array. A window can be acted on only when its public Window
    /// Server identity can be proved again; the menu bar is an explicit AX root.
    private enum RootLocator: Sendable, Hashable {
        case window(id: CGWindowID, rootFingerprint: ElementFingerprint)
        case menuBar(rootFingerprint: ElementFingerprint)
        case unverifiableWindow

        var windowID: CGWindowID? {
            guard case let .window(id, _) = self else { return nil }
            return id
        }
    }

    /// Immutable evidence captured for one emitted index. Synthetic text entries
    /// store the fingerprint of the live row they represent, not a made-up text
    /// fingerprint that could never match during refetch.
    private struct SnapshotLocator: Sendable, Hashable {
        let root: RootLocator
        let path: [SnapshotPathStep]?
        let fingerprint: ElementFingerprint

        var isActionRefetchable: Bool {
            guard path != nil else { return false }
            if case .unverifiableWindow = root { return false }
            return true
        }
    }

    /// Root evidence retained only for display reconciliation. An unverifiable
    /// window is namespaced for the current render but never inherits an ID
    /// across refreshes, and remains unusable by the action path.
    private enum DisplayRootIdentity: Hashable {
        case window(id: CGWindowID, rootFingerprint: ElementFingerprint)
        case menuBar(rootFingerprint: ElementFingerprint)
        case unverifiableWindow(windowIndex: Int)
    }

    private typealias DisplayIdentity = AXTreeDisplayIdentity<
        DisplayRootIdentity,
        ElementFingerprint
    >
    private typealias ReconciliationKey = AXTreeStableIdentity<
        SnapshotLocator,
        DisplayIdentity
    >

    private struct CGWindowCandidate {
        let id: CGWindowID
        let bounds: CGRect
        let title: String?
    }

    /// Everything a later actuation needs to address an element by `index`, with
    /// no cached AXUIElement or cached root allowed on the action path.
    private struct Session {
        let snapshotID: UInt64
        let processIdentity: AXTreeProcessIdentity
        let keyWindowID: CGWindowID?
        let nextElementID: Int
        var elements: [Element]
        var locators: [Int: SnapshotLocator]
        var reconciliationKeys: [Int: ReconciliationKey]
        var diffLines: [AXTreeDiffLine]
    }

    private static var sessions: [pid_t: Session] = [:]
    private static var nextSnapshotID: UInt64 = 1

    /// Process lifetimes already warmed for Chromium/Electron AX exposure.
    /// Identity, not pid alone, prevents a recycled pid from skipping warm-up.
    private static var activatedProcesses: [pid_t: AXTreeProcessIdentity] = [:]

    // MARK: - Public entry (contract)

    nonisolated private static func processIdentity(
        for running: NSRunningApplication?
    ) -> AXTreeProcessIdentity {
        AXTreeProcessIdentity(
            bundleID: running?.bundleIdentifier,
            executablePath: running?.executableURL?.path,
            launchTime: running?.launchDate?.timeIntervalSinceReferenceDate
        )
    }

    nonisolated static func currentProcessIdentity(pid: pid_t) -> AXTreeProcessIdentity? {
        guard let running = NSRunningApplication(processIdentifier: pid) else {
            return nil
        }
        return processIdentity(for: running)
    }

    /// Build the app-state (AX tree only; the window screenshot is attached by the
    /// caller / CommandRouter) for `pid`, caching a per-pid session for later
    /// index→element resolution. Individual AX reads remain best-effort, but ID
    /// reconciliation and diff-integrity failures throw instead of publishing a
    /// malformed snapshot.
    public static func appState(pid: pid_t, disableDiff: Bool = false) async throws -> Result {
        let started = ProcessInfo.processInfo.systemUptime

        let running = NSRunningApplication(processIdentifier: pid)
        let appName = running?.localizedName
        let bundleId = running?.bundleIdentifier
        let processIdentity = processIdentity(for: running)

        let app = AXUIElementCreateApplication(pid)
        // App-wide timeout (Apple: setting on the application element applies to
        // every message sent to that application).
        AXUIElementSetMessagingTimeout(app, messagingTimeout)
        // Force Chromium/Electron (and some native apps) to expose a full tree.
        enableEnhancedAX(app)

        // Give a Chromium/Electron renderer time to build its web tree
        // asynchronously after `enableEnhancedAX` (a warm-up poll), but DO NOT
        // activate/raise the target app. Codex (verified against its binary) reads
        // the AX tree WITHOUT bringing the app to the foreground — `enableEnhancedAX`
        // is the real trigger, not activation. The old `running.activate(...)` here
        // was the single root cause of "Computer Use steals the foreground + mouse,
        // and the virtual cursor strands on whatever the user switched to"; and for
        // a CEF app like NeteaseMusic it exposes nothing anyway (coordinate
        // fallback). Poll is once per proven process lifetime; an unproven
        // identity is deliberately never cached and therefore warms every time. NEVER
        // Thread.sleep (that would freeze the glow / AXObserver run loop).
        if AXTreeDiff.shouldWarmAX(
            cached: activatedProcesses[pid],
            current: processIdentity
        ) {
            await settleUntilNonShell(app: app, deadlineSec: 1.2)
            if processIdentity.isProven {
                activatedProcesses[pid] = processIdentity
            } else {
                activatedProcesses.removeValue(forKey: pid)
            }
        }

        let systemWide = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(systemWide, messagingTimeout)

        // Resolve all top-level windows up front for rendering. Each one is also
        // mapped to a Window Server id; the array position is never trusted later.
        let windows = resolveWindows(app: app)

        // Key window for the screenshot/title: focused → main → first usable.
        let keyWindow = preferredKeyWindow(app: app, systemWide: systemWide, windows: windows)
        let windowTitle = keyWindow.flatMap { stringValue($0, kAXTitleAttribute) }
        let windowBounds = keyWindow.flatMap { frameRect($0) }

        let focused = preferredFocusedElement(app: app, pid: pid, systemWide: systemWide)
        let selectedText = focused.flatMap { selectedTextValue($0) }

        let cgWindows = cgWindowCandidates(pid: pid)
        let rootLocators = windowLocators(windows, candidates: cgWindows)
        let keyWindowID = keyWindow.flatMap { wanted -> CGWindowID? in
            guard let index = windows.firstIndex(where: { CFEqual($0, wanted) }) else {
                return nil
            }
            return rootLocators[index].windowID
        }

        let previous = sessions[pid]
        let policy = AXTreeDiff.refreshPolicy(
            previousProcessIdentity: previous?.processIdentity,
            currentProcessIdentity: processIdentity,
            previousWindowID: previous?.keyWindowID,
            currentWindowID: keyWindowID,
            hasBaseline: previous != nil,
            disableDiff: disableDiff
        )
        let baselineSession = policy.reuseEpoch ? previous : nil
        let snapshotID = baselineSession?.snapshotID ?? consumeSnapshotID()
        let returnFull = policy.returnFull || baselineSession == nil

        var renderer = Renderer(
            windowBounds: windowBounds,
            focusedElement: focused
        )

        for (wi, window) in windows.enumerated() {
            renderer.render(
                window,
                rootLocator: rootLocators[wi],
                windowIndex: wi,
                path: [],
                snapshotPath: [],
                depth: 0,
                ancestors: []
            )
            if renderer.reachedCap { break }
        }

        // Second pass: the menu bar (so menu items are addressable by index).
        if !renderer.reachedCap,
           let menuBar = copyElement(app, kAXMenuBarAttribute),
           !windows.contains(where: { CFEqual($0, menuBar) }) {
            renderer.render(
                menuBar,
                rootLocator: .menuBar(rootFingerprint: fingerprint(of: menuBar)),
                windowIndex: menuBarWindowIndex,
                path: [],
                snapshotPath: [],
                depth: 0,
                ancestors: []
            )
        }

        let previousIdentities: [AXTreeIdentity<ReconciliationKey>] = baselineSession
            .map { session in
                session.reconciliationKeys
                .map { id, key in AXTreeIdentity(id: id, key: key) }
                .sorted { $0.id < $1.id }
            } ?? []
        let currentIdentities: [AXTreeIdentity<ReconciliationKey>] = renderer.reconciliationKeys
            .map { id, key in AXTreeIdentity(id: id, key: key) }
            .sorted { $0.id < $1.id }
        let reconciliation = try AXTreeDiff.reconcile(
            previous: previousIdentities,
            current: currentIdentities,
            nextID: baselineSession?.nextElementID ?? 0,
            canInherit: { $0.canInheritStableID }
        )

        func assignedID(_ provisionalID: Int) throws -> Int {
            guard let stableID = reconciliation.assignments[provisionalID] else {
                throw AXTreeReconciliationError.incompleteAssignments
            }
            return stableID
        }

        let stableElements = try renderer.elements.map { element -> Element in
            let stableID = try assignedID(element.index)
            return Element(
                index: stableID,
                windowIndex: element.windowIndex,
                path: element.path,
                role: element.role,
                roleText: element.roleText,
                title: element.title,
                value: element.value,
                settable: element.settable,
                frameGlobal: element.frameGlobal,
                rawActions: element.rawActions,
                depth: element.depth
            )
        }
        var stableLocators: [Int: SnapshotLocator] = [:]
        stableLocators.reserveCapacity(renderer.locators.count)
        for (provisionalID, locator) in renderer.locators {
            let stableID = try assignedID(provisionalID)
            stableLocators[stableID] = locator
        }
        var stableReconciliationKeys: [Int: ReconciliationKey] = [:]
        stableReconciliationKeys.reserveCapacity(renderer.reconciliationKeys.count)
        for (provisionalID, key) in renderer.reconciliationKeys {
            let stableID = try assignedID(provisionalID)
            stableReconciliationKeys[stableID] = key
        }
        let stableLines = try renderer.nodes.map { node -> AXTreeDiffLine in
            let stableID = try assignedID(node.provisionalID)
            let handle = SnapshotElementHandle(snapshotID: snapshotID, index: stableID).rawValue
            return AXTreeDiffLine(
                id: stableID,
                rendered: "\(String(repeating: "\t", count: node.depth))\(handle)\(node.suffix)"
            )
        }
        let focusedSummary: String?
        if let node = renderer.focusedNode {
            let stableID = try assignedID(node.provisionalID)
            let handle = SnapshotElementHandle(snapshotID: snapshotID, index: stableID).rawValue
            focusedSummary = "\(handle)\(node.suffix)"
        } else {
            focusedSummary = nil
        }
        let contextTail = renderContextTail(
            focusedSummary: focusedSummary,
            selectedText: selectedText
        )
        let fullText = renderText(
            appName: appName,
            bundleId: bundleId,
            pid: pid,
            windowTitle: windowTitle,
            treeLines: stableLines.map(\.rendered),
            focusedSummary: focusedSummary,
            selectedText: selectedText
        )
        let displayTitle = displayWindowTitle(
            windowTitle,
            appName: appName ?? bundleId ?? "Application"
        )
        var axText: String
        if returnFull || baselineSession == nil {
            axText = fullText
        } else {
            axText = try AXTreeDiff.text(
                old: baselineSession?.diffLines ?? [],
                new: stableLines,
                windowTitle: displayTitle,
                contextTail: contextTail
            )
        }
        // Chromium/CEF apps hand back nothing but window chrome. Without being
        // told, the model keeps clicking element handles that cannot reach the
        // content, gets "Action completed" every time, and never tries the
        // coordinates it already has in the screenshot. Judged on the FULL
        // tree, not the diff — a diff of an unchanged shell is empty and would
        // never trip the check.
        if ShellTreeAdvice.isShellOnly(fullText) {
            axText += "\n\n" + ShellTreeAdvice.advice
        }

        // Said last, because it outranks everything above it: when the window is
        // off screen, the shell advice's "read coordinates off the screenshot"
        // is advice the model cannot act on.
        if let notice = OffScreenTargetAdvice.noticeIfUnreachable(
            hasWindowOnScreen: WindowGeometry.hasWindowOnScreen(pid: pid)
        ) {
            axText += "\n\n" + notice
        }

        // Replace the entire internal tree even when only a textual diff is
        // returned. Actions always resolve from these latest locators.
        sessions[pid] = Session(
            snapshotID: snapshotID,
            processIdentity: processIdentity,
            keyWindowID: keyWindowID,
            nextElementID: reconciliation.nextID,
            elements: stableElements,
            locators: stableLocators,
            reconciliationKeys: stableReconciliationKeys,
            diffLines: stableLines
        )
        let durationMs = Int((ProcessInfo.processInfo.systemUptime - started) * 1000)

        return Result(
            pid: pid,
            appName: appName,
            bundleId: bundleId,
            windowTitle: windowTitle,
            elementCount: stableElements.count,
            truncated: renderer.reachedCap,
            durationMs: durationMs,
            axText: axText,
            elements: stableElements,
            appInstructions: AppGuidance.instructions(bundleId: bundleId)
        )
    }

    /// Resolve an index against the CURRENT application tree. This method never
    /// returns a snapshot-time AX ref and never starts from a cached window root.
    /// Any unprovable window identity, changed path, or changed semantic fingerprint
    /// is stale by construction.
    public static func refetch(pid: pid_t, index: Int) throws -> AXUIElement {
        guard let session = sessions[pid],
              session.reconciliationKeys[index]?.isActionRefetchable == true,
              let expected = session.locators[index] else {
            throw CUError("stale_element", "No snapshot element \(index); call get_app_state")
        }
        let currentIdentity = currentProcessIdentity(pid: pid)
        guard session.processIdentity.isProven,
              currentIdentity?.isProven == true,
              currentIdentity == session.processIdentity else {
            throw CUError(
                "stale_process",
                "The target process changed; call get_app_state before acting"
            )
        }

        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, messagingTimeout)
        enableEnhancedAX(app)

        guard let path = expected.path,
              let root = currentRoot(pid: pid, app: app, locator: expected.root),
              let live = walk(root: root, path: path),
              expected.fingerprint.matches(fingerprint(of: live))
        else {
            throw CUError("stale_element", "The target UI changed; call get_app_state before acting")
        }
        return live
    }

    /// The flat record the latest `appState` assigned to `index` (nil if stale).
    public static func record(pid: pid_t, index: Int) -> Element? {
        sessions[pid]?.elements.first(where: { $0.index == index })
    }

    /// Epoch of the latest proven pid + key-window session. Explicit refreshes
    /// reuse it only while process/window identity remains proven.
    public static func snapshotID(pid: pid_t) -> UInt64? {
        sessions[pid]?.snapshotID
    }

    static func handleMembership(pid: pid_t) -> AXTreeHandleMembership? {
        guard let session = sessions[pid] else { return nil }
        return AXTreeHandleMembership(
            snapshotID: session.snapshotID,
            processIdentity: session.processIdentity,
            elementIDs: Set(session.locators.keys)
        )
    }

    static func snapshotEvidence(pid: pid_t) -> AXTreeSnapshotEvidence? {
        guard let session = sessions[pid] else { return nil }
        return AXTreeSnapshotEvidence(
            processIdentity: session.processIdentity,
            keyWindowID: session.keyWindowID
        )
    }

    /// Reuse the snapshot's proven window identity and the ordinary fresh AX
    /// refetch path, rather than independently guessing a window from its frame.
    static func snapshotWindowElement(pid: pid_t, windowID: CGWindowID) throws -> AXUIElement {
        let roots = sessions[pid]?.locators.filter {
            $0.value.root.windowID == windowID && $0.value.path?.isEmpty == true
        } ?? [:]
        guard windowID != kCGNullWindowID, roots.count == 1, let index = roots.keys.first else {
            throw CUError("stale_window", "No proven snapshot window; call get_app_state before acting")
        }
        return try refetch(pid: pid, index: index)
    }

    /// Resolve the live AX key-window to its current Window Server identity.
    /// This performs a fresh lookup and never trusts the snapshot-time window
    /// array position, allowing coordinate actions to reject a window switch.
    static func currentKeyWindowID(pid: pid_t) -> CGWindowID? {
        guard NSRunningApplication(processIdentifier: pid) != nil else {
            return nil
        }
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, messagingTimeout)
        enableEnhancedAX(app)
        let systemWide = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(systemWide, messagingTimeout)
        let windows = resolveWindows(app: app)
        guard let keyWindow = preferredKeyWindow(
            app: app,
            systemWide: systemWide,
            windows: windows
        ) else { return nil }
        let locators = windowLocators(
            windows,
            candidates: cgWindowCandidates(pid: pid)
        )
        guard let index = windows.firstIndex(where: { CFEqual($0, keyWindow) }) else {
            return nil
        }
        return locators[index].windowID
    }

    /// Sparse stable-ID membership. Never infer presence from element count:
    /// removed IDs are intentionally not reused inside an epoch.
    public static func hasElement(pid: pid_t, id: Int) -> Bool {
        sessions[pid]?.locators[id] != nil
    }

    /// Whether a snapshot for `pid` exists (staleness guard ①: "never queried").
    public static func hasSnapshot(pid: pid_t) -> Bool {
        sessions[pid] != nil
    }

    /// Element count of the latest snapshot for `pid` (0 if none) — for the
    /// "index out of range" staleness message.
    public static func elementCount(pid: pid_t) -> Int {
        sessions[pid]?.elements.count ?? 0
    }

    /// Drop a pid's session (e.g. when CommandRouter sees the process exited).
    public static func invalidate(pid: pid_t) {
        sessions.removeValue(forKey: pid)
        activatedProcesses.removeValue(forKey: pid)
    }

    /// Drop every generation-bound snapshot at a daemon client boundary. Keep
    /// `nextSnapshotID` monotonic so a handle from the previous client can never
    /// collide with a fresh session after reset.
    static func resetSessionSnapshots() {
        sessions.removeAll()
    }

    // MARK: - Locator resolution (blueprint §3)

    /// Re-walk a freshly resolved current root through immutable topology
    /// evidence. Every hop compares the complete ordered sibling fingerprint
    /// list; duplicate wrappers additionally require unique direct-child
    /// topology before one candidate can be selected.
    private static func walk(root: AXUIElement, path: [SnapshotPathStep]) -> AXUIElement? {
        var current = root
        for step in path {
            let kids = walkChildren(of: current)
            let currentFingerprints = kids.map(fingerprint(of:))
            guard let childIndex = step.selectedIndex(
                in: currentFingerprints,
                childTopologyAt: { index in
                    guard kids.indices.contains(index) else { return nil }
                    return walkChildren(of: kids[index]).map(fingerprint(of:))
                }
            ) else {
                return nil
            }
            current = kids[childIndex]
        }
        return current
    }

    private static func consumeSnapshotID() -> UInt64 {
        guard nextSnapshotID < UInt64.max else {
            fatalError("Computer Use snapshot generation exhausted")
        }
        let snapshotID = nextSnapshotID
        nextSnapshotID += 1
        return snapshotID
    }

    /// Resolve only from roots read from a newly-created application element.
    /// Window array positions are intentionally ignored; the public Window Server
    /// id must map uniquely both at snapshot time and now.
    private static func currentRoot(
        pid: pid_t,
        app: AXUIElement,
        locator: RootLocator
    ) -> AXUIElement? {
        switch locator {
        case let .menuBar(rootFingerprint):
            guard let menuBar = copyElement(app, kAXMenuBarAttribute),
                  rootFingerprint.matches(fingerprint(of: menuBar))
            else { return nil }
            return menuBar

        case let .window(expectedID, rootFingerprint):
            let candidates = cgWindowCandidates(pid: pid)
            let matchingRoots = currentTopLevelWindows(app: app).filter { window in
                mappedWindowID(window, candidates: candidates) == expectedID
            }
            guard matchingRoots.count == 1,
                  let window = matchingRoots.first,
                  rootFingerprint.matches(fingerprint(of: window))
            else { return nil }
            return window

        case .unverifiableWindow:
            return nil
        }
    }

    /// Current, non-minimized top-level AX roots without the snapshot path's
    /// recovery side effects. Focused/main roots are included only as public AX
    /// fallbacks and de-duplicated against AXWindows.
    private static func currentTopLevelWindows(app: AXUIElement) -> [AXUIElement] {
        var windows = usableWindows(app)
        for attribute in [kAXFocusedWindowAttribute, kAXMainWindowAttribute] {
            guard let window = copyElement(app, attribute), isUsableWindow(window) else { continue }
            if !windows.contains(where: { CFEqual($0, window) }) {
                windows.append(window)
            }
        }
        return windows
    }

    /// Map every snapshot AX root first, then validate the mapping as a whole.
    /// Any duplicate accepted CGWindowID makes every root unverifiable because
    /// the snapshot's AX↔WindowServer identity evidence is contradictory.
    private static func windowLocators(
        _ windows: [AXUIElement],
        candidates: [CGWindowCandidate]
    ) -> [RootLocator] {
        let mappedIDs = windows.map { mappedWindowID($0, candidates: candidates) }
        let validatedIDs = SnapshotWindowIdentityEvidence.validateUniqueRootIDs(mappedIDs)
        return zip(windows, validatedIDs).map { window, id in
            guard let id else { return .unverifiableWindow }
            return .window(id: id, rootFingerprint: fingerprint(of: window))
        }
    }

    /// Associate the AX root with its actual WindowServer ID, validated against
    /// this PID's current candidates. Only when that API is unavailable do we
    /// require the older frame/title evidence. Chrome's AX title includes app
    /// and profile names that its CG title omits; title equality is not identity.
    private static func mappedWindowID(
        _ window: AXUIElement,
        candidates: [CGWindowCandidate]
    ) -> CGWindowID? {
        let axFrame = frameRect(window)
        let axTitle = stringValue(window, kAXTitleAttribute)
        let evidence = candidates.map { candidate in
            SnapshotWindowIdentityEvidence.Candidate(
                id: candidate.id,
                frameMatches: axFrame.map {
                    approximatelySameWindowFrame($0, candidate.bounds)
                } ?? false,
                title: candidate.title
            )
        }
        return SnapshotWindowIdentityEvidence.mappedWindowID(
            axTitle: axTitle,
            candidates: evidence,
            nativeWindowID: WindowGeometry.axWindowID(of: window)
        )
    }

    private static func cgWindowCandidates(pid: pid_t) -> [CGWindowCandidate] {
        let options: CGWindowListOption = [.optionAll, .excludeDesktopElements]
        guard let infos = CGWindowListCopyWindowInfo(options, kCGNullWindowID)
            as? [[String: Any]] else { return [] }

        return infos.compactMap { info in
            guard let ownerPID = (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
                  ownerPID == pid,
                  let id = (info[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
                  let boundsDictionary = info[kCGWindowBounds as String] as? NSDictionary,
                  let bounds = CGRect(dictionaryRepresentation: boundsDictionary)
            else { return nil }

            guard let layer = (info[kCGWindowLayer as String] as? NSNumber)?.intValue,
                  layer == 0,
                  bounds.width > 1,
                  bounds.height > 1
            else { return nil }
            let title = normalizedWindowTitle(info[kCGWindowName as String] as? String)
            return CGWindowCandidate(id: id, bounds: bounds, title: title)
        }
    }

    private static func approximatelySameWindowFrame(_ lhs: CGRect, _ rhs: CGRect) -> Bool {
        let tolerance: CGFloat = 1
        return abs(lhs.minX - rhs.minX) <= tolerance
            && abs(lhs.minY - rhs.minY) <= tolerance
            && abs(lhs.width - rhs.width) <= tolerance
            && abs(lhs.height - rhs.height) <= tolerance
    }

    private static func normalizedWindowTitle(_ value: String?) -> String? {
        guard let value else { return nil }
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return normalized.isEmpty ? nil : normalized
    }

    private static func fingerprint(of element: AXUIElement) -> ElementFingerprint {
        ElementFingerprint(
            role: stringValue(element, kAXRoleAttribute) ?? "AXUnknown",
            subrole: stringValue(element, kAXSubroleAttribute),
            identifier: stringValue(element, kAXIdentifierAttribute),
            title: stringValue(element, kAXTitleAttribute),
            label: stringValue(element, kAXDescriptionAttribute),
            valueKind: valueKind(element)
        )
    }

    /// Classify AXValue without incorporating its dynamic contents.
    private static func valueKind(_ element: AXUIElement) -> String? {
        guard let value = rawAttribute(element, kAXValueAttribute) else { return nil }
        if value is NSAttributedString { return "attributed_string" }

        let typeID = CFGetTypeID(value as CFTypeRef)
        if typeID == CFStringGetTypeID() { return "string" }
        if typeID == CFBooleanGetTypeID() { return "boolean" }
        if typeID == CFNumberGetTypeID(), let number = value as? NSNumber {
            return numericIsBoolean(element, number: number) ? "boolean" : "float"
        }
        if typeID == CFURLGetTypeID() { return "url" }
        if typeID == AXValueGetTypeID() { return "ax_value" }
        if typeID == AXUIElementGetTypeID() { return "element" }
        if typeID == CFArrayGetTypeID() { return "array" }
        return "other"
    }

    // MARK: - Enhanced AX

    /// Flip the private attributes that make Chromium/Electron expose their AX
    /// tree. Best-effort: harmlessly ignored by apps that don't honor them.
    private static func enableEnhancedAX(_ app: AXUIElement) {
        AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
    }

    /// After enabling enhanced AX, poll the key window until real (non-shell) web
    /// content appears or `deadlineSec` elapses — a Chromium/Electron renderer
    /// attaches its tree asynchronously. No activation involved (see appState()).
    /// Non-blocking: uses `Task.sleep`, NEVER `Thread.sleep` (that would freeze the
    /// daemon's run loop / glow).
    private static func settleUntilNonShell(app: AXUIElement, deadlineSec: Double) async {
        let deadline = ProcessInfo.processInfo.systemUptime + deadlineSec
        let step: UInt64 = 120_000_000   // 120ms
        try? await Task.sleep(nanoseconds: step)   // give the renderer one beat first
        while ProcessInfo.processInfo.systemUptime < deadline {
            if hasNonShellContent(app: app) { return }
            try? await Task.sleep(nanoseconds: step)
        }
    }

    /// Shell = just the window's close/zoom/min/fullscreen system buttons + the
    /// menu bar. The presence of an AXWebArea/AXScrollArea/AXTextField/AXLink, or
    /// any non-system AXButton, means the renderer has attached real content.
    private static func hasNonShellContent(app: AXUIElement) -> Bool {
        guard let win = copyElement(app, kAXFocusedWindowAttribute)
            ?? copyElement(app, kAXMainWindowAttribute)
            ?? usableWindows(app).first else { return false }
        var stack = [win]
        var n = 0
        while let cur = stack.popLast(), n < 400 {
            n += 1
            let role = stringValue(cur, kAXRoleAttribute) ?? ""
            if role == axWebAreaRole
                || role == (kAXScrollAreaRole as String)
                || role == (kAXTextFieldRole as String)
                || role == axLinkRole { return true }
            if role == (kAXButtonRole as String) {
                let sub = stringValue(cur, kAXSubroleAttribute) ?? ""
                // Exclude the window's own close/zoom/min/fullscreen chrome.
                if !(sub.hasPrefix("AXCloseButton") || sub.hasPrefix("AXZoomButton")
                    || sub.hasPrefix("AXMinimizeButton") || sub.hasPrefix("AXFullScreenButton")) {
                    return true
                }
            }
            if let kids = copyElementArray(cur, kAXChildrenAttribute as String) {
                for k in kids { stack.append(k) }
            }
        }
        return false
    }

    // MARK: - Window resolution (blueprint §2: not-minimized + recover)

    /// All usable top-level windows in stable order; the array index is the
    /// `windowIndex` an element's locator refers to. Hidden/minimized Electron
    /// windows are recovered (unhide / un-minimize / raise) before giving up.
    private static func resolveWindows(app: AXUIElement) -> [AXUIElement] {
        var windows = usableWindows(app)
        if windows.isEmpty {
            recoverHiddenWindows(app: app, windows: rawWindows(app))
            windows = usableWindows(app)
        }
        if windows.isEmpty, let focused = copyElement(app, kAXFocusedWindowAttribute) {
            return [focused]
        }
        return windows
    }

    private static func rawWindows(_ app: AXUIElement) -> [AXUIElement] {
        copyElementArray(app, kAXWindowsAttribute) ?? []
    }

    private static func usableWindows(_ app: AXUIElement) -> [AXUIElement] {
        rawWindows(app).filter(isUsableWindow)
    }

    private static func isUsableWindow(_ window: AXUIElement) -> Bool {
        (stringValue(window, kAXRoleAttribute) == (kAXWindowRole as String))
            && boolValue(window, kAXMinimizedAttribute) != true
    }

    /// Pick the key window for screenshot/title purposes: focused → main → first.
    private static func preferredKeyWindow(
        app: AXUIElement,
        systemWide: AXUIElement,
        windows: [AXUIElement]
    ) -> AXUIElement? {
        if let focused = copyElement(app, kAXFocusedWindowAttribute), isUsableWindow(focused) {
            return focused
        }
        if let main = copyElement(app, kAXMainWindowAttribute), isUsableWindow(main) {
            return main
        }
        return windows.first
    }

    /// Best-effort recovery for apps that minimize/hide their window (common with
    /// Electron). Mirrors the iFurySt recover step but kept minimal.
    private static func recoverHiddenWindows(app: AXUIElement, windows: [AXUIElement]) {
        var pidValue: pid_t = 0
        AXUIElementGetPid(app, &pidValue)
        // Un-hide (Cmd+H) — this does NOT steal the foreground. We deliberately no
        // longer call `running.activate(.activateAllWindows)` here: that was the
        // foreground-stealing behaviour removed everywhere else. Computer Use runs
        // in the background.
        if pidValue > 0, let running = NSRunningApplication(processIdentifier: pidValue) {
            _ = running.unhide()
        }
        if let window = windows.first ?? copyElement(app, kAXFocusedWindowAttribute) {
            // Un-minimize the window so it's back on the on-screen list — without
            // bringing the whole app to the foreground.
            if boolValue(window, kAXMinimizedAttribute) == true {
                _ = AXUIElementSetAttributeValue(window, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
            }
        }
        // (Removed the 0.7s Thread.sleep — it froze the daemon run loop / glow /
        // AXObserver, contradicting this file's own rule. The warm-up poll in
        // appState already gives a recovered window time to rebuild its tree.)
    }

    private static func preferredFocusedElement(
        app: AXUIElement,
        pid: pid_t,
        systemWide: AXUIElement
    ) -> AXUIElement? {
        // Prefer the system-wide focus only when it belongs to the target app.
        if let sysFocusedApp = copyElement(systemWide, kAXFocusedApplicationAttribute),
           pidOf(sysFocusedApp) == pid,
           let el = copyElement(systemWide, kAXFocusedUIElementAttribute) {
            return el
        }
        return copyElement(app, kAXFocusedUIElementAttribute)
    }

    // MARK: - Renderer (format authority: blueprint §1)

    /// Stateful tree renderer. Walks an app's windows + menu bar, applies the
    /// generic-container elision / link / row-text flattening, assigns the flat
    /// `index` ONLY to emitted nodes (so indices match the printed lines), and
    /// records each emitted node's proven root locator + path + fingerprint.
    ///
    /// `@MainActor`: it calls AX (not thread-safe) the entire way down and is only
    /// ever driven from `appState`, which is itself main-actor isolated.
    @MainActor
    private struct Renderer {
        struct RenderedNode {
            let provisionalID: Int
            let depth: Int
            /// Exact rendered suffix after the opaque handle, including its
            /// leading separator when non-empty.
            let suffix: String
        }

        struct FocusedNode {
            let provisionalID: Int
            let suffix: String
        }

        let windowBounds: CGRect?
        let focusedElement: AXUIElement?

        var nextIndex = 0
        var nodes: [RenderedNode] = []
        var elements: [Element] = []
        var locators: [Int: SnapshotLocator] = [:]
        var reconciliationKeys: [Int: ReconciliationKey] = [:]
        var focusedNode: FocusedNode?
        var reachedCap = false

        init(windowBounds: CGRect?, focusedElement: AXUIElement?) {
            self.windowBounds = windowBounds
            self.focusedElement = focusedElement
        }

        /// Render `element` and its descendants. `path` is the child-index chain
        /// from this window's root (used VERBATIM as the locator regardless of
        /// elision — `refetch(pid:index:)` re-walks the SAME `walkChildren`).
        mutating func render(
            _ element: AXUIElement,
            rootLocator: RootLocator,
            windowIndex: Int,
            path: [Int],
            snapshotPath: [SnapshotPathStep]?,
            depth: Int,
            ancestors: [AXUIElement],
            knownFingerprint: ElementFingerprint? = nil
        ) {
            if nextIndex >= maxEmitted || depth >= maxDepth {
                reachedCap = true
                return
            }
            // Cycle guard (Electron trees contain reference cycles).
            if ancestors.contains(where: { CFEqual($0, element) }) { return }
            let nextAncestors = ancestors + [element]

            let elementFingerprint = knownFingerprint ?? fingerprint(of: element)
            let role = elementFingerprint.role
            let subrole = elementFingerprint.subrole
            let baseRoleText = roleDescription(element, role: role, subrole: subrole)
            let label = stringValue(element, kAXDescriptionAttribute)
            let help = stringValue(element, kAXHelpAttribute)
            let value = sanitizedValue(element)
            let identifier = displayIdentifier(elementFingerprint.identifier)
            let traits = traitList(element)
            let rawActions = actionNames(element)
            let prettyActions = meaningfulActions(rawActions, role: role)
            let placeholder = placeholderValue(element)
            let childElements = AXTree.walkChildren(of: element)
            let childFingerprints = childElements.map(fingerprint(of:))
            let rowTexts = role == (kAXRowRole as String) ? flattenedRowTexts(element) : []

            let title = preferredTitle(
                element,
                role: role,
                label: label,
                identifier: identifier,
                explicitValue: value,
                rowTexts: rowTexts
            )
            let linkText = role == axLinkRole
                ? markdownLinkText(element, title: title, label: label, value: value)
                : nil
            let displayTitle = linkText ?? title
            let inlineRowSummary = outlineRowSummary(element, role: role)

            let suppressChildren = shouldSuppressChildren(role: role, displayTitle: displayTitle)
            let roleText = displayRoleText(
                baseRoleText: baseRoleText,
                role: role,
                title: displayTitle,
                label: label,
                suppressChildren: suppressChildren
            )

            // Generic-container elision: a featureless AXGroup/AXUnknown wrapper is
            // skipped, recursing into its children AT THE SAME DEPTH but EXTENDING
            // the path (so the locator stays exact through the pruned node).
            if shouldElide(
                role: role,
                title: displayTitle,
                label: label,
                value: value,
                identifier: identifier,
                traits: traits,
                actions: prettyActions,
                childCount: childElements.count,
                webAreaDepthHere: webAreaDepth(role: role, ancestors: ancestors)
            ) {
                for (i, child) in childElements.enumerated() {
                    render(
                        child,
                        rootLocator: rootLocator,
                        windowIndex: windowIndex,
                        path: path + [i],
                        snapshotPath: appendingPathStep(
                            to: snapshotPath,
                            selectedIndex: i,
                            childElements: childElements,
                            childFingerprints: childFingerprints
                        ),
                        depth: depth,
                        ancestors: nextAncestors,
                        knownFingerprint: childFingerprints[i]
                    )
                    if reachedCap { return }
                }
                return
            }

            let index = nextIndex
            nextIndex += 1

            // ── Head: "<index> <roleText> (traits) <title> <rowSummary>" ──
            // The title and the row-summary attach to the head with a single
            // space (never a comma) — matching Codex (`0 standard window
            // open-codex-computer-use`, `2 outline Processes (showing 0-19 of …)`).
            let traitsSegment = traits.isEmpty ? "" : " (\(traits.joined(separator: ", ")))"
            let titleSegment = displayTitle.map { " \($0)" } ?? ""
            let rowSummarySegment = inlineRowSummary.map { " \($0)" } ?? ""
            let linePrefix = roleText.isEmpty ? "" : " \(roleText)"
            // Bare-value roles append the raw value to the head with a plain space
            // (e.g. `25 scroll bar (settable, float) 0.137`) instead of a comma-
            // joined `Value:` field.
            let bareValueSuffix: String = {
                guard let value, !value.isEmpty,
                      valueIsBare(roleText: roleText, role: role, title: displayTitle) else { return "" }
                return " \(value)"
            }()
            let head = "\(linePrefix)\(traitsSegment)\(titleSegment)\(rowSummarySegment)\(bareValueSuffix)"
            // "Has a textual head component" = a title, row-summary, or bare value
            // is present. This decides whether the FIRST comma-joined field is
            // comma- vs space-separated; bare traits alone do NOT count
            // (`4 row (selectable, expanded) Value: Favorites` → space before Value).
            let headHasText = displayTitle != nil || inlineRowSummary != nil || !bareValueSuffix.isEmpty

            // ── Field segments, in Codex order, each as BARE content ──
            // (e.g. "Description: list view"). They are comma/space-joined below.
            // Order is Description → Help → URL → Value → ID → Placeholder →
            // Secondary Actions, matching the real `64 switch Value: on, ID: …`
            // sample (Value precedes ID — verified against tool-call-samples).
            var fields: [String] = []
            if let desc = labelFieldText(label, title: displayTitle, linkText: linkText) { fields.append(desc) }
            if let help, help != displayTitle, help != label { fields.append("Help: \(sanitize(help))") }
            if let url = urlFieldText(element, role: role, title: displayTitle, label: label) { fields.append(url) }
            if bareValueSuffix.isEmpty,
               let v = valueFieldText(element, roleText: roleText, role: role, title: displayTitle, value: value) {
                fields.append(v)
            }
            if let id = identifierFieldText(role: role, identifier: identifier, title: displayTitle) { fields.append(id) }
            if let ph = placeholderFieldText(placeholder, title: displayTitle, label: label, value: value) { fields.append(ph) }
            if !prettyActions.isEmpty { fields.append("Secondary Actions: \(prettyActions.joined(separator: ", "))") }

            // Join: first field gets ", " when the head has text, otherwise a
            // leading " "; every later field gets ", ".
            var body = head
            for (i, field) in fields.enumerated() {
                body += (i == 0 ? (headHasText ? ", " : " ") : ", ") + field
            }

            nodes.append(RenderedNode(
                provisionalID: index,
                depth: depth,
                suffix: body
            ))

            // Record + immutable locator evidence. No live AX refs are cached.
            let locator = SnapshotLocator(
                root: rootLocator,
                path: snapshotPath,
                fingerprint: elementFingerprint
            )
            let emittedElement = Element(
                index: index,
                windowIndex: windowIndex,
                path: path,
                role: role,
                roleText: roleText,
                title: displayTitle,
                value: value,
                settable: isSettable(element, kAXValueAttribute),
                frameGlobal: globalFrame(element),
                rawActions: rawActions,
                depth: depth
            )
            locators[index] = locator
            reconciliationKeys[index] = reconciliationIdentity(
                locator: locator,
                element: emittedElement
            )
            elements.append(emittedElement)

            if let focusedElement, CFEqual(focusedElement, element) {
                // The focus tail line ("The focused UI element is 2 outline.") uses
                // the head + descriptive fields but DROPS the Secondary Actions
                // field (Codex never lists actions in the focus summary).
                let focusFields = fields.filter { !$0.hasPrefix("Secondary Actions:") }
                var focusBody = head
                for (i, field) in focusFields.enumerated() {
                    focusBody += (i == 0 ? (headHasText ? ", " : " ") : ", ") + field
                }
                focusedNode = FocusedNode(
                    provisionalID: index,
                    suffix: focusBody
                )
            }

            // A non-selected row inlines its remaining cell texts as sibling
            // `text` lines (Codex behavior) and does NOT recurse into cells.
            if role == (kAXRowRole as String), boolValue(element, kAXSelectedAttribute) != true {
                for text in rowTexts.dropFirst() {
                    appendSyntheticText(
                        text,
                        representedBy: element,
                        rootLocator: rootLocator,
                        windowIndex: windowIndex,
                        path: path,
                        snapshotPath: snapshotPath,
                        depth: depth + 1
                    )
                    if reachedCap { return }
                }
                return
            }

            if suppressChildren { return }

            for (i, child) in childElements.enumerated() {
                render(
                    child,
                    rootLocator: rootLocator,
                    windowIndex: windowIndex,
                    path: path + [i],
                    snapshotPath: appendingPathStep(
                        to: snapshotPath,
                        selectedIndex: i,
                        childElements: childElements,
                        childFingerprints: childFingerprints
                    ),
                    depth: depth + 1,
                    ancestors: nextAncestors,
                    knownFingerprint: childFingerprints[i]
                )
                if reachedCap { return }
            }
        }

        /// Emit a synthesized ` text <s>` line (flattened row/group text). It gets
        /// its OWN index; `refetch(pid:index:)` re-resolves and fingerprints the
        /// representing live row via the stored locator.
        private mutating func appendSyntheticText(
            _ text: String,
            representedBy element: AXUIElement,
            rootLocator: RootLocator,
            windowIndex: Int,
            path: [Int],
            snapshotPath: [SnapshotPathStep]?,
            depth: Int
        ) {
            if nextIndex >= maxEmitted || depth >= maxDepth {
                reachedCap = true
                return
            }
            let index = nextIndex
            nextIndex += 1
            nodes.append(RenderedNode(
                provisionalID: index,
                depth: depth,
                suffix: " text \(text)"
            ))
            let locator = SnapshotLocator(
                root: rootLocator,
                path: snapshotPath,
                fingerprint: fingerprint(of: element)
            )
            let emittedElement = Element(
                index: index,
                windowIndex: windowIndex,
                path: path,
                role: kAXStaticTextRole as String,
                roleText: "text",
                title: text,
                value: nil,
                settable: false,
                frameGlobal: globalFrame(element),
                rawActions: [],
                depth: depth
            )
            locators[index] = locator
            reconciliationKeys[index] = reconciliationIdentity(
                locator: locator,
                element: emittedElement
            )
            elements.append(emittedElement)
        }

        private func reconciliationIdentity(
            locator: SnapshotLocator,
            element: Element
        ) -> ReconciliationKey {
            if locator.isActionRefetchable {
                return .actionable(locator)
            }
            let root: DisplayRootIdentity
            let hasImmutableRootContinuity: Bool
            switch locator.root {
            case let .window(id, rootFingerprint):
                root = .window(id: id, rootFingerprint: rootFingerprint)
                hasImmutableRootContinuity = true
            case let .menuBar(rootFingerprint):
                root = .menuBar(rootFingerprint: rootFingerprint)
                hasImmutableRootContinuity = true
            case .unverifiableWindow:
                root = .unverifiableWindow(windowIndex: element.windowIndex)
                hasImmutableRootContinuity = false
            }
            let identity = DisplayIdentity(
                root: root,
                rawPath: element.path,
                fingerprint: locator.fingerprint,
                role: element.role,
                title: element.title,
                depth: element.depth
            )
            return hasImmutableRootContinuity
                ? .displayOnly(identity)
                : .transientDisplay(identity)
        }

        private func appendingPathStep(
            to path: [SnapshotPathStep]?,
            selectedIndex: Int,
            childElements: [AXUIElement],
            childFingerprints: [ElementFingerprint]
        ) -> [SnapshotPathStep]? {
            guard let path,
                  let step = SnapshotPathStep(
                      selectedIndex: selectedIndex,
                      childFingerprints: childFingerprints,
                      childTopologyAt: { index in
                          guard childElements.indices.contains(index) else { return nil }
                          return AXTree.walkChildren(of: childElements[index])
                              .map(AXTree.fingerprint(of:))
                      }
                  )
            else { return nil }
            return path + [step]
        }

        // MARK: Per-element rendering helpers (nested → window-local geometry)

        private func globalFrame(_ element: AXUIElement) -> Frame? {
            guard let rect = AXTree.frameRect(element) else { return nil }
            return Frame(x: Double(rect.origin.x), y: Double(rect.origin.y), w: Double(rect.width), h: Double(rect.height))
        }

        private func webAreaDepth(role: String, ancestors: [AXUIElement]) -> Int? {
            if role == axWebAreaRole { return 0 }
            guard let idx = ancestors.firstIndex(where: { stringValue($0, kAXRoleAttribute) == axWebAreaRole }) else {
                return nil
            }
            return ancestors.count - idx
        }

        private func preferredTitle(
            _ element: AXUIElement,
            role: String,
            label: String?,
            identifier: String?,
            explicitValue: String?,
            rowTexts: [String]
        ) -> String? {
            if let title = stringValue(element, kAXTitleAttribute), !title.isEmpty {
                return sanitize(title)
            }
            if role == (kAXRowRole as String) { return rowTexts.first }
            if role == (kAXOutlineRole as String) || role == (kAXListRole as String), let identifier {
                return identifier
            }
            if role == (kAXButtonRole as String) || role == (kAXPopUpButtonRole as String) || role == (kAXImageRole as String),
               let label, !label.isEmpty {
                return sanitize(label)
            }
            if role == (kAXGroupRole as String) || role == (kAXUnknownRole as String) || role == axWebAreaRole,
               let label, !label.isEmpty {
                return sanitize(label)
            }
            // Search fields surface their current text as the title.
            if roleDescription(element, role: role, subrole: stringValue(element, kAXSubroleAttribute)) == "search text field" {
                return explicitValue
            }
            return nil
        }

        private func markdownLinkText(_ element: AXUIElement, title: String?, label: String?, value: String?) -> String? {
            guard let url = urlValue(element, kAXURLAttribute), !url.isEmpty else { return nil }
            let text = [label, title, value].compactMap { candidate -> String? in
                guard let candidate else { return nil }
                let s = sanitize(candidate)
                return s.isEmpty ? nil : s
            }.first
            guard let text else { return nil }
            return "[\(markdownEscape(text))](\(url))"
        }

        private func outlineRowSummary(_ element: AXUIElement, role: String) -> String? {
            guard role == (kAXOutlineRole as String) || role == (kAXListRole as String) else { return nil }
            guard let allRows = copyElementArray(element, kAXRowsAttribute), !allRows.isEmpty else { return nil }
            let visible = visibleRows(in: allRows, parent: element)
            guard !visible.isEmpty, visible.count < allRows.count else { return nil }
            return "(showing 0-\(visible.count - 1) of \(allRows.count) items)"
        }

        /// Bare "Description: <label>" or nil. (Comma/space joining handled by the
        /// caller's uniform field-join.)
        private func labelFieldText(_ label: String?, title: String?, linkText: String?) -> String? {
            guard let label, label != title else { return nil }
            let comparable = markdownEscape(sanitize(label))
            if let linkText, linkText.hasPrefix("[\(comparable)](") { return nil }
            return "Description: \(sanitize(label))"
        }

        /// Bare "URL: <url>" (web areas only) or nil.
        private func urlFieldText(_ element: AXUIElement, role: String, title: String?, label: String?) -> String? {
            guard role == axWebAreaRole else { return nil }
            guard let url = urlValue(element, kAXURLAttribute), !url.isEmpty else { return nil }
            if url == title || url == label { return nil }
            return "URL: \(url)"
        }

        /// Bare "ID: <identifier>" or nil.
        private func identifierFieldText(role: String, identifier: String?, title: String?) -> String? {
            guard let identifier else { return nil }
            if role == (kAXOutlineRole as String) || role == (kAXListRole as String), title == identifier { return nil }
            return "ID: \(sanitize(identifier))"
        }

        /// Bare value field. Most controls render `Value: <v>`; static text /
        /// scroll bar / value indicator / text area render the raw value with NO
        /// `Value:` label (e.g. `25 scroll bar (settable, float) 0.137`). The
        /// bare-value variant is prefixed with a leading space here so the caller's
        /// space/comma join still yields the right separator (it never comma-joins
        /// — see how `valueIsBare` short-circuits in the assembler).
        private func valueFieldText(_ element: AXUIElement, roleText: String, role: String, title: String?, value: String?) -> String? {
            guard let value, !value.isEmpty else { return nil }
            if roleText == "search text field", title == value { return nil }
            return "Value: \(value)"
        }

        /// True when the element's value renders WITHOUT a `Value:` label (raw),
        /// so the assembler appends it to the head with a plain space.
        func valueIsBare(roleText: String, role: String, title: String?) -> Bool {
            if title == nil, role == (kAXStaticTextRole as String) { return true }
            return roleText == "scroll bar"
                || roleText == "value indicator"
                || roleText == "text entry area"
                || roleText == "text area"
        }

        /// Bare "Placeholder: <v>" or nil.
        private func placeholderFieldText(
            _ placeholder: String?,
            title: String?,
            label: String?,
            value: String?
        ) -> String? {
            guard let placeholder, !placeholder.isEmpty else { return nil }
            if placeholder == title || placeholder == label || placeholder == value { return nil }
            return "Placeholder: \(placeholder)"
        }

        private func flattenedRowTexts(_ element: AXUIElement) -> [String] {
            let cells = copyElementArray(element, kAXChildrenAttribute) ?? []
            var unique: [String] = []
            var seen = Set<String>()
            for cell in cells {
                for text in descendantTexts(of: cell) where seen.insert(text).inserted {
                    unique.append(text)
                }
            }
            return unique
        }

        private func descendantTexts(of element: AXUIElement, depth: Int = 0) -> [String] {
            guard depth < 4 else { return [] }
            var values: [String] = []
            let role = stringValue(element, kAXRoleAttribute) ?? ""
            if role == (kAXStaticTextRole as String) || role == (kAXTextFieldRole as String) {
                if let v = sanitizedValue(element) {
                    values.append(v)
                } else if let t = stringValue(element, kAXTitleAttribute) {
                    let s = sanitize(t)
                    if !s.isEmpty { values.append(s) }
                }
            }
            for child in copyElementArray(element, kAXChildrenAttribute) ?? [] {
                values.append(contentsOf: descendantTexts(of: child, depth: depth + 1))
            }
            return values
        }

        private func visibleRows(in rows: [AXUIElement], parent: AXUIElement) -> [AXUIElement] {
            guard let parentFrame = AXTree.frameRect(parent) else {
                return Array(rows.prefix(maxVisibleRows))
            }
            let visible = rows.filter { row in
                guard let f = AXTree.frameRect(row) else { return false }
                return f.intersects(parentFrame)
            }
            return Array((visible.isEmpty ? rows : visible).prefix(maxVisibleRows))
        }
    }

    // MARK: - Text assembly (header + tree + focus tail) (blueprint §1)

    private static func renderContextTail(
        focusedSummary: String?,
        selectedText: String?
    ) -> [String] {
        if let selectedText, !selectedText.isEmpty {
            return ["", "Selected text: [\(selectedText)]"]
        }
        if let focusedSummary {
            return ["", "The focused UI element is \(focusedSummary)."]
        }
        return []
    }

    private static func renderText(
        appName: String?,
        bundleId: String?,
        pid: pid_t,
        windowTitle: String?,
        treeLines: [String],
        focusedSummary: String?,
        selectedText: String?
    ) -> String {
        let name = appName ?? bundleId ?? "Application"
        let appReference = bundleId ?? name
        let displayTitle = displayWindowTitle(windowTitle, appName: name)

        var lines: [String] = []
        lines.append("App=\(appReference) (pid \(pid))")
        lines.append("Window: \"\(sanitize(displayTitle))\", App: \(name).")
        lines.append(contentsOf: treeLines)
        lines.append(contentsOf: renderContextTail(
            focusedSummary: focusedSummary,
            selectedText: selectedText
        ))
        return lines.joined(separator: "\n")
    }

    // MARK: - Traversal (multi-source child collection: blueprint §2)

    /// Children from `kAXChildren ∪ kAXRows ∪ AXContents ∪ AXVisibleChildren`,
    /// role-aware primary source, de-duplicated by `CFEqual`, with the Apple menu
    /// skipped under the menu bar. THIS is the ordering `(windowIndex, path)`
    /// indexes — `resolve` calls the SAME function so locators round-trip exactly.
    static func walkChildren(of element: AXUIElement) -> [AXUIElement] {
        let role = stringValue(element, kAXRoleAttribute)
        let rows = copyElementArray(element, kAXRowsAttribute) ?? []
        let visibleChildren = copyElementArray(element, axVisibleChildrenAttribute) ?? []
        let attributes = childTraversalAttributes(
            role: role,
            hasRows: !rows.isEmpty,
            hasVisibleChildren: !visibleChildren.isEmpty
        )

        var out: [AXUIElement] = []
        let isMenuBar = role == (kAXMenuBarRole as String)
        for attribute in attributes {
            let source: [AXUIElement]
            if attribute == (kAXRowsAttribute as String) {
                source = rows
            } else if attribute == axVisibleChildrenAttribute {
                source = visibleChildren
            } else {
                source = copyElementArray(element, attribute) ?? []
            }
            for child in source {
                if isMenuBar, stringValue(child, kAXTitleAttribute) == "Apple" { continue }
                if !out.contains(where: { CFEqual($0, child) }) {
                    out.append(child)
                }
            }
        }
        return out
    }

    private static func childTraversalAttributes(role: String?, hasRows: Bool, hasVisibleChildren: Bool) -> [String] {
        var attributes: [String] = []
        let rowsPrimary = hasRows && usesRowsAsPrimary(role)
        let visiblePrimary = hasVisibleChildren && (role == (kAXListRole as String))
        if !rowsPrimary && !visiblePrimary {
            attributes.append(kAXChildrenAttribute as String)
        }
        attributes.append(kAXRowsAttribute as String)
        attributes.append(axContentsAttribute)
        attributes.append(axVisibleChildrenAttribute)
        return attributes
    }

    private static func usesRowsAsPrimary(_ role: String?) -> Bool {
        guard let role else { return false }
        return role == (kAXOutlineRole as String)
            || role == (kAXListRole as String)
            || role == (kAXTableRole as String)
            || role == "AXBrowser"
    }

    // MARK: - Elision / suppression (blueprint §2)

    private static func shouldElide(
        role: String,
        title: String?,
        label: String?,
        value: String?,
        identifier: String?,
        traits: [String],
        actions: [String],
        childCount: Int,
        webAreaDepthHere: Int?
    ) -> Bool {
        guard role == (kAXGroupRole as String) || role == (kAXUnknownRole as String) else { return false }
        // Inside a web area, keep multi-child containers (they carry structure).
        if let webAreaDepthHere, webAreaDepthHere > 0, childCount > 1 { return false }
        // Single featureless wrapper around one child → collapse.
        if childCount == 1, title == nil, label == nil, value == nil, identifier == nil,
           actions.isEmpty, (traits.isEmpty || traits == ["settable", "string"]) {
            return true
        }
        // Fully featureless node → drop (recurse into any children).
        return title == nil && label == nil && value == nil && identifier == nil
            && traits.isEmpty && actions.isEmpty
    }

    private static func shouldSuppressChildren(role: String, displayTitle: String?) -> Bool {
        if role == (kAXMenuBarItemRole as String) { return true }
        if role == axLinkRole, displayTitle?.hasPrefix("[") == true { return true }
        return false
    }

    private static func displayRoleText(
        baseRoleText: String,
        role: String,
        title: String?,
        label: String?,
        suppressChildren: Bool
    ) -> String {
        if role == (kAXMenuBarItemRole as String) { return "" }
        if role == axLinkRole { return baseRoleText }
        if suppressChildren { return "container" }
        // A radio group whose meaning lives in its Description renders role-less.
        if baseRoleText == "radio group", role == (kAXRadioGroupRole as String), title == nil, label != nil {
            return ""
        }
        return baseRoleText
    }

    // MARK: - Role description (humanized: blueprint §1)

    /// Humanized role text. Special-cases per blueprint: AXRow→row,
    /// AXGroup→container, AXLink→link, AXWebArea→its roleDescription, menu-bar
    /// item→"", standard window from subrole; otherwise lowercased
    /// `kAXRoleDescription`, falling back to a de-camelCased raw role token.
    private static func roleDescription(_ element: AXUIElement, role: String, subrole: String?) -> String {
        if role == (kAXRowRole as String) { return "row" }
        if role == (kAXGroupRole as String) { return "container" }
        if role == (kAXMenuBarItemRole as String) { return "" }
        if role == axLinkRole { return "link" }
        if role == axWebAreaRole {
            return stringValue(element, kAXRoleDescriptionAttribute) ?? "HTML content"
        }
        if let rd = stringValue(element, kAXRoleDescriptionAttribute), !rd.isEmpty {
            return rd.lowercased()
        }
        if let subrole, subrole == (kAXStandardWindowSubrole as String) {
            return "standard window"
        }
        return humanizeAXToken(role)
    }

    // MARK: - Traits (blueprint §1)

    private static func traitList(_ element: AXUIElement) -> [String] {
        var values: [String] = []
        if boolValue(element, kAXSelectedAttribute) == true { values.append("selected") }
        if boolValue(element, kAXExpandedAttribute) == true { values.append("expanded") }
        if boolValue(element, kAXEnabledAttribute) == false { values.append("disabled") }
        if isSettable(element, kAXValueAttribute) {
            values.append("settable")
            if let valueType = valueTypeTrait(element) { values.append(valueType) }
        }
        return values
    }

    private static func valueTypeTrait(_ element: AXUIElement) -> String? {
        guard let value = rawAttribute(element, kAXValueAttribute) else { return nil }
        if CFGetTypeID(value as CFTypeRef) == CFStringGetTypeID() { return "string" }
        if let number = value as? NSNumber {
            return numericIsBoolean(element, number: number) ? "boolean" : "float"
        }
        return nil
    }

    // MARK: - Value (blueprint §1: on/off for checkbox/radio/tab; raw float for slider/scrollbar)

    private static func sanitizedValue(_ element: AXUIElement) -> String? {
        if let s = stringValue(element, kAXValueAttribute) {
            let sanitized = sanitize(s)
            return sanitized.isEmpty ? nil : sanitized
        }
        guard let value = rawAttribute(element, kAXValueAttribute) else { return nil }
        if let number = value as? NSNumber {
            if numericIsBoolean(element, number: number) {
                return number.boolValue ? "on" : "off"
            }
            return number.stringValue
        }
        return nil
    }

    private static func numericIsBoolean(_ element: AXUIElement, number: NSNumber) -> Bool {
        guard number == 0 || number == 1 else { return false }
        let role = stringValue(element, kAXRoleAttribute) ?? ""
        let roleText = roleDescription(element, role: role, subrole: stringValue(element, kAXSubroleAttribute))
        return roleText == "tab"
            || role == (kAXCheckBoxRole as String)
            || role == (kAXRadioButtonRole as String)
    }

    private static func placeholderValue(_ element: AXUIElement) -> String? {
        for attribute in ["AXPlaceholderValue", "AXPlaceholder"] {
            if let s = stringValue(element, attribute) {
                let sanitized = sanitize(s)
                if !sanitized.isEmpty { return sanitized }
            }
        }
        return nil
    }

    // MARK: - Secondary actions (pretty + denylist: blueprint §1)

    private static func meaningfulActions(_ values: [String], role: String) -> [String] {
        let isMenuRole = role == (kAXMenuBarRole as String)
            || role == (kAXMenuBarItemRole as String)
            || role == (kAXMenuRole as String)
            || role == (kAXMenuItemRole as String)
        var denylist: Set<String> = [
            kAXPressAction as String,
            "AXShowDefaultUI",
            "AXShowAlternateUI",
            "AXShowMenu",
            "AXConfirm",
            "AXScrollToVisible",
        ]
        if isMenuRole {
            denylist.insert("AXCancel")
            denylist.insert("AXPick")
        }
        let isScrollArea = role == (kAXScrollAreaRole as String)
        let hasVertical = values.contains("AXScrollUpByPage") || values.contains("AXScrollDownByPage")
        return values
            .filter { !denylist.contains($0) }
            .filter { action in
                // For scroll areas with vertical scroll, drop the horizontal ones.
                guard isScrollArea, hasVertical else { return true }
                return action != "AXScrollLeftByPage" && action != "AXScrollRightByPage"
            }
            .map(prettyActionName)
    }

    private static func prettyActionName(_ value: String) -> String {
        if value == "AXZoomWindow" { return "zoom the window" }
        let stripped = value.hasPrefix("AX") ? String(value.dropFirst(2)) : value
        let withoutPage = stripped.replacingOccurrences(of: "ByPage", with: "")
        return splitCamelCase(withoutPage)
    }

    private static func humanizeAXToken(_ value: String) -> String {
        let stripped = value.hasPrefix("AX") ? String(value.dropFirst(2)) : value
        return splitCamelCase(stripped).lowercased()
    }

    private static func splitCamelCase(_ value: String) -> String {
        var result = ""
        for character in value {
            if character.isUppercase, !result.isEmpty { result.append(" ") }
            result.append(character)
        }
        return result
    }

    // MARK: - Sanitize (blueprint §1: \n-escape, trim, 160 + "...")
    //
    // EVERY model-visible string must go through this. A raw newline+tab in an
    // app-supplied field (AXDescription, AXHelp, an identifier, a window title)
    // forges a whole tree row — indentation is the only structural signal the
    // model has — and an unbounded field can eat the entire token budget.
    // Comparisons may use raw values; emitted text may not.

    private static func sanitize(_ value: String) -> String {
        let collapsed = value
            .replacingOccurrences(of: "\n", with: "\\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if collapsed.count > maxTextLen {
            return String(collapsed.prefix(maxTextLen)) + "..."
        }
        return collapsed
    }

    private static func markdownEscape(_ text: String) -> String {
        text
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "[", with: "\\[")
            .replacingOccurrences(of: "]", with: "\\]")
    }

    private static func displayIdentifier(_ value: String?) -> String? {
        guard let value, !value.isEmpty, !value.hasPrefix("_NS:") else { return nil }
        return value
    }

    private static func displayWindowTitle(_ value: String?, appName: String) -> String {
        guard let value, !value.isEmpty else { return appName }
        // Collapse "App – Subtitle" window titles to just the app name (Codex does
        // this so e.g. Activity Monitor's window reads "Activity Monitor").
        if value.hasPrefix("\(appName) –") { return appName }
        return value
    }

    // MARK: - AX attribute primitives (CF memory-safe, main-actor, NESTED to avoid module collisions)

    private static func copyElement(_ element: AXUIElement, _ attribute: String) -> AXUIElement? {
        guard let value = rawAttribute(element, attribute) else { return nil }
        let ref = value as CFTypeRef
        guard CFGetTypeID(ref) == AXUIElementGetTypeID() else { return nil }
        return (ref as! AXUIElement)
    }

    private static func copyElementArray(_ element: AXUIElement, _ attribute: String) -> [AXUIElement]? {
        guard let value = rawAttribute(element, attribute) else { return nil }
        return value as? [AXUIElement]
    }

    private static func actionNames(_ element: AXUIElement) -> [String] {
        var names: CFArray?
        guard AXUIElementCopyActionNames(element, &names) == .success, let names else { return [] }
        return (names as? [String]) ?? []
    }

    /// An attribute as a display string (CFString / CFNumber / CFBoolean; geometry
    /// AXValues return nil — read those via `frameRect`).
    private static func stringValue(_ element: AXUIElement, _ attribute: String) -> String? {
        guard let value = rawAttribute(element, attribute) else { return nil }
        let id = CFGetTypeID(value as CFTypeRef)
        if id == CFStringGetTypeID() {
            let s = (value as! CFString) as String
            let trimmed = s.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : s
        }
        if let attributed = value as? NSAttributedString {
            let trimmed = attributed.string.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : attributed.string
        }
        if id == CFNumberGetTypeID() { return "\((value as! NSNumber))" }
        if id == CFBooleanGetTypeID() { return CFBooleanGetValue((value as! CFBoolean)) ? "true" : "false" }
        return nil
    }

    private static func boolValue(_ element: AXUIElement, _ attribute: String) -> Bool? {
        guard let value = rawAttribute(element, attribute) else { return nil }
        if CFGetTypeID(value as CFTypeRef) == CFBooleanGetTypeID() {
            return CFBooleanGetValue((value as! CFBoolean))
        }
        return (value as? NSNumber)?.boolValue
    }

    private static func urlValue(_ element: AXUIElement, _ attribute: String) -> String? {
        guard let value = rawAttribute(element, attribute) else { return nil }
        let id = CFGetTypeID(value as CFTypeRef)
        if id == CFStringGetTypeID(), let s = value as? String {
            let sanitized = sanitize(s)
            return sanitized.isEmpty ? nil : sanitized
        }
        if id == CFURLGetTypeID(), let url = value as? URL {
            let sanitized = sanitize(url.absoluteString)
            return sanitized.isEmpty ? nil : sanitized
        }
        return nil
    }

    private static func selectedTextValue(_ element: AXUIElement) -> String? {
        guard let s = stringValue(element, kAXSelectedTextAttribute) else { return nil }
        let trimmed = s.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func isSettable(_ element: AXUIElement, _ attribute: String) -> Bool {
        var settable = DarwinBoolean(false)
        let err = AXUIElementIsAttributeSettable(element, attribute as CFString, &settable)
        return err == .success && settable.boolValue
    }

    private static func pidOf(_ element: AXUIElement) -> pid_t {
        var pid: pid_t = 0
        AXUIElementGetPid(element, &pid)
        return pid
    }

    /// Global (Quartz, top-left) frame from kAXPosition + kAXSize.
    static func frameRect(_ element: AXUIElement) -> CGRect? {
        guard let origin = axPoint(element, kAXPositionAttribute),
              let size = axSize(element, kAXSizeAttribute) else { return nil }
        return CGRect(origin: origin, size: size)
    }

    private static func axPoint(_ element: AXUIElement, _ attribute: String) -> CGPoint? {
        guard let v = axValue(element, attribute) else { return nil }
        var p = CGPoint.zero
        guard AXValueGetType(v) == .cgPoint, AXValueGetValue(v, .cgPoint, &p) else { return nil }
        return p
    }

    private static func axSize(_ element: AXUIElement, _ attribute: String) -> CGSize? {
        guard let v = axValue(element, attribute) else { return nil }
        var s = CGSize.zero
        guard AXValueGetType(v) == .cgSize, AXValueGetValue(v, .cgSize, &s) else { return nil }
        return s
    }

    private static func axValue(_ element: AXUIElement, _ attribute: String) -> AXValue? {
        guard let value = rawAttribute(element, attribute) else { return nil }
        guard CFGetTypeID(value as CFTypeRef) == AXValueGetTypeID() else { return nil }
        return (value as! AXValue)
    }

    private static func rawAttribute(_ element: AXUIElement, _ attribute: String) -> Any? {
        var value: CFTypeRef?
        let err = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
        guard err == .success, let value else { return nil }
        return value
    }
}
