import AppKit
import SwiftUI

// Reusable fixture components: status readout, native AppKit controls
// (genuinely AX-actionable, unlike SwiftUI's), drag canvas, and card chrome.
// Split from AgentDeskFixture.swift to keep each file under the 400-LOC limit;
// the build compiles every .swift file in this directory as one module.

struct StatusReadout: View {
    let name: String
    let value: String
    var body: some View {
        Text("\(name): \(value)")
            .accessibilityLabel(name)
            .accessibilityValue(value)
            .accessibilityIdentifier(name)
    }
}

// Exposes a ScrollView's live scroll offset as an accessibility value so the
// test harness can confirm `scroll` actually moved content, rather than
// trusting the command's ok:true.
struct ScrollOffsetKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

// Native AppKit controls embedded alongside the SwiftUI ones. SwiftUI sliders
// and steppers do not expose a settable AX value, so they cannot validate the
// numeric set-value path; their AppKit counterparts do, exercising the same
// command against a control that genuinely accepts a programmatic value.
struct NativeSlider: NSViewRepresentable {
    @Binding var value: Double
    func makeNSView(context: Context) -> NSSlider {
        let s = NSSlider(
            value: value, minValue: 0, maxValue: 100,
            target: context.coordinator, action: #selector(Coordinator.changed(_:)))
        s.setAccessibilityLabel("value-slider")
        return s
    }
    func updateNSView(_ view: NSSlider, context: Context) { view.doubleValue = value }
    func makeCoordinator() -> NativeControlCoordinator { NativeControlCoordinator { value = $0 } }
}

struct NativeStepper: NSViewRepresentable {
    @Binding var value: Double
    func makeNSView(context: Context) -> NSStepper {
        let s = NSStepper()
        s.minValue = 0
        s.maxValue = 10
        s.increment = 1
        s.valueWraps = false
        s.target = context.coordinator
        s.action = #selector(NativeControlCoordinator.changed(_:))
        s.setAccessibilityLabel("value-stepper")
        return s
    }
    func updateNSView(_ view: NSStepper, context: Context) { view.doubleValue = value }
    func makeCoordinator() -> NativeControlCoordinator { NativeControlCoordinator { value = $0 } }
}

// Shared target for native controls; NSControl exposes doubleValue for both
// NSSlider and NSStepper.
final class NativeControlCoordinator: NSObject {
    let onChange: (Double) -> Void
    init(_ onChange: @escaping (Double) -> Void) { self.onChange = onChange }
    @objc func changed(_ sender: NSControl) { onChange(sender.doubleValue) }
}

struct ZeroBoundsButton: NSViewRepresentable {
    func makeNSView(context: Context) -> ZeroBoundsAXHost { ZeroBoundsAXHost() }

    func updateNSView(_ view: ZeroBoundsAXHost, context: Context) {}
}

final class ZeroBoundsAXHost: NSView {
    private let visual = NSButton(title: "Zero Bounds", target: nil, action: nil)
    private let zeroBoundsElement = NSAccessibilityElement()

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        visual.setAccessibilityElement(false)
        addSubview(visual)
        setAccessibilityElement(false)
        zeroBoundsElement.setAccessibilityRole(.button)
        zeroBoundsElement.setAccessibilityLabel("zero-bounds-button")
        zeroBoundsElement.setAccessibilityParent(self)
        zeroBoundsElement.setAccessibilityFrame(.zero)
    }

    required init?(coder: NSCoder) { nil }

    override var intrinsicContentSize: NSSize { visual.intrinsicContentSize }

    override func layout() {
        super.layout()
        visual.frame = bounds
        zeroBoundsElement.setAccessibilityFrameInParentSpace(.zero)
    }

    override func accessibilityChildren() -> [Any]? { [zeroBoundsElement] }
}

final class DuplicateWindowController {
    static let shared = DuplicateWindowController()

    private var windows: [NSWindow] = []

    func openWindows() {
        closeWindows()
        windows = (0..<2).map { index in
            let window = NSWindow(
                contentRect: NSRect(x: 160 + index * 380, y: 180, width: 320, height: 180),
                styleMask: [.titled, .closable, .miniaturizable, .resizable],
                backing: .buffered,
                defer: false
            )
            window.isReleasedWhenClosed = false
            window.title = "Duplicate Window"
            window.identifier = NSUserInterfaceItemIdentifier("duplicate-window-\(index)")
            window.contentView = duplicateWindowBody(index: index)
            window.orderFront(nil)
            return window
        }
    }

    func closeWindows() {
        windows.forEach { $0.close() }
        windows = []
    }

    private func duplicateWindowBody(index: Int) -> NSView {
        let label = NSTextField(labelWithString: "duplicate-window-\(index)")
        label.setAccessibilityLabel("duplicate-window-\(index)")
        let container = NSView(frame: NSRect(x: 0, y: 0, width: 320, height: 180))
        label.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(label)
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: container.centerXAnchor),
            label.centerYAnchor.constraint(equalTo: container.centerYAnchor),
        ])
        return container
    }
}

// A single view that tracks a mouse-drag gesture end to end (down, dragged,
// up). Synthetic mouse events route to whoever received the mouse-down, so a
// drag is observable when source and target are the same view — which is what
// `agent-desktop drag` can do. Cross-target native drag-and-drop uses the OS
// dragging-session/pasteboard protocol that synthetic events cannot start.
struct DragCanvas: NSViewRepresentable {
    @Binding var result: String
    func makeNSView(context: Context) -> DragCanvasView {
        let v = DragCanvasView()
        // The closure captures `result` by reference; DragCanvasView calls it
        // directly on each mouseUp, so updateNSView needs no re-sync.
        v.onDrag = { result = $0 }
        return v
    }
    func updateNSView(_ view: DragCanvasView, context: Context) {
        // Intentionally empty: gesture results flow *out* through the captured
        // binding (via onDrag), never *in* from SwiftUI state — nothing to sync.
    }
}

final class DragCanvasView: NSView {
    var onDrag: ((String) -> Void)?
    private var start: NSPoint?
    private var dragged = false
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel("drag-canvas")
    }
    override func accessibilityFrame() -> NSRect {
        guard let window else { return .zero }
        return window.convertToScreen(convert(bounds, to: nil))
    }
    override func isAccessibilityElement() -> Bool { true }
    override func mouseDown(with e: NSEvent) { start = convert(e.locationInWindow, from: nil); dragged = false }
    override func mouseDragged(with e: NSEvent) { dragged = true }
    override func mouseUp(with e: NSEvent) {
        guard let s = start else { return }
        let end = convert(e.locationInWindow, from: nil)
        let dist = Int((hypot(end.x - s.x, end.y - s.y)).rounded())
        onDrag?(dragged ? "dragged-\(dist)" : "click")
        start = nil
    }
}

struct Card<Content: View>: View {
    let title: String
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.headline)
            content
        }
        .padding(10)
        .frame(width: 280, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.gray.opacity(0.08)))
    }
}
