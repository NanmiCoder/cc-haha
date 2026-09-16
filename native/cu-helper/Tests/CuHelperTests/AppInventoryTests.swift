import Foundation
import XCTest
@testable import cc_haha_computer_use

final class AppInventoryTests: XCTestCase {
    func testRunningAndRecentMetadataMergeWithoutDroppingUsageOrAddingUnseenApps() throws {
        let date = Date(timeIntervalSince1970: 1_783_200_000)
        let recent = [
            AppInventoryEntry(id: "dev.fixture.running", displayName: "Indexed", isRunning: false, lastUsedDate: date, useCount: 12),
            AppInventoryEntry(id: "dev.fixture.recent", displayName: "Recent", isRunning: false, lastUsedDate: date, useCount: 3),
        ]
        let running = [AppRef(bundleId: "dev.fixture.running", displayName: "Live"), AppRef(bundleId: "dev.fixture.new", displayName: "New")]
        let result = AppInventory.merge(running: running, recent: recent)
        XCTAssertEqual(result.map(\.id), ["dev.fixture.running", "dev.fixture.new", "dev.fixture.recent"])
        XCTAssertEqual(result.map(\.isRunning), [true, true, false])
        XCTAssertEqual(result[0].displayName, "Live")
        XCTAssertEqual(result[0].useCount, 12)
        XCTAssertEqual(result[0].lastUsedDate, date)
        XCTAssertNil(result[1].useCount)
        XCTAssertNil(result[1].lastUsedDate)
        let data = try JSONEncoder().encode(result[1])
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(json["id"] as? String, "dev.fixture.new")
        XCTAssertNil(json["useCount"])
        XCTAssertNil(json["lastUsedDate"])
    }

    func testMetadataSchemaPreservesDatesAndIgnoresMalformedUsage() throws {
        let date = Date(timeIntervalSince1970: 1_783_200_000)
        let fields: [String: Any] = [
            "kMDItemCFBundleIdentifier": "dev.fixture", "kMDItemDisplayName": "Fixture",
            "kMDItemLastUsedDate_Ranking": date, "kMDItemUseCount": 7,
        ]
        let entry = try XCTUnwrap(AppInventory.fromMetadata(fields))
        XCTAssertEqual(entry.lastUsedDate, date)
        XCTAssertEqual(entry.useCount, 7)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(entry)) as? [String: Any])
        XCTAssertEqual(json["lastUsedDate"] as? String, ISO8601DateFormatter().string(from: date))
        XCTAssertNil(AppInventory.fromMetadata(["kMDItemDisplayName": "missing identity"]))
        XCTAssertNil(AppInventory.fromMetadata(fields.merging(["kMDItemUseCount": -1]) { _, new in new })?.useCount)
    }

    func testDiscoveryDoesNotConflateForbiddenTargetsWithMissingApplications() {
        let recent = [
            AppInventoryEntry(id: "dev.fixture", displayName: "Duplicate", isRunning: false),
            AppInventoryEntry(id: "com.apple.Terminal", displayName: "Terminal", isRunning: false),
            AppInventoryEntry(id: "com.apple.Music", displayName: "Music", isRunning: false),
        ]
        let result = AppInventory.merge(running: [AppRef(bundleId: "dev.fixture", displayName: "Fixture")], recent: recent)
        XCTAssertEqual(result.map(\.id), ["dev.fixture", "com.apple.Terminal", "com.apple.Music"])
    }
}
