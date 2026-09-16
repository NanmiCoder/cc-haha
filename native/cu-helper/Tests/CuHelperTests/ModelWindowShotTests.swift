import CoreGraphics
import Foundation
import ImageIO
import XCTest

@testable import cc_haha_computer_use

@MainActor
final class ModelWindowShotTests: XCTestCase {
    func testLargeLandscapeAndPortraitImagesFitBudgetAndRemainPNG() throws {
        for (width, height, expectedWidth, expectedHeight) in [
            (2304, 1506, 1175, 768),
            (1506, 2304, 768, 1175),
            (2400, 600, 2048, 512),
        ] {
            let input = try makeShot(width: width, height: height)
            let shot = try XCTUnwrap(Capture.boundedModelWindowShot(input))
            XCTAssertEqual(shot.width, expectedWidth)
            XCTAssertEqual(shot.height, expectedHeight)
            let data = try XCTUnwrap(Data(base64Encoded: shot.base64))
            XCTAssertEqual(Array(data.prefix(8)), [137, 80, 78, 71, 13, 10, 26, 10])
            let source = try XCTUnwrap(CGImageSourceCreateWithData(data as CFData, nil))
            let image = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
            XCTAssertEqual(image.width, shot.width)
            XCTAssertEqual(image.height, shot.height)
            XCTAssertEqual(shot.originX, input.originX)
            XCTAssertEqual(shot.originY, input.originY)
            XCTAssertEqual(shot.pointWidth, input.pointWidth)
            XCTAssertEqual(shot.pointHeight, input.pointHeight)
            XCTAssertEqual(shot.windowID, input.windowID)
            XCTAssertEqual(shot.source, input.source)
        }
    }

    func testSmallImageIsNotEnlargedOrReencoded() throws {
        let input = try makeShot(width: 640, height: 400)
        let shot = try XCTUnwrap(Capture.boundedModelWindowShot(input))
        XCTAssertEqual(shot.width, 640)
        XCTAssertEqual(shot.height, 400)
        XCTAssertEqual(shot.base64, input.base64)
    }

    func testBoundedPixelsMapBackToOriginalWindowPointsAtDifferentBackingScales() throws {
        let identity = AXTreeProcessIdentity(bundleID: "test.window", executablePath: "/fixture/window", launchTime: 1)
        for pixelSize in [(2304, 1506), (1152, 753)] {
            let input = try makeShot(width: pixelSize.0, height: pixelSize.1, pointWidth: 1152, pointHeight: 753, pixelsPerPoint: Double(pixelSize.0) / 1152)
            let shot = try XCTUnwrap(Capture.boundedModelWindowShot(input))
            CommandRouter.clearShotTransformsForTesting()
            defer { CommandRouter.clearShotTransformsForTesting() }
            CommandRouter.recordShotTransform(
                pid: 77, originX: shot.originX, originY: shot.originY,
                pointWidth: shot.pointWidth, pointHeight: shot.pointHeight,
                imageWidth: shot.width, imageHeight: shot.height,
                processIdentity: identity, windowID: shot.windowID, pixelsPerPoint: shot.pixelsPerPoint
            )
            let point = try CommandRouter.toGlobalPoint(
                x: Double(shot.width) * 0.75, y: Double(shot.height) * 0.25,
                pid: 77, currentProcessIdentity: identity, currentWindowID: shot.windowID
            )
            XCTAssertEqual(point.x, input.originX + input.pointWidth * 0.75, accuracy: 0.000001)
            XCTAssertEqual(point.y, input.originY + input.pointHeight * 0.25, accuracy: 0.000001)
            XCTAssertThrowsError(try CommandRouter.toGlobalPoint(
                x: Double(shot.width), y: 0, pid: 77,
                currentProcessIdentity: identity, currentWindowID: shot.windowID
            ))
        }
    }

    func testInvalidLargeImageCannotLeakAnUnboundedFallback() {
        let shot = WindowShot(base64: "invalid", width: 2304, height: 1506,
                              originX: 0, originY: 0, pointWidth: 1152, pointHeight: 753,
                              windowID: 17, source: .screenshotManager)
        XCTAssertNil(Capture.boundedModelWindowShot(shot))
    }

