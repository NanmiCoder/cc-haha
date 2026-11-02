import AppKit
import ApplicationServices

enum ProbeError: Error {
    case invalidArguments
    case nativeRead(String, Int32)
    case incompleteTree
    case nonUniqueTarget
}

func attribute(_ element: AXUIElement, _ name: String) throws -> CFTypeRef? {
    var result: CFTypeRef?
    let error = AXUIElementCopyAttributeValue(element, name as CFString, &result)
    if error == .noValue || error == .attributeUnsupported { return nil }
    guard error == .success else { throw ProbeError.nativeRead(name, error.rawValue) }
    return result
}

func descendants(_ root: AXUIElement) throws -> [AXUIElement] {
    var pending: [(AXUIElement, Int)] = [(root, 0)]
    var result: [AXUIElement] = []
    while let (node, depth) = pending.popLast() {
        guard result.count < 1000, depth < 30 else { throw ProbeError.incompleteTree }
        result.append(node)
        let children = try attribute(node, "AXChildren") as? [AXUIElement] ?? []
        pending.append(contentsOf: children.map { ($0, depth + 1) })
    }
    return result
}

guard CommandLine.arguments.count == 2,
      let pid = Int32(CommandLine.arguments[1]) else { throw ProbeError.invalidArguments }
let app = AXUIElementCreateApplication(pid)
AXUIElementSetMessagingTimeout(app, 1)
let windows = try attribute(app, "AXWindows") as? [AXUIElement] ?? []
guard windows.count == 1, let window = windows.first else { throw ProbeError.nonUniqueTarget }
let initial = try descendants(window)
let matches = try initial.filter {
    try attribute($0, "AXIdentifier") as? String == "shared-title"
        && attribute($0, "AXValue") as? String == "Alpha"
}
guard matches.count == 1, let retained = matches.first else { throw ProbeError.nonUniqueTarget }
let stableMatches = try initial.filter {
    try attribute($0, "AXIdentifier") as? String == "stable-editor"
}
guard stableMatches.count == 1, let stable = stableMatches.first else {
    throw ProbeError.nonUniqueTarget
}
print("ready: retained Alpha; enter a stage label to inspect current membership")
fflush(stdout)
while let stage = readLine() {
    if stage == "quit" { break }
    let live = try descendants(window)
    let equal = live.filter { CFEqual(retained, $0) }
    var fields: [String] = []
    for node in live where try attribute(node, "AXIdentifier") as? String == "shared-title" {
        let value = try attribute(node, "AXValue") as? String ?? "<absent>"
        fields.append("\(value):retained=\(CFEqual(retained, node))")
    }
    var value: CFTypeRef?
    let error = AXUIElementCopyAttributeValue(retained, "AXValue" as CFString, &value)
    print("stage=\(stage) membership=\(equal.count) retainedError=\(error.rawValue) retainedValue=\(String(describing: value)) fields=\(fields)")
    let stableMembership = live.filter { CFEqual(stable, $0) }.count
    let stableValue = try attribute(stable, "AXValue") as? String
    print("stableMembership=\(stableMembership) stableValue=\(String(describing: stableValue))")
    if ["initial", "filtered", "restored", "edited", "cleared"].contains(stage) {
        precondition(equal.count == (stage == "initial" ? 1 : 0))
        precondition(stableMembership == 1)
        precondition(stableValue == (stage == "edited" ? "retained-control" : "Stable value"))
        precondition(!fields.contains("Beta:retained=true"))
        print("stage assertions passed")
    }
    fflush(stdout)
}
