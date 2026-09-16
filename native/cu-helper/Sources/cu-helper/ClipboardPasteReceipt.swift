import AppKit
import Foundation
import os

enum ClipboardPasteFormat: String, Sendable {
    case text
    case md
    case html

    func promisedData(for text: String) -> [NSPasteboard.PasteboardType: Data] {
        switch self {
        case .text, .md:
            return [.string: Data(text.utf8)]
        case .html:
            let html = Data(text.utf8)
            let plain = (
                try? NSAttributedString(
                    data: html,
                    options: [
                        .documentType: NSAttributedString.DocumentType.html,
                        .characterEncoding: String.Encoding.utf8.rawValue,
                    ],
                    documentAttributes: nil
                ).string
            ) ?? text
            return [.html: html, .string: Data(plain.utf8)]
        }
    }
}

/// Confirms that this pasteboard item's promised bytes were requested and
/// supplied. AppKit does not identify the reader: this is not proof that the
/// intended application's focused field accepted the text.
final class ClipboardPasteReceipt: NSObject, NSPasteboardItemDataProvider, @unchecked Sendable {
    struct Diagnostic: Sendable {
        let status: String
        let pastePosted: Bool
        let dataRequested: Bool
        let dataSupplied: Bool
        let providerFinished: Bool
        let readElapsedMilliseconds: Double?
        let elapsedMilliseconds: Double
        let ownedBeforeRestore: Bool
        let restored: Bool
    }

    private struct State {
        var requested = false
        var suppliedAt: ContinuousClock.Instant?
        var finished = false
    }

    @MainActor private(set) static var lastDiagnostic: Diagnostic?
    private let promisedData: [NSPasteboard.PasteboardType: Data]
    private let state = OSAllocatedUnfairLock(initialState: State())

    var hasSuppliedData: Bool { state.withLock { $0.suppliedAt != nil } }

    init(text: String) {
        promisedData = ClipboardPasteFormat.text.promisedData(for: text)
        super.init()
    }

    init(text: String, format: ClipboardPasteFormat) {
        promisedData = format.promisedData(for: text)
        super.init()
    }

    @MainActor
    static func resetForTurn() {
        lastDiagnostic = nil
    }

    func pasteboard(_ pasteboard: NSPasteboard?, item: NSPasteboardItem, provideDataForType type: NSPasteboard.PasteboardType) {
        guard let data = promisedData[type] else { return }
        state.withLock { $0.requested = true }
        guard item.setData(data, forType: type) else { return }
        state.withLock { value in
            if value.suppliedAt == nil { value.suppliedAt = .now }
        }
    }

    func pasteboardFinishedWithDataProvider(_ pasteboard: NSPasteboard) {
        // Ownership loss also invokes this callback. It is never a read ack.
        state.withLock { $0.finished = true }
    }

    @MainActor
    static func perform(
        text: String,
        format: ClipboardPasteFormat = .text,
        lease: ClipboardLease,
        timeout: Duration = .seconds(2),
        targetPID: pid_t? = nil,
        targetObservation: ClipboardPasteObservation? = nil,
        sendPaste: @MainActor (_ validateBeforePosting: @MainActor () throws -> Void) async throws -> Void
    ) async throws {
        lastDiagnostic = nil
        let started = ContinuousClock.now
        var receipt: ClipboardPasteReceipt?
        var observation: ClipboardPasteObservation?
        var posted = false
        var status = "failed"
        defer {
            observation?.close()
            let owned = lease.temporaryWriteIsCurrent()
            let observed = receipt?.state.withLock { $0 }
            let restored = lease.restoreIfUnchanged()
            lastDiagnostic = Diagnostic(
                status: status,
                pastePosted: posted,
                dataRequested: observed?.requested ?? false,
                dataSupplied: observed?.suppliedAt != nil,
                providerFinished: observed?.finished ?? false,
                readElapsedMilliseconds: observed?.suppliedAt.map {
                    milliseconds(started.duration(to: $0))
                },
                elapsedMilliseconds: milliseconds(started.duration(to: .now)),
                ownedBeforeRestore: owned,
                restored: restored
            )
        }
        do {
            try Task.checkCancellation()
            let target = targetObservation ?? ClipboardPasteObservation.capture(pid: targetPID)
            observation = target
            let written = try lease.writeTemporaryContentWithReceipt(text, format: format)
            receipt = written
            target.arm(written)
            try await Task.sleep(for: .milliseconds(40))
            let validate: @MainActor () throws -> Void = {
                guard lease.temporaryWriteIsCurrent() else {
                    throw CUError("clipboard_changed", "The clipboard changed before paste; no further paste was sent")
                }
            }
            try validate()
            try await sendPaste(validate)
            posted = true
            try await written.waitForRead(timeout: timeout, ownsClipboard: lease.temporaryWriteIsCurrent)
            try await written.waitForTarget(
                target, timeout: timeout, ownsClipboard: lease.temporaryWriteIsCurrent
            )
            guard lease.temporaryWriteIsCurrent() else {
                throw CUError("clipboard_changed", "The clipboard changed after paste data was supplied")
            }
            try Task.checkCancellation()
            status = "completed"
        } catch {
            status = error is CancellationError ? "cancelled" : (error as? CUError)?.code ?? "failed"
            throw error
        }
    }

