import AppKit
import ApplicationServices
func read(_ node: AXUIElement, _ key: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(node, key as CFString, &value) == .success else { return nil }
    return value
}
func children(_ node: AXUIElement) -> [AXUIElement] { read(node, "AXChildren") as? [AXUIElement] ?? [] }
func collect(_ node: AXUIElement, depth: Int = 0) -> [AXUIElement] {
    guard depth < 25 else { return [] }
    return [node] + children(node).flatMap { collect($0, depth: depth + 1) }
}
let args = CommandLine.arguments
precondition(args.count == 5)
guard let pid = Int32(args[1]), args[2].hasPrefix("AD Reliability") else { fatalError("owned target required") }
let app = AXUIElementCreateApplication(pid)
AXUIElementSetMessagingTimeout(app, 3)
let windows = (read(app, "AXWindows") as? [AXUIElement] ?? []).filter { read($0, "AXTitle") as? String == args[2] }
precondition(windows.count == 1, "unique owned window required")
let editors = collect(windows[0]).filter { read($0, "AXRole") as? String == "AXTextArea" && read($0, "AXValue") as? String == args[3] }
precondition(editors.count == 1, "unique seeded editor required")
let editor = editors[0]
var names: CFArray?
precondition(AXUIElementCopyParameterizedAttributeNames(editor, &names) == .success)
precondition((names as? [String] ?? []).contains("AXReplaceRangeWithText"))
precondition(NSWorkspace.shared.frontmostApplication?.processIdentifier != pid, "must be background")
var range = CFRange(location: 0, length: args[3].utf16.count)
guard let rangeValue = AXValueCreate(.cfRange, &range) else { fatalError("range allocation failed") }
let parameter = ["AXReplacementRange": rangeValue, "AXReplacementText": args[4] as CFString] as CFDictionary
var result: CFTypeRef?
let frontBefore = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1
let error = AXUIElementCopyParameterizedAttributeValue(editor, "AXReplaceRangeWithText" as CFString, parameter, &result)
let after = read(editor, "AXValue") as? String
print("nativeError=\(error.rawValue) result=\(String(describing: result)) before=\(args[3]) after=\(String(describing: after)) foregroundBefore=\(frontBefore) foregroundAfter=\(NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1)")
exit(error == .success && after == args[4] ? 0 : 1)
