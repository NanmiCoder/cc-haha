//
//  PermissionCard.swift
//  cu-helper
//
//  Native onboarding card for granting the two TCC permissions Computer Use
//  needs — Accessibility and Screen Recording — WITHOUT the user ever touching
//  a shell. Mirrors Codex's permission window:
//
//    • One row per permission, each with a live "granted / needed" status that
//      polls every second and flips to a green check the instant the grant lands.
//    • A primary "Grant" button that triggers the real OS affordance:
//        - Accessibility   → AXIsProcessTrustedWithOptions(prompt:true), which
//          adds cu-helper to the Accessibility list AND surfaces the system
//          "open System Settings" prompt.
//        - Screen Recording → CGRequestScreenCaptureAccess(), same idea.
//      and then deep-links straight to the exact System Settings pane via the
//      `x-apple.systempreferences:com.apple.preference.security?Privacy_*`
//      anchor (the same scheme Codex uses).
//    • A DRAGGABLE cu-helper icon (NSDraggingSource vending the binary's file
//      URL) so the user can drag it INTO the open Settings list — the exact
//      "DraggableApplicationView" gesture Codex ships, for the case where the
//      one-shot system prompt was already dismissed.
//
//  This window is the daemon/CLI's onboarding face: `cu-helper request-access`.
//  It owns its own NSApplication run loop (it is launched as its own process by
//  the host app / bridge). On close it prints ONE JSON line with the final
//  permission snapshot to stdout so a caller can read the outcome, then exits.
//
//  Nothing here ever posts an input event or moves the cursor; it only reads
//  permission state (Permissions.swift) and opens System Settings.
//

#if canImport(AppKit)
import AppKit
import CoreGraphics
import Foundation

// MARK: - Entry point

@MainActor
enum PermissionCard {

    /// Boots an AppKit app, shows the card, and runs until the user closes it.
    /// Never returns (ends via `NSApp.terminate` → process exit in the window
    /// delegate, which prints the final snapshot line first).
    static func run() -> Never {
        let app = NSApplication.shared
        // `.regular`: the onboarding card is a FOREGROUND window the user clicks
        // and drags from, so it must reliably take focus and appear on whatever
        // Space (including a full-screen app) the user is currently on. An
        // accessory / LSUIElement policy activates unreliably — the window can
        // open behind System Settings or on another Space, which reads to the
        // user as "nothing happened". A brief Dock icon while the card is up is
        // the correct trade for a window the user must see and interact with.
        app.setActivationPolicy(.regular)

        let controller = PermissionCardController()
        // Retain for the process lifetime.
        PermissionCardController.shared = controller
        controller.showWindow()

        app.activate(ignoringOtherApps: true)
        app.run()

        // app.run() only returns on terminate; the delegate already emitted the
        // snapshot + exited, but keep the type checker honest.
        exit(0)
    }
}

// MARK: - Design language
//
// One small place for the card's visual constants so the AppKit card and the
// React settings page (ComputerUseSettings.tsx) stay in lock-step: a neutral
// system base, EXACTLY ONE accent (`.controlAccentColor`), and a two-color
// status scale — systemGreen = granted, systemOrange = needed. No gradients,
// no neon. Corner radii live on a 12–14 grid; separators are hairlines.

@MainActor
private enum CardStyle {
    /// The single accent. Buttons, permission icons, and the focus affordance
    /// all tint from this; nothing else introduces a hue.
    static var accent: NSColor { .controlAccentColor }

    /// Status scale (matches the React page's green/amber).
    static var granted: NSColor { .systemGreen }
    static var needed: NSColor { .systemOrange }

    /// Corner radii (points). Card surface a touch larger than its contents.
    static let cardRadius: CGFloat = 14
    static let panelRadius: CGFloat = 13
    static let boxRadius: CGFloat = 12

    /// Fill for an elevated permission card — a hair lighter than the window
    /// background so, with a soft drop shadow, each one reads as a discrete
    /// raised card (the Codex onboarding look) instead of a flat list row.
    static var cardFill: NSColor { .controlBackgroundColor }
    /// The pill action color when a card is the *next* one to grant.
    static var pillIdle: NSColor { NSColor.quaternaryLabelColor.withAlphaComponent(0.55) }

    /// SF Symbols for the live status (no emoji, ever).
    static let grantedSymbol = "checkmark.circle.fill"
    static let neededSymbol = "exclamationmark.circle.fill"

    static func symbol(_ name: String, pointSize: CGFloat, weight: NSFont.Weight = .regular) -> NSImage? {
        guard let img = NSImage(systemSymbolName: name, accessibilityDescription: nil) else { return nil }
        return img.withSymbolConfiguration(.init(pointSize: pointSize, weight: weight))
    }
}

// MARK: - StatusBadge
//
// The live "granted / needed" pill that replaces the old emoji strings. A small
// colored SF Symbol + a weighted label, tinted from CardStyle's two-color scale.
// One instance per permission row + a standalone copy drives the footer line.

@MainActor
private final class StatusBadge: NSView {

    private let iconView = NSImageView()
    private let textLabel = NSTextField(labelWithString: "")

    /// `compact` (rows) hugs tight; the footer copy reads a hair larger.
    init(compact: Bool = true) {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false

        let pt: CGFloat = compact ? 13 : 14
        iconView.symbolConfiguration = .init(pointSize: pt, weight: .semibold)
        iconView.translatesAutoresizingMaskIntoConstraints = false
        iconView.setContentHuggingPriority(.required, for: .horizontal)
        iconView.setContentCompressionResistancePriority(.required, for: .horizontal)

        textLabel.font = .systemFont(ofSize: compact ? 11.5 : 12.5, weight: .medium)
        textLabel.translatesAutoresizingMaskIntoConstraints = false
        textLabel.setContentHuggingPriority(.required, for: .horizontal)

        let stack = NSStackView(views: [iconView, textLabel])
        stack.orientation = .horizontal
        // Circular status glyphs read best optically centered with the text.
        stack.alignment = .centerY
        stack.spacing = 5
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
        ])
        setContentHuggingPriority(.required, for: .horizontal)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    /// `granted` → green check; otherwise an amber needs-attention mark.
    func update(granted: Bool, text: String) {
        let color = granted ? CardStyle.granted : CardStyle.needed
        iconView.image = NSImage(
            systemSymbolName: granted ? CardStyle.grantedSymbol : CardStyle.neededSymbol,
            accessibilityDescription: nil
        )
        iconView.contentTintColor = color
        textLabel.stringValue = text
        textLabel.textColor = color
    }
}

