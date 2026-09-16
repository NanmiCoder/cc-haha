import XCTest
@testable import cc_haha_computer_use

@MainActor
final class RendererAttributeReuseTests: XCTestCase {
    func testKnownFingerprintScalarsAndSuccessfulSettableAvoidBackendRepeats() {
        var reads = 0
        func read(_ value: String) -> String { reads += 1; return value }
        let observation = RendererAttributeReuse(
            title: read("Title"), description: read("Description"), role: read("AXButton")
        )
        XCTAssertEqual(observation.title { read("Title") }, "Title")
        XCTAssertEqual(observation.description { read("Description") }, "Description")
        XCTAssertEqual(observation.role { read("AXButton") }, "AXButton")
        for _ in 0..<2 {
            XCTAssertEqual(observation.settable { reads += 1; return false }, false)
        }
        XCTAssertEqual(reads, 4, "three fingerprint reads plus one settable query, instead of eight")
    }

    func testMissingScalarsRetryAndCacheOnlyLaterSuccess() {
        let observation = RendererAttributeReuse(title: nil, description: nil, role: nil)
        var reads = 0
        for get in [observation.title, observation.description, observation.role] {
            XCTAssertNil(get { reads += 1; return nil })
            XCTAssertEqual(get { reads += 1; return "recovered" }, "recovered")
            XCTAssertEqual(get { reads += 1; return "changed" }, "recovered")
        }
        XCTAssertEqual(reads, 6)
    }

    func testSettableFailureRetriesButSuccessfulFalseDoesNot() {
        let observation = RendererAttributeReuse(title: nil, description: nil, role: nil)
        var reads = 0
        XCTAssertNil(observation.settable { reads += 1; return nil })
        XCTAssertEqual(observation.settable { reads += 1; return false }, false)
        XCTAssertEqual(observation.settable { reads += 1; return true }, false)
        XCTAssertEqual(reads, 2)
    }

    func testSeparateNodesAndRenderPassesNeverShareObservations() {
        let first = RendererAttributeReuse(title: "Same", description: nil, role: "AXButton")
        let duplicate = RendererAttributeReuse(title: "Same", description: nil, role: "AXButton")
        XCTAssertEqual(first.settable { true }, true)
        XCTAssertEqual(duplicate.settable { false }, false)
        let nextPass = RendererAttributeReuse(title: "Changed", description: nil, role: "AXButton")
        XCTAssertEqual(nextPass.title { "wrong" }, "Changed")
        XCTAssertEqual(nextPass.settable { false }, false)
    }
}
