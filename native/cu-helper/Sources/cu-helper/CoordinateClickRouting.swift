import CoreGraphics

/// The coordinate route is separate from an index click's AX-tree traversal.
/// Dependencies allow routing tests without posting input or contacting apps.
enum CoordinateClickRouting {
    @MainActor
    static func click<Element>(
        point: CGPoint,
        preferAccessibility: Bool,
        hitTest: (CGPoint) -> Element?,
        press: (Element) -> String?,
        settle: () -> Void,
        syntheticClick: (CGPoint) async throws -> Void
    ) async throws -> String {
        if preferAccessibility, let hit = hitTest(point) {
            if let tag = press(hit) {
                settle()
                return "ax:point:\(tag)"
            }
        }
        // A canvas can hit-test to its entire AXWindow. Its first actionable
        // descendant may be the close button, far from the requested point.
        // Only the exact hit can authorize an AX action for a coordinate click.
        try await syntheticClick(point)
        return "synthetic:point"
    }
}