    /// A promised-data read ends the first stage, but does not identify the
    /// reader. Target observation below guards early clipboard restoration.
    /// After posting, cancellation is surfaced only after this bounded read and
    /// target-consumption interval so that a pending paste keeps its bytes.
    @MainActor
    func waitForRead(timeout: Duration, ownsClipboard: @MainActor () -> Bool) async throws {
        let deadline = ContinuousClock.now.advanced(by: timeout)
        while true {
            guard ownsClipboard() else {
                throw CUError("clipboard_changed", "The clipboard changed while waiting for paste consumption")
            }
            if hasSuppliedData { return }
            let remaining = ContinuousClock.now.duration(to: deadline)
            guard remaining > .zero else {
                try Task.checkCancellation()
                throw CUError("clipboard_read_timeout", "No pasteboard data read was observed within the paste deadline; inspect the target before retrying")
            }
            await Self.pause(for: min(.milliseconds(10), remaining))
        }
    }

    @MainActor
    private func waitForTarget(
        _ observation: ClipboardPasteObservation,
        timeout: Duration,
        ownsClipboard: @MainActor () -> Bool
    ) async throws {
        let deadline = ContinuousClock.now.advanced(by: observation.hasSignals ? timeout : .milliseconds(100))
        while true {
            guard ownsClipboard() else {
                throw CUError("clipboard_changed", "The clipboard changed while waiting for the paste target")
            }
            if observation.hasSignals && observation.hasChanged() { return }
            let remaining = ContinuousClock.now.duration(to: deadline)
            guard remaining > .zero else {
                try Task.checkCancellation()
                guard observation.hasSignals else { return }
                throw CUError("clipboard_target_timeout", "Pasteboard bytes were read, but no change in the target field was observed; inspect the target before retrying")
            }
            await Self.pause(for: min(.milliseconds(25), remaining))
        }
    }

    @MainActor
    private static func pause(for duration: Duration) async {
        let seconds = milliseconds(duration) / 1_000
        guard seconds > 0 else { return }
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            DispatchQueue.main.asyncAfter(deadline: .now() + seconds) {
                continuation.resume()
            }
        }
    }

    private static func milliseconds(_ duration: Duration) -> Double {
        let parts = duration.components
        return Double(parts.seconds) * 1_000 + Double(parts.attoseconds) / 1e15
    }
}

/// The target's AX signals, captured before writing the temporary pasteboard.
/// Tests can supply deterministic signals while keeping real named pasteboards.
@MainActor
struct ClipboardPasteObservation {
    let hasSignals: Bool
    var arm: (ClipboardPasteReceipt) -> Void = { _ in }
    var hasChanged: () -> Bool = { false }
    var close: () -> Void = {}

    static func capture(pid: pid_t?) -> ClipboardPasteObservation {
        guard let pid, pid > 0 else { return ClipboardPasteObservation(hasSignals: false) }
        let target = NativeClipboardPasteObservation(pid: pid)
        return ClipboardPasteObservation(
            hasSignals: target.hasSignals,
            arm: { target.notifications.arm($0) },
            hasChanged: { target.hasChanged() },
            close: { target.close() }
        )
    }

