import AppKit
import SwiftUI

struct SilentTextInput: NSViewRepresentable {
    func makeNSView(context: Context) -> SilentTextField { SilentTextField(frame: .zero, textContainer: nil) }
    func updateNSView(_ view: SilentTextField, context: Context) {}
}

final class SilentTextField: NSTextView {
    override init(frame frameRect: NSRect, textContainer container: NSTextContainer?) {
        super.init(frame: frameRect, textContainer: container)
        setAccessibilityLabel("silent-text-input")
    }

    required init?(coder: NSCoder) { nil }

    override func accessibilitySelectedText() -> String? { "" }
    override func accessibilitySelectedTextRange() -> NSRange { NSRange(location: 0, length: 0) }
    override func setAccessibilitySelectedText(_ selectedText: String?) {}
    override func isAccessibilitySelectorAllowed(_ selector: Selector) -> Bool {
        selector == #selector(setAccessibilitySelectedText(_:))
            || super.isAccessibilitySelectorAllowed(selector)
    }
}