// MARK: - Permission model

@MainActor
private enum PermissionKind: CaseIterable {
    case accessibility
    case screenRecording

    var title: String {
        switch self {
        case .accessibility:   return "Accessibility"
        case .screenRecording: return "Screen Recording"
        }
    }

    var detail: String {
        switch self {
        case .accessibility:   return "Lets Claude operate app interfaces: click, type, scroll and drag."
        case .screenRecording: return "Lets Claude see the screen: take screenshots to decide where to click."
        }
    }

    /// SF Symbol name (with a safe fallback if unavailable on this OS).
    var symbolName: String {
        switch self {
        case .accessibility:   return "accessibility"
        case .screenRecording: return "rectangle.inset.filled.and.person.filled"
        }
    }

    var fallbackSymbolName: String {
        switch self {
        case .accessibility:   return "hand.point.up.left"
        case .screenRecording: return "rectangle.on.rectangle"
        }
    }

    /// Big white glyph for the card's colored tile — a touch more literal than
    /// `symbolName` (a person for "control the UI", a viewfinder for "capture").
    var tileGlyph: String {
        switch self {
        case .accessibility:   return "accessibility"
        case .screenRecording: return "camera.viewfinder"
        }
    }

    /// Fill behind that glyph. Two cool, harmonious hues (no purple) so the two
    /// permissions read as distinct system capabilities, like the macOS icons.
    var tileColor: NSColor {
        switch self {
        case .accessibility:   return .systemBlue
        case .screenRecording: return .systemTeal
        }
    }

    /// Accessibility uses a circle (mirrors the macOS Accessibility icon);
    /// Screen Recording uses a rounded square.
    var tileIsCircle: Bool {
        switch self {
        case .accessibility:   return true
        case .screenRecording: return false
        }
    }

    /// The `x-apple.systempreferences` anchor that opens this pane directly.
    var settingsAnchor: String {
        switch self {
        case .accessibility:   return "Privacy_Accessibility"
        case .screenRecording: return "Privacy_ScreenCapture"
        }
    }

    /// Prompt shown on the draggable accessory window for this permission.
    var dragPrompt: String {
        switch self {
        case .accessibility:   return "Drag the card below into the list above to allow \"Accessibility\""
        case .screenRecording: return "Drag the card below into the list above to allow \"Screen Recording\""
        }
    }

    /// Live, side-effect-free grant check.
    func isGranted() -> Bool {
        switch self {
        case .accessibility:   return Permissions.accessibilityTrusted(prompt: false)
        // Authoritative (no probe): the card must show THIS binary's real grant,
        // not a value inherited from the launcher or a stale window-title probe.
        case .screenRecording: return Permissions.screenRecordingGrantedAuthoritative()
        }
    }

    /// Trigger the real OS grant affordance (adds cu-helper to the list +
    /// surfaces the system prompt). Safe to call repeatedly.
    func requestViaSystem() {
        switch self {
        case .accessibility:   _ = Permissions.accessibilityTrusted(prompt: true)
        case .screenRecording: Permissions.requestScreenRecording()
        }
    }
}

// MARK: - Controller / window

@MainActor
private final class PermissionCardController: NSObject, NSWindowDelegate {

    static var shared: PermissionCardController?

    private var window: NSWindow!
    private var rows: [PermissionRowView] = []
    /// Latches true the moment both permissions are granted so the courtesy
    /// auto-close (which writes the stdout snapshot + exits) fires exactly once.
    private var didFinish = false
    /// True while the main card is tucked away during an active grant step (the
    /// user is dragging cu-helper into System Settings). It pops back the instant
    /// the accessory retires. See hideMainCard()/showMainCard()/refresh().
    private var mainCardHidden = false
    private var pollTimer: Timer?
    /// The separate floating draggable window (Codex SystemSettingsAccessoryWindow).
    private var dragAccessory: DragAccessoryWindow?

    /// Path to THIS running executable — used to SPAWN the fresh-process probe
    /// (`Process` needs the Mach-O, not the .app bundle).
    static func helperExecutableURL() -> URL {
        if let path = Bundle.main.executablePath {
            return URL(fileURLWithPath: path).resolvingSymlinksInPath()
        }
        return URL(fileURLWithPath: CommandLine.arguments.first ?? "cc-haha-computer-use")
            .resolvingSymlinksInPath()
    }

    /// What the user DRAGS into the Privacy lists. cu-helper ships as a real
    /// `.app` bundle (Screen Recording only grants effective access to a .app
    /// subject, not a bare Mach-O), so when we're running inside one, hand back
    /// the `.app` bundle — TCC keys the grant on the bundle, and the list shows
    /// its name. Falls back to the bare executable for a dev/non-bundled run.
    static func helperDragURL() -> URL {
        let bundleURL = Bundle.main.bundleURL.resolvingSymlinksInPath()
        if bundleURL.pathExtension == "app" {
            return bundleURL
        }
        return helperExecutableURL()
    }