    static func attributesChanged(baseline: [String: CFTypeRef], current: [String: CFTypeRef]) -> Bool {
        guard !baseline.isEmpty, current.count == baseline.count,
              baseline.keys.allSatisfy({ current[$0] != nil }) else { return false }
        return baseline.contains { name, value in
            guard let latest = current[name] else { return false }
            return !CFEqual(value, latest)
        }
    }
}

/// AXObserver's callback only acknowledges this target after the pasteboard is
/// armed and its promised bytes have been supplied. A clipboard observer alone
/// cannot set this flag, and an earlier AX notification is not replayed later.
final class ClipboardPasteNotifications: @unchecked Sendable {
    private struct State {
        var receipt: ClipboardPasteReceipt?
        var changed = false
    }
    private let state = OSAllocatedUnfairLock(initialState: State())

    func arm(_ receipt: ClipboardPasteReceipt) {
        state.withLock { $0.receipt = receipt }
    }

    func recordTargetChange() {
        state.withLock { value in
            if value.receipt?.hasSuppliedData == true { value.changed = true }
        }
    }

    var hasChanged: Bool { state.withLock { $0.changed } }

    func close() {
        state.withLock { $0.receipt = nil }
    }
}

@MainActor
private final class NativeClipboardPasteObservation {
    let notifications = ClipboardPasteNotifications()
    private let focused: AXUIElement?
    private let baseline: [String: CFTypeRef]
    private var observer: AXObserver?
    private var registered: [CFString] = []

    var hasSignals: Bool { !baseline.isEmpty || !registered.isEmpty }

    init(pid: pid_t) {
        let app = AXUIElementCreateApplication(pid)
        var focusedValue: CFTypeRef?
        if AXUIElementCopyAttributeValue(app, kAXFocusedUIElementAttribute as CFString, &focusedValue) == .success,
           let focusedValue, CFGetTypeID(focusedValue) == AXUIElementGetTypeID() {
            let element = unsafeBitCast(focusedValue, to: AXUIElement.self)
            var elementPID: pid_t = 0
            focused = AXUIElementGetPid(element, &elementPID) == .success && elementPID == pid ? element : nil
        } else {
            focused = nil
        }
        guard let focused else {
            baseline = [:]
            return
        }
        var attributeNames: CFArray?
        let names: [String]
        if AXUIElementCopyAttributeNames(focused, &attributeNames) == .success {
            names = attributeNames as? [String] ?? []
        } else {
            names = []
        }
        let attributes = [kAXSelectedTextRangeAttribute, kAXNumberOfCharactersAttribute].filter { names.contains($0) }
        baseline = Self.read(focused, attributes: attributes)

        var created: AXObserver?
        guard AXObserverCreate(pid, { _, _, _, context in
            guard let context else { return }
            Unmanaged<ClipboardPasteNotifications>.fromOpaque(context).takeUnretainedValue().recordTargetChange()
        }, &created) == .success, let created else { return }
        let context = Unmanaged.passUnretained(notifications).toOpaque()
        for name in [kAXSelectedTextChangedNotification, kAXValueChangedNotification] {
            if AXObserverAddNotification(created, focused, name as CFString, context) == .success {
                registered.append(name as CFString)
            }
        }
        if !registered.isEmpty {
            observer = created
            CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(created), .commonModes)
        }
    }

    func hasChanged() -> Bool {
        if notifications.hasChanged { return true }
        guard let focused, !baseline.isEmpty else { return false }
        let current = Self.read(focused, attributes: Array(baseline.keys))
        // Failed AX reads do not confirm consumption.
        return ClipboardPasteObservation.attributesChanged(baseline: baseline, current: current)
    }

    func close() {
        if let observer {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .commonModes)
            if let focused {
                for name in registered { AXObserverRemoveNotification(observer, focused, name) }
            }
        }
        observer = nil
        registered = []
        notifications.close()
    }

    private static func read(_ element: AXUIElement, attributes: [String]) -> [String: CFTypeRef] {
        var result: [String: CFTypeRef] = [:]
        for name in attributes {
            var value: CFTypeRef?
            if AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success, let value {
                result[name] = value
            }
        }
        return result
    }
}
