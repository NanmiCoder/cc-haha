import CoreGraphics

/// Native App screenshot defaults from the official macOS controller:
/// normalize Retina pixels to points, then fit long side <= 2048 and short
/// side <= 768 without enlarging. Pixel buffers round dimensions upward.
/// The image transform still covers the entire original window frame.
enum NativeScreenshotPolicy {
    static let jpegQuality = 0.8
    static let mimeType = "image/jpeg"

    static func scale(pointSize: CGSize, backingScale: Double) -> Double {
        let width = pointSize.width
        let height = pointSize.height
        guard width.isFinite, height.isFinite, width > 0, height > 0,
              backingScale.isFinite, backingScale > 0 else { return 1 }
        let fit = min(1, 2048 / max(width, height), 768 / min(width, height))
        return fit / backingScale
    }

    static func pixelSize(pointSize: CGSize, backingScale: Double) -> CGSize {
        let factor = scale(pointSize: pointSize, backingScale: backingScale) * backingScale
        return CGSize(width: max(1, ceil(pointSize.width * factor)), height: max(1, ceil(pointSize.height * factor)))
    }
}