    func showWindow() {
        let helperURL = Self.helperExecutableURL()

        // --- Rows -------------------------------------------------------------
        rows = PermissionKind.allCases.map { kind in
            PermissionRowView(kind: kind, helperURL: helperURL) { [weak self] in
                guard let self else { return }
                // Codex flow: clicking Grant opens Settings, pops the draggable
                // accessory for THIS permission, and TUCKS THE MAIN CARD AWAY so
                // only the accessory remains for the user to drag into the list.
                // The card pops back — updated — the moment the grant lands
                // (see refresh()) or the user taps Cancel (see onCancel below).
                self.dragAccessory?.show(for: kind)
                self.hideMainCard()
                self.scheduleImmediateRefresh()
            }
        }

        // --- Top app mark (centered) -----------------------------------------
        // A single large rounded tile with a white pointer glyph stands in for
        // the app icon and anchors the centered onboarding column (Codex look).
        let appIcon = NSView()
        appIcon.translatesAutoresizingMaskIntoConstraints = false
        appIcon.wantsLayer = true
        appIcon.layer?.backgroundColor = CardStyle.accent.cgColor
        appIcon.layer?.cornerRadius = 16
        let appGlyph = NSImageView()
        appGlyph.image = CardStyle.symbol("cursorarrow.rays", pointSize: 31, weight: .semibold)
            ?? CardStyle.symbol("cursorarrow", pointSize: 31, weight: .semibold)
        appGlyph.contentTintColor = .white
        appGlyph.translatesAutoresizingMaskIntoConstraints = false
        appIcon.addSubview(appGlyph)
        NSLayoutConstraint.activate([
            appIcon.widthAnchor.constraint(equalToConstant: 64),
            appIcon.heightAnchor.constraint(equalToConstant: 64),
            appGlyph.centerXAnchor.constraint(equalTo: appIcon.centerXAnchor),
            appGlyph.centerYAnchor.constraint(equalTo: appIcon.centerYAnchor),
        ])

        // --- Title + subtitle (centered) -------------------------------------
        let title = Self.label("Enable computer control", size: 23, weight: .bold)
        title.alignment = .center
        let subtitle = Self.label(
            "Grant the two items below so Claude can click, type and take screenshots on your computer.\nYour real mouse will not be taken over.",
            size: 13, weight: .regular, color: .secondaryLabelColor
        )
        subtitle.alignment = .center
        subtitle.lineBreakMode = .byWordWrapping
        subtitle.maximumNumberOfLines = 3

        // --- Assemble: a centered column [icon · title · subtitle · cards] ---
        let stack = NSStackView(views: [appIcon, title, subtitle])
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 12
        rows.forEach { stack.addArrangedSubview($0) }
        stack.setCustomSpacing(18, after: appIcon)
        stack.setCustomSpacing(8, after: title)
        stack.setCustomSpacing(26, after: subtitle)
        stack.edgeInsets = NSEdgeInsets(top: 36, left: 40, bottom: 30, right: 40)
        stack.translatesAutoresizingMaskIntoConstraints = false
        // The subtitle + each permission card span the full content width.
        let contentInset: CGFloat = -80
        subtitle.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: contentInset).isActive = true
        for card in rows {
            card.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: contentInset).isActive = true
        }

        let content = NSView()
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: content.topAnchor),
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: content.bottomAnchor),
        ])

        let win = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 560, height: 520),
            styleMask: [.titled, .closable, .miniaturizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        // No title bar text — the content extends under a transparent title bar
        // so only the traffic lights show (clean, centered, Codex-like).
        win.title = ""
        win.titleVisibility = .hidden
        win.titlebarAppearsTransparent = true
        win.isMovableByWindowBackground = true
        win.contentView = content
        win.delegate = self
        win.isReleasedWhenClosed = false
        win.level = .floating          // stay above System Settings so the user
                                       // can drag from this card into the pane.
        // Appear on the CURRENT Space (incl. over a full-screen app) and force
        // to the front even when another app (e.g. System Settings) is active.
        win.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        win.alphaValue = 0          // start hidden for the fade-in below
        // Size the window to fit the centered column exactly (no dead space).
        content.layoutSubtreeIfNeeded()
        win.setContentSize(NSSize(width: 560, height: max(stack.fittingSize.height, 360)))
        win.center()
        win.makeKeyAndOrderFront(nil)
        win.orderFrontRegardless()
        window = win

        // Pop-in animation so the card visibly "appears" rather than blinking.
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.22
            ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
            win.animator().alphaValue = 1
        }

        // The accessory vends the .app BUNDLE for dragging (TCC keys SR on the
        // bundle), while helperURL/helperExecutableURL stays the inner Mach-O for
        // spawning probes.
        dragAccessory = DragAccessoryWindow(fileURL: Self.helperDragURL())
        dragAccessory?.onCancel = { [weak self] in self?.showMainCard() }

        // Test hook (env-gated, no effect in normal use): auto-pop the drag
        // accessory so its render/position can be verified without a click. When
        // CU_HELPER_PREVIEW_GRANT_STEP is also set, additionally tuck the main
        // card away — i.e. reproduce the exact on-screen state right after the
        // user clicks Grant (only the accessory remains), for headless verification.
        if ProcessInfo.processInfo.environment["CU_HELPER_AUTOSHOW_ACCESSORY"] != nil {
            let tuckCard = ProcessInfo.processInfo.environment["CU_HELPER_PREVIEW_GRANT_STEP"] != nil
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
                MainActor.assumeIsolated {
                    self?.dragAccessory?.show(for: .accessibility)
                    if tuckCard { self?.hideMainCard() }
                }
            }
        }

        refresh()
        startPolling()
    }

    // MARK: Status polling

    private func startPolling() {
        let timer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.refresh() }
        }
        RunLoop.main.add(timer, forMode: .common)
        pollTimer = timer
    }

    /// After a button press (which may have opened Settings or popped a prompt)
    /// do a couple of quick extra refreshes so the granted badge appears snappily.
    private func scheduleImmediateRefresh() {
        for delay in [0.3, 0.8, 1.5] {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                MainActor.assumeIsolated { self?.refresh() }
            }
        }
    }

    // MARK: Tuck the card away during a grant step (Codex flow)

    /// Fade the main card out and order it off-screen so ONLY the draggable
    /// accessory remains while the user drops cu-helper into the Settings list.
    private func hideMainCard() {
        guard let window, !mainCardHidden else { return }
        mainCardHidden = true
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = 0.2
            ctx.timingFunction = CAMediaTimingFunction(name: .easeIn)
            window.animator().alphaValue = 0
        }, completionHandler: { [weak window] in window?.orderOut(nil) })
    }

    /// Bring the main card back (already refreshed to the new state by the caller)
    /// once the grant lands or the user cancels the step.
    private func showMainCard() {
        guard let window, mainCardHidden else { return }
        mainCardHidden = false
        window.alphaValue = 0
        window.makeKeyAndOrderFront(nil)
        window.orderFrontRegardless()
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.24
            ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
            window.animator().alphaValue = 1
        }
    }

    private func refresh() {
        // Kick a fresh-process probe for BOTH permissions: a brand-new cu-helper
        // re-reads TCC, so the card detects a just-made grant LIVE. The in-process
        // AXIsProcessTrusted() / CGPreflightScreenCaptureAccess() are read at launch
        // and stay stale-false after a fresh grant (macOS normally needs a relaunch),
        // which is why polling THIS process alone wouldn't flip either card.
        probeFreshPermissionsIfNeeded()

        // The "active" card is the first one still needing a grant — it shows the
        // bright blue pill; any later ungranted card stays a quiet secondary pill,
        // so the user is guided through one permission at a time (Codex behavior).
        var sawUngranted = false
        var grantedCount = 0
        for row in rows {
            let granted = isGranted(row.kind)
            row.updateStatus(granted: granted, active: !granted && !sawUngranted)
            if granted { grantedCount += 1 } else { sawUngranted = true }
        }

        // Retire the drag accessory the moment ITS permission lands. Controller-
        // driven (not the accessory's own check) so the Screen Recording fresh-
        // probe result is honored, not just the stale in-process preflight.
        if let k = dragAccessory?.currentKind, isGranted(k) {
            dragAccessory?.hide()
        }

        // If the card was tucked away for a grant step, bring it back the moment
        // the accessory retires (the permission landed) — now showing the updated
        // state and the NEXT permission to grant (Codex behavior).
        if mainCardHidden, dragAccessory?.currentKind == nil {
            showMainCard()
        }

        // Both granted: let the all-green card rest a beat, then close — which
        // writes the granted snapshot to stdout and exits (see windowWillClose).
        if grantedCount == rows.count, !didFinish {
            didFinish = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.1) { [weak self] in
                MainActor.assumeIsolated { self?.window?.performClose(nil) }
            }
        }
    }

    /// Single source of truth for "is `kind` granted" in the card. For BOTH
    /// permissions the running process's own check (AXIsProcessTrusted /
    /// CGPreflightScreenCaptureAccess) is evaluated at launch and stays STALE-false
    /// after a fresh grant — macOS normally needs a relaunch. So we OR it with a
    /// fresh-process probe, which re-reads TCC in a brand-new process and flips the
    /// instant the user grants, no relaunch (see probeFreshPermissionsIfNeeded).
    private func isGranted(_ kind: PermissionKind) -> Bool {
        if ProcessInfo.processInfo.environment["CU_HELPER_PREVIEW_UNGRANTED"] != nil {
            return false
        }
        switch kind {
        case .accessibility:
            return accessibilityFresh || kind.isGranted()
        case .screenRecording:
            return screenRecordingFresh || kind.isGranted()
        }
    }

    // MARK: Fresh-process permission probe
    //
    // macOS evaluates Accessibility (AXIsProcessTrusted) and Screen Recording
    // (CGPreflightScreenCaptureAccess) for an already-running process at launch and
    // does NOT refresh them live — granting mid-run normally needs a relaunch. So
    // to detect a grant the user JUST made (drag + authenticate), we periodically
    // spawn a brand-new `cu-helper check_permissions` child: a fresh process
    // re-reads TCC and returns the true current state. Each flag latches once true
    // (grants are only added during onboarding, never revoked mid-flow).

    private var accessibilityFresh = false
    private var screenRecordingFresh = false
    private var probeInFlight = false

    /// Spawn the fresh probe (off-main) unless both are already confirmed, one is
    /// already in flight, or we're in layout-preview mode. Updates the caches and
    /// refreshes the moment either permission flips.
    private func probeFreshPermissionsIfNeeded() {
        if accessibilityFresh && screenRecordingFresh { return }
        if probeInFlight { return }
        if ProcessInfo.processInfo.environment["CU_HELPER_PREVIEW_UNGRANTED"] != nil { return }
        let exe = Self.helperExecutableURL()
        probeInFlight = true
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let fresh = Self.runFreshPermissionProbe(exe: exe)
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.probeInFlight = false
                    var changed = false
                    if fresh.accessibility, !self.accessibilityFresh {
                        self.accessibilityFresh = true; changed = true
                    }
                    if fresh.screenRecording, !self.screenRecordingFresh {
                        self.screenRecordingFresh = true; changed = true
                    }
                    if changed { self.refresh() }   // reflect the live grant immediately
                }
            }
        }
    }

    /// Run `cu-helper check_permissions` and parse `{accessibility, screenRecording}`
    /// from a brand-new process. Fail-closed on any error. Off-main; ~40 ms typical.
    private nonisolated static func runFreshPermissionProbe(
        exe: URL
    ) -> (accessibility: Bool, screenRecording: Bool) {
        let proc = Process()
        proc.executableURL = exe
        proc.arguments = ["check_permissions", "--payload", "{}"]
        // CRITICAL: this card is ITSELF a disclaimed child, so its environment
        // carries CU_HELPER_DISCLAIMED=1. If the probe child inherits that flag it
        // SKIPS its own disclaim re-exec and never becomes its own TCC responsible
        // process — which makes Screen Recording read false even when granted
        // (Accessibility tolerates the inherited responsibility, Screen Recording
        // does NOT). Scrub the flag so the child re-execs + disclaims fresh and
        // reads the live grant exactly like a brand-new top-level launch.
        var env = ProcessInfo.processInfo.environment
        env.removeValue(forKey: "CU_HELPER_DISCLAIMED")
        proc.environment = env
        let out = Pipe()
        proc.standardOutput = out
        proc.standardError = FileHandle.nullDevice
        do {
            try proc.run()
        } catch {
            return (false, false)
        }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        proc.waitUntilExit()
        guard
            let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let result = obj["result"] as? [String: Any]
        else {
            return (false, false)
        }
        return (
            (result["accessibility"] as? Bool) ?? false,
            (result["screenRecording"] as? Bool) ?? false
        )
    }

    // MARK: Actions

    // (No explicit "Done" button anymore — the card auto-closes once both
    // permissions are granted, and the user can dismiss early via the close
    // button. See refresh().)

    // MARK: NSWindowDelegate

    func windowWillClose(_ notification: Notification) {
        pollTimer?.invalidate()
        pollTimer = nil
        // Emit the final snapshot so a spawning bridge can read the outcome,
        // then exit. Permissions.snapshot() is {accessibility, screenRecording}.
        var line = Envelope.ok(Permissions.snapshot()).line()
        if line.last != UInt8(ascii: "\n") { line.append(UInt8(ascii: "\n")) }
        line.withUnsafeBytes { raw in
            guard let base = raw.baseAddress else { return }
            var off = 0
            while off < raw.count {
                let n = write(STDOUT_FILENO, base.advanced(by: off), raw.count - off)
                if n <= 0 { if errno == EINTR { continue }; break }
                off += n
            }
        }
        NSApp.terminate(nil)
    }

    // MARK: Small view helpers

    static func label(
        _ text: String,
        size: CGFloat,
        weight: NSFont.Weight,
        color: NSColor = .labelColor
    ) -> NSTextField {
        let l = NSTextField(labelWithString: text)
        l.font = .systemFont(ofSize: size, weight: weight)
        l.textColor = color
        l.translatesAutoresizingMaskIntoConstraints = false
        return l
    }

    static func separator() -> NSBox {
        let b = NSBox()
        b.boxType = .separator
        b.translatesAutoresizingMaskIntoConstraints = false
        return b
    }

    /// Wrap the permission rows in one rounded, hairline-bordered surface with
    /// thin dividers between them — a single "grant these" block instead of two
    /// floating rows. Returns a full-width container view.
    static func groupedRows(_ rows: [PermissionRowView]) -> NSView {
        var stackViews: [NSView] = []
        for (i, row) in rows.enumerated() {
            stackViews.append(row)
            if i < rows.count - 1 { stackViews.append(separator()) }
        }
        let inner = NSStackView(views: stackViews)
        inner.orientation = .vertical
        inner.alignment = .leading
        inner.spacing = 0
        inner.translatesAutoresizingMaskIntoConstraints = false
        // Rows draw their own vertical padding; only inset horizontally here.
        for v in stackViews {
            v.leadingAnchor.constraint(equalTo: inner.leadingAnchor, constant: 14).isActive = true
            v.trailingAnchor.constraint(equalTo: inner.trailingAnchor, constant: -14).isActive = true
        }

        let box = NSView()
        box.translatesAutoresizingMaskIntoConstraints = false
        box.wantsLayer = true
        box.layer?.backgroundColor = NSColor.quaternaryLabelColor.withAlphaComponent(0.07).cgColor
        box.layer?.cornerRadius = CardStyle.boxRadius
        box.layer?.borderWidth = 1
        box.layer?.borderColor = NSColor.separatorColor.withAlphaComponent(0.6).cgColor
        box.addSubview(inner)
        NSLayoutConstraint.activate([
            inner.topAnchor.constraint(equalTo: box.topAnchor),
            inner.bottomAnchor.constraint(equalTo: box.bottomAnchor),
            inner.leadingAnchor.constraint(equalTo: box.leadingAnchor),
            inner.trailingAnchor.constraint(equalTo: box.trailingAnchor),
        ])
        return box
    }
}

