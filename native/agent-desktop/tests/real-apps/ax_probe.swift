import AppKit
import ApplicationServices

func read(_ element: AXUIElement, _ attribute: String) -> (Int32, CFTypeRef?) {
    var value: CFTypeRef?
    let error = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
    return (error.rawValue, value)
}
func text(_ element: AXUIElement, _ attribute: String) -> String {
    let (_, value) = read(element, attribute)
    return value.map { String(describing: $0) } ?? ""
}
func children(_ element: AXUIElement) -> [AXUIElement] {
    read(element, "AXChildren").1 as? [AXUIElement] ?? []
}
func describe(_ element: AXUIElement) -> [String: Any] {
    var result: [String: Any] = [:]
    for key in ["AXIdentifier", "AXDOMIdentifier", "AXRole", "AXSubrole", "AXTitle", "AXDescription", "AXValue", "AXSelected", "AXFocused", "AXHidden", "AXExpanded", "AXPosition", "AXSize", "AXRowIndexRange", "AXColumnIndexRange"] {
        let (error, value) = read(element, key)
        result[key] = ["error": error, "value": value.map { String(describing: $0) } ?? ""]
    }
    var attributes: CFArray?
    result["attributeNamesError"] = AXUIElementCopyAttributeNames(element, &attributes).rawValue
    result["attributeNames"] = attributes as? [String] ?? []
    var parameterized: CFArray?
    result["parameterizedNamesError"] = AXUIElementCopyParameterizedAttributeNames(element, &parameterized).rawValue
    result["parameterizedNames"] = parameterized as? [String] ?? []
    var writable: [String: Any] = [:]
    for attribute in attributes as? [String] ?? [] {
        var flag = DarwinBoolean(false)
        let error = AXUIElementIsAttributeSettable(element, attribute as CFString, &flag)
        writable[attribute] = ["error": error.rawValue, "settable": flag.boolValue]
    }
    result["advertisedAttributeSetters"] = writable
    var actions: CFArray?
    result["actionsError"] = AXUIElementCopyActionNames(element, &actions).rawValue
    result["actions"] = actions as? [String] ?? []
    result["children"] = children(element).map {
        ["role": text($0, "AXRole"), "title": text($0, "AXTitle"), "description": text($0, "AXDescription")]
    }
    var settable: [String: Any] = [:]
    for key in ["AXValue", "AXSelectedText", "AXFocused", "AXSelectedCells"] {
        var value = DarwinBoolean(false)
        let error = AXUIElementIsAttributeSettable(element, key as CFString, &value)
        settable[key] = ["error": error.rawValue, "value": value.boolValue]
    }
    result["settable"] = settable
    result["selectedCells"] = (read(element, "AXSelectedCells").1 as? [AXUIElement] ?? []).map {
        ["title": text($0, "AXTitle"), "description": text($0, "AXDescription")]
    }
    return result
}
func walk(_ element: AXUIElement, _ depth: Int, _ visit: (AXUIElement, Int) -> Void) {
    guard depth < 25 else { return }
    visit(element, depth)
    for child in children(element) { walk(child, depth + 1, visit) }
}
let args = CommandLine.arguments
if args.count < 4 { fatalError("usage: ax_probe PID OWNED_WINDOW_TITLE inspect|press|show-menu|select|set TARGET [VALUE]") }
guard let pid = Int32(args[1]), args[2].hasPrefix("AD Reliability") else {
    fatalError("requires owned evaluation window")
}
let app = AXUIElementCreateApplication(pid)
AXUIElementSetMessagingTimeout(app, 3)
let windowRead = read(app, "AXWindows")
let windows = windowRead.1 as? [AXUIElement] ?? []
let matches = windows.filter { text($0, "AXTitle") == args[2] }
guard matches.count == 1 else {
    let failure: [String: Any] = ["error": "owned_window_missing_or_ambiguous", "AXWindowsError": windowRead.0, "windows": windows.map { text($0, "AXTitle") }]
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: failure, options: [.sortedKeys]))
    exit(1)
}
let window = matches[0]
var nodes: [AXUIElement] = []
walk(window, 0) { node, _ in nodes.append(node) }
var result: [String: Any] = ["frontmostBefore": NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1]
let focusedRead = read(app, "AXFocusedUIElement")
result["focusedElementError"] = focusedRead.0
if let value = focusedRead.1, CFGetTypeID(value) == AXUIElementGetTypeID() {
    let focused = unsafeBitCast(value, to: AXUIElement.self)
    result["focusedElement"] = describe(focused)
    var ancestry: [[String: String]] = []
    var current = focused
    for _ in 0..<8 {
        ancestry.append(["role": text(current, "AXRole"), "title": text(current, "AXTitle")])
        guard let parent = read(current, "AXParent").1,
              CFGetTypeID(parent) == AXUIElementGetTypeID() else { break }
        current = unsafeBitCast(parent, to: AXUIElement.self)
    }
    result["focusedAncestry"] = ancestry
}
if args[3] == "inspect" {
    result["nodes"] = nodes.filter {
        if args.count > 4 {
            if args[4] == "editor" { return ["AXTextArea", "AXTextField"].contains(text($0, "AXRole")) && text($0, "AXFocused") == "1" }
            return text($0, "AXTitle") == args[4] || text($0, "AXDescription") == args[4]
        }
        return ["AXCell", "AXTable", "AXTextArea"].contains(text($0, "AXRole"))
    }.map(describe)
} else {
    guard args.count >= 5 else { fatalError("target required") }
    let targets = nodes.filter {
        if args[4] == "editor" { return ["AXTextArea", "AXTextField"].contains(text($0, "AXRole")) && text($0, "AXFocused") == "1" }
        return ["AXCell", "AXMenuButton"].contains(text($0, "AXRole")) && (text($0, "AXTitle") == args[4] || text($0, "AXDescription") == args[4])
    }
    guard targets.count == 1 else { fatalError("target missing or ambiguous") }
    let target = targets[0]
    result["before"] = describe(target)
    let start = Date()
    if args[3] == "press" {
        result["nativeError"] = AXUIElementPerformAction(target, "AXPress" as CFString).rawValue
    } else if args[3] == "show-menu" {
        result["nativeError"] = AXUIElementPerformAction(target, "AXShowMenu" as CFString).rawValue
    } else if args[3] == "set" && args.count == 6 {
        result["nativeError"] = AXUIElementSetAttributeValue(target, "AXValue" as CFString, args[5] as CFString).rawValue
    } else if args[3] == "select" {
        let tables = nodes.filter { text($0, "AXRole") == "AXTable" && text($0, "AXTitle").contains("Eval Grid") }
        guard tables.count == 1 else { fatalError("table missing or ambiguous") }
        result["nativeError"] = AXUIElementSetAttributeValue(tables[0], "AXSelectedCells" as CFString, [target] as CFArray).rawValue
    } else { fatalError("unsupported operation") }
    result["elapsedMs"] = Date().timeIntervalSince(start) * 1000
    result["after"] = describe(target)
}
var menus: [[String: Any]] = []
walk(window, 0) { node, depth in
    if text(node, "AXRole") == "AXMenu" {
        menus.append(["depthFromWindow": depth, "node": describe(node)])
    }
}
result["menusObserved"] = menus
result["frontmostAfter"] = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1
let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
FileHandle.standardOutput.write(data)
if args.last == "--hold" {
    RunLoop.main.run(until: Date().addingTimeInterval(15))
}
