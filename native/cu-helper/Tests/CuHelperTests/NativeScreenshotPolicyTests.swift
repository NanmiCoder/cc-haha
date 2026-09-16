import AppKit
import ImageIO
import UniformTypeIdentifiers
import XCTest
@testable import cc_haha_computer_use

final class NativeScreenshotPolicyTests: XCTestCase {
    func testPointResolutionAndOfficialLongAndShortSideLimits() {
        for backing in [1.0, 2.0] {
            XCTAssertEqual(NativeScreenshotPolicy.pixelSize(pointSize: CGSize(width: 620, height: 392), backingScale: backing), CGSize(width: 620, height: 392))
            XCTAssertEqual(NativeScreenshotPolicy.pixelSize(pointSize: CGSize(width: 1398, height: 769), backingScale: backing), CGSize(width: 1397, height: 768))
            XCTAssertEqual(NativeScreenshotPolicy.pixelSize(pointSize: CGSize(width: 4000, height: 1000), backingScale: backing), CGSize(width: 2048, height: 512))
            XCTAssertEqual(NativeScreenshotPolicy.pixelSize(pointSize: CGSize(width: 1000, height: 4000), backingScale: backing), CGSize(width: 512, height: 2048))
            XCTAssertEqual(NativeScreenshotPolicy.pixelSize(pointSize: CGSize(width: 1000, height: 1000), backingScale: backing), CGSize(width: 768, height: 768))
        }
    }

    @MainActor
    func testJPEGEncodingMatchesOfficialQuantizationAndPreservesImageSize() throws {
        let context = try XCTUnwrap(CGContext(data: nil, width: 16, height: 16, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue))
        context.setFillColor(CGColor(red: 0.7, green: 0.2, blue: 0.1, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: 16, height: 16))
        let image = try XCTUnwrap(context.makeImage())
        let encoded = try XCTUnwrap(Capture.appScreenshotBase64WithSize(image))
        let data = try XCTUnwrap(Data(base64Encoded: encoded.base64))
        let source = try XCTUnwrap(CGImageSourceCreateWithData(data as CFData, nil))
        XCTAssertEqual(CGImageSourceGetType(source) as String?, UTType.jpeg.identifier)
        XCTAssertEqual(encoded.width, 16)
        XCTAssertEqual(encoded.height, 16)
        let decoded = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
        XCTAssertEqual(decoded.width, 16)
        // DQT is independent of fixture pixels. These tables were read from
        // the actual official getScreenshot JPEG and match ImageIO quality .8.
        let expectedLuminance: [UInt8] = [0,2,2,2,2,2,2,3,2,2,3,4,3,3,3,4,5,4,4,4,4,5,7,5,5,5,5,5,7,8,7,7,7,7,7,7,8,8,8,8,8,8,8,8,10,10,10,10,10,10,11,11,11,11,11,13,13,13,13,13,13,13,13,13,13]
        let bytes = Array(data)
        var offset = 2
        var quantization: [[UInt8]] = []
        while offset + 4 < bytes.count {
            let marker = bytes[offset + 1]
            if marker == 0xda { break }
            let length = Int(bytes[offset + 2]) * 256 + Int(bytes[offset + 3])
            guard length >= 2, offset + 2 + length <= bytes.count else { break }
            if marker == 0xdb { quantization.append(Array(bytes[(offset + 4)..<(offset + 2 + length)])) }
            offset += length + 2
        }
        XCTAssertEqual(quantization.first, expectedLuminance)
    }
}