// MARK: - PermissionRowView

@MainActor
private final class PermissionRowView: NSView {

    let kind: PermissionKind
    private let pill = PillButton(title: "Grant")
    private let doneBadge = StatusBadge(compact: true)
    private let onAction: () -> Void

    init(kind: PermissionKind, helperURL: URL, onAction: @escaping () -> Void) {
        self.kind = kind
        self.onAction = onAction
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false

        // Card surface — a lightly raised rounded rectangle with a soft drop
        // shadow, so each permission reads as its own discrete card (not a row).
        wantsLayer = true
        layer?.backgroundColor = CardStyle.cardFill.cgColor
        layer?.cornerRadius = 16
        layer?.shadowColor = NSColor.black.cgColor
        layer?.shadowOpacity = 0.10
        layer?.shadowRadius = 10
        layer?.shadowOffset = CGSize(width: 0, height: -2)
        layer?.masksToBounds = false

        // Colorful permission glyph — a filled circle (Accessibility, echoing the
        // macOS icon) or a rounded tile (Screen Recording), white symbol inside.
        let icon = NSImageView()
        icon.image = (CardStyle.symbol(kind.tileGlyph, pointSize: 22, weight: .semibold)
            ?? CardStyle.symbol(kind.symbolName, pointSize: 22, weight: .semibold)
            ?? CardStyle.symbol(kind.fallbackSymbolName, pointSize: 22, weight: .semibold))
        icon.contentTintColor = .white
        icon.translatesAutoresizingMaskIntoConstraints = false

        let tile = NSView()
        tile.translatesAutoresizingMaskIntoConstraints = false
        tile.wantsLayer = true
        tile.layer?.backgroundColor = kind.tileColor.cgColor
        tile.layer?.cornerRadius = kind.tileIsCircle ? 24 : 13
        tile.addSubview(icon)
        tile.setContentHuggingPriority(.required, for: .horizontal)
        NSLayoutConstraint.activate([
            tile.widthAnchor.constraint(equalToConstant: 48),
            tile.heightAnchor.constraint(equalToConstant: 48),
            icon.centerXAnchor.constraint(equalTo: tile.centerXAnchor),
            icon.centerYAnchor.constraint(equalTo: tile.centerYAnchor),
        ])

        // Title + detail
        let title = PermissionCardController.label(kind.title, size: 14.5, weight: .semibold)
        let detail = PermissionCardController.label(kind.detail, size: 12, weight: .regular, color: .secondaryLabelColor)
        detail.lineBreakMode = .byWordWrapping
        detail.maximumNumberOfLines = 2
        let textStack = NSStackView(views: [title, detail])
        textStack.orientation = .vertical
        textStack.alignment = .leading
        textStack.spacing = 3

        // Trailing: the action pill while pending; a green "Granted" badge once
        // granted. Exactly one is visible at a time (toggled in updateStatus).
        pill.target = self
        pill.action = #selector(onGrant)
        pill.setContentHuggingPriority(.required, for: .horizontal)
        doneBadge.update(granted: true, text: "Granted")
        doneBadge.isHidden = true
        doneBadge.setContentHuggingPriority(.required, for: .horizontal)

        let row = NSStackView(views: [tile, textStack, NSView(), pill, doneBadge])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 14
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)
        NSLayoutConstraint.activate([
            row.topAnchor.constraint(equalTo: topAnchor, constant: 16),
            row.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -16),
            row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 18),
            row.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -18),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    /// `granted` flips the pill to a green badge; `active` (the first pending
    /// card) gets the bright blue pill, later pending cards a quiet secondary.
    func updateStatus(granted: Bool, active: Bool) {
        if granted {
            pill.isHidden = true
            doneBadge.isHidden = false
        } else {
            doneBadge.isHidden = true
            pill.isHidden = false
            pill.apply(style: active ? .primary : .secondary)
        }
    }

    @objc private func onGrant() {
        // 1) Trigger the real OS affordance (adds cu-helper to the list + prompt).
        kind.requestViaSystem()
        // 2) Deep-link straight to the exact System Settings pane.
        openSettingsPane(anchor: kind.settingsAnchor)
        onAction()
    }

    private func openSettingsPane(anchor: String) {
        let candidates = [
            "x-apple.systempreferences:com.apple.preference.security?\(anchor)",
            "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?\(anchor)",
        ]
        for s in candidates {
            if let url = URL(string: s), NSWorkspace.shared.open(url) { return }
        }
    }
}

