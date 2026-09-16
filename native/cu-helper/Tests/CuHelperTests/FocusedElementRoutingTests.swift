import XCTest

@testable import cc_haha_computer_use

@MainActor
final class FocusedElementRoutingTests: XCTestCase {
    func testBackgroundTargetNeverContactsUnrelatedSystemFocusServer() {
        var globalQueries = 0
        let result = FocusedElementRouting.select(
            targetPID: 42, frontmostPID: 99,
            systemFocusedPID: { globalQueries += 1; return 99 },
            systemFocusedElement: { globalQueries += 1; return "other-app" },
            targetFocusedElement: { "target" }
        )
        XCTAssertEqual(result, "target")
        XCTAssertEqual(globalQueries, 0, "a background snapshot must not wait for an unrelated AX server")
    }

    func testForegroundTargetKeepsValidatedSystemFocus() {
        let result = FocusedElementRouting.select(
            targetPID: 42, frontmostPID: 42,
            systemFocusedPID: { 42 },
            systemFocusedElement: { "target-system-focus" },
            targetFocusedElement: { XCTFail("valid system focus should retain precedence"); return "target-fallback" }
        )
        XCTAssertEqual(result, "target-system-focus")
    }

    func testForegroundHintDoesNotAuthorizeAnotherProcessAfterFocusChanges() {
        let result = FocusedElementRouting.select(
            targetPID: 42, frontmostPID: 42,
            systemFocusedPID: { 99 },
            systemFocusedElement: { XCTFail("must retain system AX PID validation"); return "other-app" },
            targetFocusedElement: { "target" }
        )
        XCTAssertEqual(result, "target")
    }

    func testUnknownFrontmostStillUsesSystemAXWithPIDValidation() {
        for focusedPID: Int32? in [42, 99, nil] {
            var queries = 0
            let result = FocusedElementRouting.select(
                targetPID: 42, frontmostPID: nil,
                systemFocusedPID: { queries += 1; return focusedPID },
                systemFocusedElement: { "system" },
                targetFocusedElement: { "target" }
            )
            XCTAssertEqual(queries, 1)
            XCTAssertEqual(result, focusedPID == 42 ? "system" : "target")
        }
    }

    func testMissingSystemElementFallsBackToTargetAndMissingTargetStaysNil() {
        let result: String? = FocusedElementRouting.select(
            targetPID: 42, frontmostPID: 42,
            systemFocusedPID: { 42 },
            systemFocusedElement: { nil },
            targetFocusedElement: { "target" }
        )
        XCTAssertEqual(result, "target")
        let absent: String? = FocusedElementRouting.select(
            targetPID: 42, frontmostPID: 99,
            systemFocusedPID: { XCTFail("must not contact another app"); return 99 },
            systemFocusedElement: { "other-app" },
            targetFocusedElement: { nil }
        )
        XCTAssertNil(absent)
    }
}
