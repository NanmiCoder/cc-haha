import ApplicationServices
import CoreGraphics
import Darwin
import Foundation

/// Which on-screen window owns a global point, and where that window sits.
///
/// Needed because a synthesized mouse event must name the window it targets
/// (see WindowTargetedEvent) — and the only way to know that from a bare
/// coordinate is to ask the window server.
///
/// Reads `kCGWindowBounds` / `kCGWindowNumber` / `kCGWindowOwnerPID` only.
/// Window *names* would require Screen Recording; these three do not, so this
/// works before any capture grant exists.
enum WindowGeometry {
    private typealias GetAXWindow = @convention(c) (
        AXUIElement, UnsafeMutablePointer<CGWindowID>
    ) -> AXError

    private static let getAXWindow: GetAXWindow? = {
        guard let handle = dlopen(nil, RTLD_LAZY),
              let symbol = dlsym(handle, "_AXUIElementGetWindow") else { return nil }
        return unsafeBitCast(symbol, to: GetAXWindow.self)
    }()

    /// Read the window's identity directly. AX and WindowServer titles are
    /// presentation strings and need not agree (Chrome decorates its AX title).
    /// Callers must still validate this ID against the target process's live
    /// windows. An unavailable SPI falls back to the existing evidence rules.
    static func axWindowID(of element: AXUIElement) -> CGWindowID? {
        var id: CGWindowID = 0
        guard let getAXWindow,
              getAXWindow(element, &id) == .success,
              id != kCGNullWindowID else { return nil }
        return id
    }

    struct Window: Equatable, Sendable {
        let id: CGWindowID
        let bounds: CGRect
        let ownerPid: pid_t
    }

    /// Revalidate the original window after an async focus/pacing boundary;
    /// never replace it with whichever window is currently above the pointer.
    static func window(
        id: CGWindowID, pid: pid_t,
        windowList: () -> [[CFString: Any]]? = systemWindowList
    ) -> Window? {
        guard let list = windowList(),
              let info = list.first(where: {
                ($0[kCGWindowNumber] as? Int) == Int(id)
                    && ($0[kCGWindowOwnerPID] as? pid_t) == pid
                    && ($0[kCGWindowLayer] as? Int) == 0
              }),
              let raw = info[kCGWindowBounds] as? [String: CGFloat],
              let x = raw["X"], let y = raw["Y"],
              let width = raw["Width"], let height = raw["Height"],
              x.isFinite, y.isFinite, width.isFinite, height.isFinite,
              width > 0, height > 0 else { return nil }
        let bounds = CGRect(x: x, y: y, width: width, height: height)
        return Window(id: id, bounds: bounds, ownerPid: pid)
    }

    /// Front-most ordinary window containing `point`.
    ///
    /// - Parameter pid: when given, only that process's windows are considered.
    ///   Actuation always knows its target, and honouring it keeps a floating
    ///   panel from another app from stealing the binding — which would address
    ///   the event to a window the target does not own, i.e. drop it.
    static func window(
        at point: CGPoint,
        pid: pid_t? = nil,
        windowList: () -> [[CFString: Any]]? = systemWindowList
    ) -> Window? {
        guard let list = windowList() else { return nil }
        for info in list {
            // Layer 0 only: skips overlays, the menu bar, the Dock and the
            // desktop, none of which can receive an app-directed click.
            guard let layer = info[kCGWindowLayer] as? Int, layer == 0,
                  let number = info[kCGWindowNumber] as? Int,
                  let owner = info[kCGWindowOwnerPID] as? pid_t,
                  let raw = info[kCGWindowBounds] as? [String: CGFloat] else {
                continue
            }
            if let pid, owner != pid { continue }

            let bounds = CGRect(
                x: raw["X"] ?? 0,
                y: raw["Y"] ?? 0,
                width: raw["Width"] ?? 0,
                height: raw["Height"] ?? 0
            )
            guard !bounds.isEmpty, bounds.contains(point) else { continue }
            return Window(id: CGWindowID(number), bounds: bounds, ownerPid: owner)
        }
        return nil
    }

    /// The frontmost ordinary window belonging to `pid`, if it has one on
    /// screen. Needed before a capture, when the window ID the snapshot will
    /// publish is not known yet.
    static func frontmostWindow(
        pid: pid_t,
        windowList: () -> [[CFString: Any]]? = systemWindowList
    ) -> Window? {
        guard let list = windowList() else { return nil }
        for info in list {
            guard let layer = info[kCGWindowLayer] as? Int, layer == 0,
                  let number = info[kCGWindowNumber] as? Int,
                  let owner = info[kCGWindowOwnerPID] as? pid_t, owner == pid,
                  let raw = info[kCGWindowBounds] as? [String: CGFloat] else {
                continue
            }
            let bounds = CGRect(
                x: raw["X"] ?? 0,
                y: raw["Y"] ?? 0,
                width: raw["Width"] ?? 0,
                height: raw["Height"] ?? 0
            )
            if bounds.isEmpty { continue }
            return Window(id: CGWindowID(number), bounds: bounds, ownerPid: owner)
        }
        return nil
    }