// MARK: - PillButton

/// A compact, fully-rounded action button — the solid-blue "Grant" pill on each
/// permission card. Custom-drawn (layer fill + attributed white title) because
/// a stock `NSButton` bezel can't render a clean solid pill with white text.
@MainActor
private final class PillButton: NSButton {
    enum Style { case primary, secondary }

    private let pillTitle: String

    init(title: String) {
        self.pillTitle = title
        super.init(frame: .zero)
        self.title = ""
        isBordered = false
        bezelStyle = .regularSquare
        focusRingType = .none
        setButtonType(.momentaryChange)
        wantsLayer = true
        translatesAutoresizingMaskIntoConstraints = false
        layer?.cornerRadius = 15
        heightAnchor.constraint(equalToConstant: 30).isActive = true
        apply(style: .primary)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    /// `.primary` = the bright accent pill (the next permission to grant);
    /// `.secondary` = a quiet neutral pill (a later, still-pending permission).
    func apply(style: Style) {
        let fg: NSColor
        let bg: NSColor
        switch style {
        case .primary:   fg = .white;               bg = CardStyle.accent
        case .secondary: fg = .secondaryLabelColor; bg = CardStyle.pillIdle
        }
        attributedTitle = NSAttributedString(string: pillTitle, attributes: [
            .foregroundColor: fg,
            .font: NSFont.systemFont(ofSize: 13, weight: .semibold),
        ])
        layer?.backgroundColor = bg.cgColor
    }

    // A touch of horizontal padding so the title sits comfortably in the pill.
    override var intrinsicContentSize: NSSize {
        let base = super.intrinsicContentSize
        return NSSize(width: base.width + 34, height: 30)
    }

    // Tactile press feedback: briefly dim while the mouse is held (super.mouseDown
    // runs the tracking loop and fires the action on release-inside).
    override func mouseDown(with event: NSEvent) {
        layer?.opacity = 0.8
        super.mouseDown(with: event)
        layer?.opacity = 1.0
    }
}

// MARK: - DraggableHelperIconView
//
// The exact "drag the app into the Settings list" gesture Codex ships
// (`DraggableApplicationView`): an NSImageView that is an NSDraggingSource
// vending the cu-helper binary's FILE URL. Dropping it onto the System Settings
// Accessibility / Screen Recording list adds cu-helper to that list.

@MainActor
private final class DraggableHelperIconView: NSImageView, NSDraggingSource {