    func testFinalModelJPEGReallyDecodesAtTheSameSizeAndLeavesPNGEvidenceUntouched() throws {
        let raw = try makeShot(width: 2304, height: 1506)
        let bounded = try XCTUnwrap(Capture.boundedModelWindowShot(raw))
        let evidence = bounded.base64
        let model = Capture.modelWindowImage(bounded)
        XCTAssertEqual(model.mimeType, "image/jpeg")
        let data = try XCTUnwrap(Data(base64Encoded: model.base64))
        let source = try XCTUnwrap(CGImageSourceCreateWithData(data as CFData, nil))
        XCTAssertEqual(CGImageSourceGetType(source) as String?, "public.jpeg")
        let image = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
        XCTAssertEqual(image.width, bounded.width)
        XCTAssertEqual(image.height, bounded.height)
        XCTAssertEqual(bounded.base64, evidence)
        XCTAssertEqual(Array(try XCTUnwrap(Data(base64Encoded: evidence)).prefix(8)), [137, 80, 78, 71, 13, 10, 26, 10])
    }

    func testJPEGQualityBoundsAndEncoderFailurePreserveLosslessFallback() throws {
        let shot = try makeShot(width: 96, height: 64)
        var qualities: [Double] = []
        for quality in [0.0, 0.9, 1.0] {
            let image = Capture.modelWindowImage(shot, quality: quality) { _, q in
                qualities.append(q)
                return nil
            }
            XCTAssertEqual(image.mimeType, "image/png")
            XCTAssertEqual(image.base64, shot.base64)
        }
        XCTAssertEqual(qualities, [0, 0.9, 1])
        for quality in [-0.1, 1.1, Double.nan, Double.infinity] {
            let image = Capture.modelWindowImage(shot, quality: quality) { _, _ in
                XCTFail("invalid quality must never reach the encoder")
                return nil
            }
            XCTAssertEqual(image.mimeType, "image/png")
            XCTAssertEqual(image.base64, shot.base64)
        }
        let empty = Capture.modelWindowImage(shot) { _, _ in "" }
        XCTAssertEqual(empty.mimeType, "image/png")
        let image = Capture.modelWindowImage(shot)
        let data = try XCTUnwrap(Data(base64Encoded: image.base64))
        let source = try XCTUnwrap(CGImageSourceCreateWithData(data as CFData, nil))
        let decoded = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
        XCTAssertEqual(decoded.width, 96)
        XCTAssertEqual(decoded.height, 64)
    }

    func testAlreadyFittedOfficialImagePreservesPixelsAndUniformScale() throws {
        let fit = 768.0 / 769.0
        let input = try makeShot(width: 1397, height: 768, pointWidth: 1398, pointHeight: 769, pixelsPerPoint: fit)
        let shot = try XCTUnwrap(Capture.boundedModelWindowShot(input))
        XCTAssertEqual(shot.base64, input.base64)
        XCTAssertEqual(shot.width, 1397)
        XCTAssertEqual(shot.height, 768)
        XCTAssertEqual(shot.pixelsPerPoint, fit)
        var encodings = 0
        let model = Capture.modelWindowImage(shot) { image, quality in
            encodings += 1
            XCTAssertEqual(image.width, 1397)
            XCTAssertEqual(image.height, 768)
            XCTAssertEqual(quality, NativeScreenshotPolicy.jpegQuality)
            return "jpeg-fixture"
        }
        XCTAssertEqual(encodings, 1)
        XCTAssertEqual(model.mimeType, "image/jpeg")
        XCTAssertEqual(model.base64, "jpeg-fixture")
    }

    func testRetinaLosslessShotFitsOnceAndCarriesItsScaledUniformTransform() throws {
        let raw = try makeShot(width: 2796, height: 1538, pointWidth: 1398, pointHeight: 769, pixelsPerPoint: 2)
        let shot = try XCTUnwrap(Capture.boundedModelWindowShot(raw))
        XCTAssertEqual(shot.width, 1397)
        XCTAssertEqual(shot.height, 768)
        XCTAssertEqual(try XCTUnwrap(shot.pixelsPerPoint), 768.0 / 769.0, accuracy: 0.000000001)
        let again = try XCTUnwrap(Capture.boundedModelWindowShot(shot))
        XCTAssertEqual(again.base64, shot.base64)
        XCTAssertEqual(again.pixelsPerPoint, shot.pixelsPerPoint)
    }

    private func makeShot(width: Int, height: Int, pointWidth: Double? = nil, pointHeight: Double? = nil, pixelsPerPoint: Double? = nil) throws -> WindowShot {
        let context = try XCTUnwrap(CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ))
        context.setFillColor(CGColor(red: 0.2, green: 0.4, blue: 0.6, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        let image = try XCTUnwrap(context.makeImage())
        let encoded = try XCTUnwrap(Capture.pngBase64WithSize(image))
        return WindowShot(
            base64: encoded.base64, width: encoded.width, height: encoded.height,
            originX: -600, originY: 200, pointWidth: pointWidth ?? Double(width), pointHeight: pointHeight ?? Double(height),
            windowID: 17, source: .streamBackedScreenshot, pixelsPerPoint: pixelsPerPoint
        )
    }
}