    /// Is every pixel of `windowID` covered by windows in front of it?
    ///
    /// Asked because a fully covered window is one macOS reports as not visible,
    /// and Chromium — which is what NeteaseMusic, Slack, Discord and VS Code
    /// are — deliberately stops producing frames for a window in that state.
    /// The screenshot then keeps returning the last thing the app drew. Measured
    /// on a real session: 22 captures, 6 distinct images, the first 17 identical
    /// while the model clicked and typed through them, and a final report that
    /// contradicted the picture it was looking at. A model shown a frozen
    /// picture cannot tell "my click did nothing" from "the screen is stale",
    /// and it will eventually narrate the difference away.
    ///
    /// Deliberately geometric rather than inferred from repeated frames: two
    /// identical captures are also what an idle app looks like, and treating
    /// that as a fault would cry wolf on every quiet turn.
    ///
    /// Coverage is approximated by the union of the covering rectangles, tested
    /// per horizontal band. That is exact for the case that matters — ordinary
    /// rectangular windows stacked over each other — and errs toward reporting
    /// "visible", which only ever loses us a recovery we could have made.
    static func isFullyCovered(
        windowID: CGWindowID,
        windowList: () -> [[CFString: Any]]? = systemWindowList
    ) -> Bool {
        guard let list = windowList() else { return false }

        var target: CGRect?
        var covering: [CGRect] = []
        for info in list {
            guard let layer = info[kCGWindowLayer] as? Int, layer == 0,
                  let number = info[kCGWindowNumber] as? Int,
                  let raw = info[kCGWindowBounds] as? [String: CGFloat] else {
                continue
            }
            let bounds = CGRect(
                x: raw["X"] ?? 0,
                y: raw["Y"] ?? 0,
                width: raw["Width"] ?? 0,
                height: raw["Height"] ?? 0
            )
            if bounds.isEmpty { continue }

            if CGWindowID(number) == windowID {
                target = bounds
                break                        // list is front-to-back: stop here
            }
            covering.append(bounds)          // everything before it is in front
        }

        guard let target else { return false }
        return isCovered(target, by: covering)
    }

    /// Pure coverage test, split out so the geometry is checkable without a
    /// window server.
    static func isCovered(_ target: CGRect, by others: [CGRect]) -> Bool {
        let overlapping = others
            .map { $0.intersection(target) }
            .filter { !$0.isNull && !$0.isEmpty }
        if overlapping.isEmpty { return false }

        // Sweep the horizontal edges: within a band no rectangle starts or ends,
        // so each band's coverage is a plain 1-D interval union.
        var edges = Set<CGFloat>([target.minY, target.maxY])
        for rect in overlapping {
            edges.insert(max(rect.minY, target.minY))
            edges.insert(min(rect.maxY, target.maxY))
        }
        let ys = edges.sorted()

        for i in 0..<(ys.count - 1) {
            let band = CGRect(
                x: target.minX,
                y: ys[i],
                width: target.width,
                height: ys[i + 1] - ys[i]
            )
            if band.height <= 0 { continue }
            let spans = overlapping
                .filter { $0.minY <= band.minY && $0.maxY >= band.maxY }
                .map { (start: $0.minX, end: $0.maxX) }
                .sorted { $0.start < $1.start }

            var reached = target.minX
            for span in spans {
                if span.start > reached { break }        // gap: band not covered
                reached = max(reached, span.end)
            }
            if reached < target.maxX { return false }
        }
        return true
    }

    /// Why a coordinate could not be bound to one of a process's windows.
    ///
    /// The distinction is the whole point: "your app is not on screen" and
    /// "your coordinate missed" need opposite responses from the caller, and
    /// collapsing them into a bare `nil` is what let an unreachable window look
    /// like a successful click for as long as it did.
    enum BindingFailure: Error, Equatable {
        /// The process has no ordinary window on screen at all — minimized,
        /// hidden, or on another Space. No coordinate can reach it.
        case noWindowOnScreen
        /// It has on-screen windows, but none of them covers this point.
        case pointOutsideWindows
    }

    /// Resolve the window a coordinate action must name, or say why it cannot.
    static func binding(
        at point: CGPoint,
        pid: pid_t,
        windowList: () -> [[CFString: Any]]? = systemWindowList
    ) -> Result<Window, BindingFailure> {
        if let window = window(at: point, pid: pid, windowList: windowList) {
            return .success(window)
        }
        return .failure(
            hasWindowOnScreen(pid: pid, windowList: windowList)
                ? .pointOutsideWindows
                : .noWindowOnScreen
        )
    }

    /// Does `pid` own any ordinary on-screen window right now?
    ///
    /// Deliberately the same layer-0 filter `window(at:)` uses: a process whose
    /// only surfaces are panels or overlays is, for actuation purposes, not on
    /// screen either.
    static func hasWindowOnScreen(
        pid: pid_t,
        windowList: () -> [[CFString: Any]]? = systemWindowList
    ) -> Bool {
        guard let list = windowList() else { return false }
        for info in list {
            guard let layer = info[kCGWindowLayer] as? Int, layer == 0,
                  let owner = info[kCGWindowOwnerPID] as? pid_t, owner == pid,
                  let raw = info[kCGWindowBounds] as? [String: CGFloat] else {
                continue
            }
            let bounds = CGRect(
                x: raw["X"] ?? 0,
                y: raw["Y"] ?? 0,
                width: raw["Width"] ?? 0,
                height: raw["Height"] ?? 0
            )
            if !bounds.isEmpty { return true }
        }
        return false
    }

    /// Front-to-back on-screen windows, as the window server reports them.
    private static func systemWindowList() -> [[CFString: Any]]? {
        CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements],
            kCGNullWindowID
        ) as? [[CFString: Any]]
    }
}
