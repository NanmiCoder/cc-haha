import AppKit
import ImageIO
import UniformTypeIdentifiers
import XCTest

@testable import cc_haha_computer_use

final class VirtualCursorResourceTests: XCTestCase {
    @MainActor
    func testPackagedApplicationLoadsFramesFromContentsResourcesInNaturalOrder() throws {
        let fixture = try ResourceFixture()
        defer { fixture.remove() }
        let sequence = try fixture.sequence(at: "Contents/Resources/cu-helper_cc-haha-computer-use.bundle")
        try fixture.png(width: 10, to: sequence.appendingPathComponent("frame_10.png"))
        try fixture.png(width: 2, to: sequence.appendingPathComponent("frame_2.png"))

        let resources = VirtualCursor.loadLensSequence(from: fixture.bundle)
        let frames = try XCTUnwrap(resources.frames)

        XCTAssertEqual(resources.directory?.standardizedFileURL.path, sequence.standardizedFileURL.path)
        XCTAssertEqual(frames.map(\.width), [2, 10])
    }

    @MainActor
    func testMissingOptionalBundleFallsBackWithoutLoadingAnyBuildTreeResources() throws {
        let fixture = try ResourceFixture()
        defer { fixture.remove() }

        let resources = VirtualCursor.loadLensSequence(from: fixture.bundle)
        XCTAssertNil(resources.directory)
        XCTAssertNil(resources.frames)
    }

    @MainActor
    func testReadmeOnlySequenceFallsBackToProceduralRipple() throws {
        let fixture = try ResourceFixture()
        defer { fixture.remove() }
        let sequence = try fixture.sequence(at: "Contents/Resources/cu-helper_cc-haha-computer-use.bundle")
        try Data("Optional animation frames are not installed.".utf8)
            .write(to: sequence.appendingPathComponent("README.md"))

        let resources = VirtualCursor.loadLensSequence(from: fixture.bundle)
        XCTAssertEqual(resources.directory?.standardizedFileURL.path, sequence.standardizedFileURL.path)
        XCTAssertNil(resources.frames)
    }

    @MainActor
    func testInvalidFramesDoNotHideLaterValidFrames() throws {
        let fixture = try ResourceFixture()
        defer { fixture.remove() }
        let sequence = try fixture.sequence(at: "Contents/Resources/cu-helper_cc-haha-computer-use.bundle")
        try Data("not a PNG".utf8).write(to: sequence.appendingPathComponent("frame_1.png"))
        try fixture.png(width: 4, to: sequence.appendingPathComponent("frame_2.PNG"))

        let frames = try XCTUnwrap(VirtualCursor.loadLensSequence(from: fixture.bundle).frames)

        XCTAssertEqual(frames.map(\.width), [4])
    }

    @MainActor
    func testExecutableSiblingModuleBundleRemainsSupported() throws {
        let fixture = try ResourceFixture()
        defer { fixture.remove() }
        let sequence = try fixture.sequence(at: "Contents/MacOS/cu-helper_cc-haha-computer-use.bundle")
        try fixture.png(width: 3, to: sequence.appendingPathComponent("frame_1.png"))

        let resources = VirtualCursor.loadLensSequence(from: fixture.bundle)

        XCTAssertEqual(resources.directory?.standardizedFileURL.path, sequence.standardizedFileURL.path)
        XCTAssertEqual(resources.frames?.map(\.width), [3])
    }

    @MainActor
    func testPackagedSequenceTakesPrecedenceOverLegacyLocationsEvenWithoutFrames() throws {
        let fixture = try ResourceFixture()
        defer { fixture.remove() }
        let packaged = try fixture.sequence(at: "Contents/Resources/cu-helper_cc-haha-computer-use.bundle")
        let sibling = try fixture.sequence(at: "Contents/MacOS/cu-helper_cc-haha-computer-use.bundle")
        try fixture.png(width: 3, to: sibling.appendingPathComponent("frame_1.png"))

        let resources = VirtualCursor.loadLensSequence(from: fixture.bundle)

        XCTAssertEqual(resources.directory?.standardizedFileURL.path, packaged.standardizedFileURL.path)
        XCTAssertNil(resources.frames, "An intentionally empty deployed sequence must not borrow other frames")
    }

    @MainActor
    func testAllInvalidFramesFallBackToProceduralRipple() throws {
        let fixture = try ResourceFixture()
        defer { fixture.remove() }
        let sequence = try fixture.sequence(at: "Contents/Resources/cu-helper_cc-haha-computer-use.bundle")
        try Data("not a PNG".utf8).write(to: sequence.appendingPathComponent("frame_1.png"))

        let resources = VirtualCursor.loadLensSequence(from: fixture.bundle)

        XCTAssertEqual(resources.directory?.standardizedFileURL.path, sequence.standardizedFileURL.path)
        XCTAssertNil(resources.frames)
    }

    @MainActor
    func testResourcePathThatIsAFileDoesNotCrash() throws {
        let fixture = try ResourceFixture()
        defer { fixture.remove() }
        try Data("not a directory".utf8).write(to: fixture.application
            .appendingPathComponent("Contents/Resources/cu-helper_cc-haha-computer-use.bundle"))

        let resources = VirtualCursor.loadLensSequence(from: fixture.bundle)

        XCTAssertNil(resources.directory)
        XCTAssertNil(resources.frames)
    }
}

private struct ResourceFixture {
    let root: URL
    let application: URL
    let bundle: Bundle

    init() throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("cu-cursor-resources-\(UUID().uuidString)", isDirectory: true)
        application = root.appendingPathComponent("Moved Helper's App.app", isDirectory: true)
        let contents = application.appendingPathComponent("Contents", isDirectory: true)
        try FileManager.default.createDirectory(
            at: contents.appendingPathComponent("MacOS", isDirectory: true),
            withIntermediateDirectories: true
        )
        try FileManager.default.createDirectory(
            at: contents.appendingPathComponent("Resources", isDirectory: true),
            withIntermediateDirectories: true
        )
        let info: [String: Any] = [
            "CFBundleIdentifier": "dev.cchaha.tests.cursor-resources.\(UUID().uuidString)",
            "CFBundleName": "Cursor Resource Fixture",
            "CFBundlePackageType": "APPL",
            "CFBundleExecutable": "fixture-helper",
        ]
        try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0)
            .write(to: contents.appendingPathComponent("Info.plist"))
        try Data().write(to: contents.appendingPathComponent("MacOS/fixture-helper"))
        bundle = try XCTUnwrap(Bundle(url: application))
    }

    func sequence(at relativeRoot: String) throws -> URL {
        let directory = application.appendingPathComponent(relativeRoot, isDirectory: true)
            .appendingPathComponent("LensSequence", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    func png(width: Int, to url: URL) throws {
        let context = try XCTUnwrap(CGContext(
            data: nil, width: width, height: 2, bitsPerComponent: 8,
            bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ))
        context.setFillColor(CGColor(gray: 1, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: 2))
        let image = try XCTUnwrap(context.makeImage())
        let destination = try XCTUnwrap(CGImageDestinationCreateWithURL(
            url as CFURL, UTType.png.identifier as CFString, 1, nil
        ))
        CGImageDestinationAddImage(destination, image, nil)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
    }

    func remove() {
        try? FileManager.default.removeItem(at: root)
    }
}
