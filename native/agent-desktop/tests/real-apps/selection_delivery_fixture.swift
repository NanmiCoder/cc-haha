import AppKit

final class SilentRow: NSView {
    override func isAccessibilityElement() -> Bool { true }
    override func accessibilityRole() -> NSAccessibility.Role? { .row }
    override func accessibilityLabel() -> String? { "Silent selection row" }
    override func isAccessibilitySelected() -> Bool { false }
    override func setAccessibilitySelected(_ value: Bool) {
        NSLog("MUTATION direct-selection %@", value.description)
    }
    override func isAccessibilitySelectorAllowed(_ selector: Selector) -> Bool {
        selector == #selector(setAccessibilitySelected(_:))
            || super.isAccessibilitySelectorAllowed(selector)
    }
}

final class SelectionTable: NSView {
    override func isAccessibilityElement() -> Bool { true }
    override func accessibilityRole() -> NSAccessibility.Role? { .table }
    override func accessibilityLabel() -> String? { "Selection delivery table" }
    override func accessibilitySelectedRows() -> [Any]? { [] }
    override func setAccessibilitySelectedRows(_ rows: [Any]?) {
        NSLog("MUTATION container-selection %ld", rows?.count ?? 0)
    }
    override func isAccessibilitySelectorAllowed(_ selector: Selector) -> Bool {
        selector == #selector(setAccessibilitySelectedRows(_:))
            || super.isAccessibilitySelectorAllowed(selector)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let window = NSWindow(contentRect: NSRect(x: 300, y: 200, width: 400, height: 240),
                      styleMask: [.titled], backing: .buffered, defer: false)
window.title = "AD Reliability Selection Delivery"
let table = SelectionTable(frame: NSRect(x: 20, y: 20, width: 360, height: 200))
let row = SilentRow(frame: NSRect(x: 0, y: 0, width: 300, height: 60))
table.addSubview(row)
window.contentView?.addSubview(table)
window.orderBack(nil)
NSLog("READY pid=%d", ProcessInfo.processInfo.processIdentifier)
app.run()