    private let fileURL: URL

    init(fileURL: URL, side: CGFloat) {
        self.fileURL = fileURL
        super.init(frame: NSRect(x: 0, y: 0, width: side, height: side))
        translatesAutoresizingMaskIntoConstraints = false
        widthAnchor.constraint(equalToConstant: side).isActive = true
        heightAnchor.constraint(equalToConstant: side).isActive = true
        // Use the binary's own Finder icon so what the user drags visually
        // matches what appears in the Settings list.
        image = NSWorkspace.shared.icon(forFile: fileURL.path)
        imageScaling = .scaleProportionallyUpOrDown
        toolTip = "Drag me into the list under System Settings ▸ Privacy & Security ▸ Accessibility / Screen Recording"
        unregisterDraggedTypes()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func mouseDown(with event: NSEvent) {
        let item = NSDraggingItem(pasteboardWriter: fileURL as NSURL)
        let dragImage = image ?? NSImage()
        item.setDraggingFrame(bounds, contents: dragImage)
        beginDraggingSession(with: [item], event: event, source: self)
    }

    func draggingSession(
        _ session: NSDraggingSession,
        sourceOperationMaskFor context: NSDraggingContext
    ) -> NSDragOperation {
        // `.copy` is what the Settings list accepts for "add this app".
        return [.copy, .generic]
    }
}

// MARK: - AccessoryPanel
//
// A `.borderless` NSPanel returns `canBecomeKey == false` by default, so an
// NSButton inside it (the "‹" back button) never fires — the first click is
// swallowed trying to make a window that can't become key, and the panel feels
// "frozen" on hover. Overriding `canBecomeKey` lets the button (and any control)
// receive clicks. It stays a `.nonactivatingPanel`, so becoming key does NOT
// activate our app or steal focus from System Settings, and dragging the card
// into the Settings list still works.
@MainActor
private final class AccessoryPanel: NSPanel {
    override var canBecomeKey: Bool { true }
}

// MARK: - DragAccessoryWindow
//
// Codex's `SystemSettingsAccessoryWindow`: a SEPARATE floating window that pops
// next to the open System Settings pane with a big draggable cu-helper icon, so
// the user drags it straight INTO the Accessibility / Screen Recording list — no
// manual clicking. Re-targets per permission, animates in (fade + slide), and
// retires itself the instant that permission is granted.

@MainActor
private final class DragAccessoryWindow: NSObject {

    private let fileURL: URL
    private var panel: NSPanel?
    private var promptLabel: NSTextField?
    private weak var arrowView: NSImageView?
    private(set) var currentKind: PermissionKind?
    /// Invoked when the user backs out of a grant step via "Cancel" — lets the
    /// controller bring the (currently hidden) main card back. Set by the owner.
    var onCancel: (() -> Void)?

    init(fileURL: URL) {
        self.fileURL = fileURL
        super.init()
    }

    @objc private func onCancelClicked() {
        hide()
        onCancel?()
    }

    /// Pop the accessory for `kind` next to System Settings, animated.
    func show(for kind: PermissionKind) {
        currentKind = kind
        ensurePanel()
        guard let panel else { return }
        promptLabel?.stringValue = kind.dragPrompt

        position(panel)
        startArrowBounce()
        let target = panel.frame.origin
        // Start lower + transparent, then fade + slide up into place (it lives at
        // the BOTTOM of the Settings window; the up-arrow points into the list).
        panel.alphaValue = 0
        panel.setFrameOrigin(NSPoint(x: target.x, y: target.y - 18))
        panel.orderFrontRegardless()
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.28
            ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
            panel.animator().alphaValue = 1
            panel.animator().setFrameOrigin(target)
        }
    }

    // (Retiring the accessory is controller-driven now — see refresh(), which
    // honors the Screen Recording fresh-process probe, not just the in-process
    // preflight. The accessory just exposes `currentKind` + `hide()`.)

