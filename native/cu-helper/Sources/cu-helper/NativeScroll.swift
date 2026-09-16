import CoreGraphics

enum NativeScroll {
    static func pageNavigation(action: String) -> (axisAttribute: String, buttonSubrole: String)? {
        switch action {
        case "AXScrollUpByPage": return ("AXVerticalScrollBar", "AXDecrementPage")
        case "AXScrollDownByPage": return ("AXVerticalScrollBar", "AXIncrementPage")
        case "AXScrollLeftByPage": return ("AXHorizontalScrollBar", "AXDecrementPage")
        case "AXScrollRightByPage": return ("AXHorizontalScrollBar", "AXIncrementPage")
        default: return nil
        }
    }

    /// Native App.scroll pages use the addressed element's frame; a coordinate
    /// target uses the whole window frame even when it hits a nested scroll view.
    static func delta(direction: String, pages: Double, frameSize: CGSize) throws -> (x: Int32, y: Int32) {
        let horizontal = direction == "left" || direction == "right"
        guard horizontal || direction == "up" || direction == "down",
              pages.isFinite, pages > 0 else {
            throw CUError("bad_payload", "Scroll direction and pages must be valid")
        }
        let extent = horizontal ? frameSize.width : frameSize.height
        let pixels = extent * pages
        guard extent.isFinite, extent > 0, pixels.isFinite else {
            throw CUError("bad_payload", "Scroll frame and distance must be finite and positive")
        }
        let magnitude = Int32(min(Double(Int32.max), pixels.rounded(.toNearestOrAwayFromZero)))
        let signed = direction == "down" || direction == "right" ? -magnitude : magnitude
        return horizontal ? (signed, 0) : (0, signed)
    }
}