    func hide() {
        currentKind = nil
        guard let panel else { return }
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = 0.16
            panel.animator().alphaValue = 0
        }, completionHandler: { [weak panel] in panel?.orderOut(nil) })
    }

    /// Perpetual gentle bounce of the up-arrow toward the list above.
    private func startArrowBounce() {
        guard let layer = arrowView?.layer else { return }
        layer.removeAnimation(forKey: "bounce")
        let bounce = CABasicAnimation(keyPath: "transform.translation.y")
        bounce.fromValue = 0
        bounce.toValue = 9            // NSView layer is y-up → positive = upward
        bounce.duration = 0.6
        bounce.autoreverses = true
        bounce.repeatCount = .infinity
        bounce.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        layer.add(bounce, forKey: "bounce")
    }

    // MARK: Build

    private func ensurePanel() {
        if panel != nil { return }

        // --- Row 1: a big, bold, BLUE up-arrow + the action line. The arrow is
        // the prominent "drag upward into the list" cue (Codex). ---
        let arrow = NSImageView()
        arrow.image = CardStyle.symbol("arrow.up", pointSize: 30, weight: .heavy)
            ?? CardStyle.symbol("arrow.up", pointSize: 30, weight: .bold)
        arrow.contentTintColor = CardStyle.accent
        arrow.wantsLayer = true
        arrow.translatesAutoresizingMaskIntoConstraints = false
        arrow.setContentHuggingPriority(.required, for: .horizontal)
        arrow.widthAnchor.constraint(equalToConstant: 40).isActive = true
        arrow.heightAnchor.constraint(equalToConstant: 40).isActive = true
        arrowView = arrow

        // The action line (set per-permission in show()): names the app + says
        // "card" (drag the whole card), e.g. "Drag this \"cc-haha-computer-use\" card to…".
        let prompt = PermissionCardController.label("Drag the card below into the list above", size: 13, weight: .medium)
        prompt.lineBreakMode = .byWordWrapping
        prompt.maximumNumberOfLines = 2
        prompt.preferredMaxLayoutWidth = 420
        prompt.setContentHuggingPriority(.defaultLow, for: .horizontal)
        promptLabel = prompt

        let topRow = NSStackView(views: [arrow, prompt])
        topRow.orientation = .horizontal
        topRow.alignment = .centerY
        topRow.spacing = 12
        topRow.translatesAutoresizingMaskIntoConstraints = false

        // --- Row 2: brand tile + the helper's name. PURE VISUAL — the WHOLE card
        // (both rows) is the single drag source, not this row alone. ---
        let appRow = Self.makeAppRow(fileURL: fileURL)

        let content = NSStackView(views: [topRow, appRow])
        content.orientation = .vertical
        content.alignment = .leading
        content.spacing = 12
        content.edgeInsets = NSEdgeInsets(top: 16, left: 18, bottom: 16, right: 18)
        content.translatesAutoresizingMaskIntoConstraints = false

        // --- The ENTIRE card is one drag source + hover-activates as one unit ---
        let card = DraggableCardView(fileURL: fileURL)
        card.addSubview(content)
        NSLayoutConstraint.activate([
            content.topAnchor.constraint(equalTo: card.topAnchor),
            content.bottomAnchor.constraint(equalTo: card.bottomAnchor),
            content.leadingAnchor.constraint(equalTo: card.leadingAnchor),
            content.trailingAnchor.constraint(equalTo: card.trailingAnchor),
            topRow.widthAnchor.constraint(equalTo: content.widthAnchor, constant: -36),
            appRow.widthAnchor.constraint(equalTo: content.widthAnchor, constant: -36),
        ])

        // --- Circular "‹" back button OUTSIDE the card, to its LEFT (Codex). As a
        // sibling (not a child) of the card it's naturally excluded from the
        // card's drag/hover; clicking it just bows out of the grant step. ---
        let back = NSButton(title: "", target: self, action: #selector(onCancelClicked))
        back.isBordered = false
        back.bezelStyle = .regularSquare
        back.focusRingType = .none
        back.image = CardStyle.symbol("chevron.left", pointSize: 14, weight: .semibold)
        back.imagePosition = .imageOnly
        back.contentTintColor = .secondaryLabelColor
        back.wantsLayer = true
        back.layer?.backgroundColor = NSColor.quaternaryLabelColor.withAlphaComponent(0.5).cgColor
        back.layer?.cornerRadius = 16
        back.translatesAutoresizingMaskIntoConstraints = false
        back.toolTip = "Back"
        back.setContentHuggingPriority(.required, for: .horizontal)
        NSLayoutConstraint.activate([
            back.widthAnchor.constraint(equalToConstant: 32),
            back.heightAnchor.constraint(equalToConstant: 32),
        ])

        let outer = NSStackView(views: [back, card])
        outer.orientation = .horizontal
        outer.alignment = .centerY
        outer.spacing = 12
        outer.translatesAutoresizingMaskIntoConstraints = false

        let container = NSView()
        container.addSubview(outer)
        NSLayoutConstraint.activate([
            outer.topAnchor.constraint(equalTo: container.topAnchor, constant: 8),
            outer.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -8),
            outer.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 14),
            outer.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -14),
        ])

        let p = AccessoryPanel(
            contentRect: NSRect(x: 0, y: 0, width: 600, height: 150),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        p.isFloatingPanel = true
        p.level = .floating
        p.backgroundColor = .clear
        p.isOpaque = false
        p.hasShadow = true
        p.isMovableByWindowBackground = false   // we position it; the card owns the drag
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        p.contentView = container
        panel = p
    }

    /// Row 2 of the card: brand tile + the helper's file name + a grip hint.
    /// Pure visual — drag/hover live on the enclosing DraggableCardView.
    private static func makeAppRow(fileURL: URL) -> NSView {
        let iconGlyph = NSImageView()
        iconGlyph.image = CardStyle.symbol("cursorarrow.rays", pointSize: 15, weight: .semibold)
            ?? CardStyle.symbol("cursorarrow", pointSize: 15, weight: .semibold)
        iconGlyph.contentTintColor = .white
        iconGlyph.translatesAutoresizingMaskIntoConstraints = false
        let icon = NSView()
        icon.translatesAutoresizingMaskIntoConstraints = false
        icon.wantsLayer = true
        icon.layer?.backgroundColor = CardStyle.accent.cgColor
        icon.layer?.cornerRadius = 7
        icon.addSubview(iconGlyph)
        icon.setContentHuggingPriority(.required, for: .horizontal)
        NSLayoutConstraint.activate([
            icon.widthAnchor.constraint(equalToConstant: 30),
            icon.heightAnchor.constraint(equalToConstant: 30),
            iconGlyph.centerXAnchor.constraint(equalTo: icon.centerXAnchor),
            iconGlyph.centerYAnchor.constraint(equalTo: icon.centerYAnchor),
        ])

        let name = PermissionCardController.label(fileURL.lastPathComponent, size: 13, weight: .semibold)

        let grip = NSImageView()
        grip.image = CardStyle.symbol("line.3.horizontal", pointSize: 13, weight: .regular)
        grip.contentTintColor = .tertiaryLabelColor
        grip.translatesAutoresizingMaskIntoConstraints = false
        grip.setContentHuggingPriority(.required, for: .horizontal)

        let row = NSStackView(views: [icon, name, NSView(), grip])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 11
        row.translatesAutoresizingMaskIntoConstraints = false
        return row
    }

    // MARK: Positioning

    /// Place the accessory at the BOTTOM of the System Settings window, centered
    /// and wide, so the up-arrow points into the permission list above (Codex's
    /// layout). Falls back to the bottom-center of the main screen.
    private func position(_ panel: NSPanel) {
        if let settings = Self.systemSettingsFrameCocoa() {
            let w = min(max(settings.width - 24, 420), 660)
            panel.setContentSize(NSSize(width: w, height: panel.frame.height))
            let x = settings.midX - w / 2
            let y = settings.minY + 12      // sit at the bottom edge, arrow up into the list
            panel.setFrameOrigin(NSPoint(x: x, y: y))
        } else if let screen = NSScreen.main {
            let f = screen.visibleFrame
            panel.setFrameOrigin(NSPoint(x: f.midX - panel.frame.width / 2, y: f.minY + 48))
        } else {
            panel.center()
        }
    }

    /// Current on-screen frame of the System Settings window, in Cocoa space.
    private static func systemSettingsFrameCocoa() -> NSRect? {
        let pids = NSWorkspace.shared.runningApplications
            .filter { $0.bundleIdentifier == "com.apple.systempreferences" }
            .map { $0.processIdentifier }
        guard !pids.isEmpty else { return nil }

        let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
        guard let infos = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]]
        else { return nil }

        var best: CGRect?
        var bestArea: CGFloat = 0
        for info in infos {
            guard let pid = info[kCGWindowOwnerPID as String] as? pid_t, pids.contains(pid) else { continue }
            let layer = (info[kCGWindowLayer as String] as? Int) ?? 0
            guard layer == 0 else { continue }
            guard let bounds = info[kCGWindowBounds as String] as? [String: Any],
                  let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary),
                  !rect.isEmpty else { continue }
            let area = rect.width * rect.height
            if area > bestArea { bestArea = area; best = rect }
        }
        guard let quartz = best else { return nil }
        // Quartz (top-left, y-down) → Cocoa (bottom-left, y-up), flip about the
        // primary screen height.
        let primaryHeight = NSScreen.screens.first?.frame.height
            ?? CGDisplayBounds(CGMainDisplayID()).height
        return NSRect(x: quartz.minX,
                      y: primaryHeight - quartz.minY - quartz.height,
                      width: quartz.width,
                      height: quartz.height)
    }
}

// MARK: - DraggableCardView
//
// The ENTIRE accessory card is ONE drag source: pressing anywhere on it begins
// dragging the cu-helper file URL UP into the Settings list, and the whole card
// lights up on hover (Codex's "grab the whole card" affordance). Its content
// (the big-arrow row + the app row) is added by ensurePanel — this view owns
// only the card surface, the hover state, and the whole-card drag snapshot. The
// "‹" back button is a SIBLING (outside this view), so it's naturally excluded
// from the card's drag/hover; clicking it just bows out of the grant step.

@MainActor
private final class DraggableCardView: NSView, NSDraggingSource {

    private let fileURL: URL
    private var hovering = false

    init(fileURL: URL) {
        self.fileURL = fileURL
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        wantsLayer = true
        layer?.cornerRadius = CardStyle.panelRadius
        layer?.borderWidth = 1.5
        toolTip = "Drag the whole card into the list above"
        applyHover(false)

        // Test hook (env-gated, no effect in normal use): force the activated look
        // so the hover styling can be screenshotted headlessly.
        if ProcessInfo.processInfo.environment["CU_HELPER_PREVIEW_HOVER"] != nil {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
                MainActor.assumeIsolated { self?.applyHover(true) }
            }
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    // Begin the drag on the FIRST click even when the (non-activating) panel
    // isn't yet key — otherwise the first press is wasted just focusing the panel
    // and the card feels unresponsive.
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    // MARK: Hover — the whole card activates; the cursor becomes a hand.

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        for area in trackingAreas { removeTrackingArea(area) }
        addTrackingArea(NSTrackingArea(
            rect: bounds,
            options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
            owner: self,
            userInfo: nil
        ))
    }

    override func mouseEntered(with event: NSEvent) {
        hovering = true
        applyHover(true)
        NSCursor.openHand.set()
    }

    override func mouseExited(with event: NSEvent) {
        hovering = false
        applyHover(false)
        NSCursor.arrow.set()
    }

    /// Resting vs. activated styling — activated = accent-tinted fill + accent
    /// border so the WHOLE card "lights up" as one grabbable unit.
    private func applyHover(_ on: Bool) {
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.14
            ctx.allowsImplicitAnimation = true
            if on {
                layer?.backgroundColor = CardStyle.accent.withAlphaComponent(0.15).cgColor
                layer?.borderColor = CardStyle.accent.withAlphaComponent(0.9).cgColor
            } else {
                layer?.backgroundColor = NSColor.windowBackgroundColor.withAlphaComponent(0.98).cgColor
                layer?.borderColor = NSColor.separatorColor.cgColor
            }
        }
    }

    // MARK: Drag — the whole card travels (drag preview = a snapshot of self, not
    // a bare icon), so the user literally sees the card lift off into the list.

    override func mouseDown(with event: NSEvent) {
        NSCursor.closedHand.set()
        let item = NSDraggingItem(pasteboardWriter: fileURL as NSURL)
        item.setDraggingFrame(bounds, contents: cardSnapshot())
        beginDraggingSession(with: [item], event: event, source: self)
    }

    private func cardSnapshot() -> NSImage {
        guard bounds.width > 1, bounds.height > 1,
              let rep = bitmapImageRepForCachingDisplay(in: bounds) else {
            return NSWorkspace.shared.icon(forFile: fileURL.path)
        }
        cacheDisplay(in: bounds, to: rep)
        let img = NSImage(size: bounds.size)
        img.addRepresentation(rep)
        return img
    }

    func draggingSession(
        _ session: NSDraggingSession,
        sourceOperationMaskFor context: NSDraggingContext
    ) -> NSDragOperation {
        [.copy, .generic]
    }

    func draggingSession(
        _ session: NSDraggingSession,
        endedAt screenPoint: NSPoint,
        operation: NSDragOperation
    ) {
        applyHover(hovering)
        (hovering ? NSCursor.openHand : NSCursor.arrow).set()
    }
}

#endif
