import XCTest
@testable import cc_haha_computer_use

#if DEBUG
final class ProcessValidationObservationTests: XCTestCase {
    @MainActor
    func testObserverSeesTheActualFailedComparisonWithoutAllowingTheTarget() throws {
        let expected = try XCTUnwrap(ProvenProcessTarget(
            pid: .max,
            identity: AXTreeProcessIdentity(
                bundleID: "dev.cchaha.tests.missing",
                executablePath: "/missing/process",
                launchTime: 100
            )
        ))
        let previous = Injection.targetValidationObserver
        defer { Injection.targetValidationObserver = previous }
        var observed: [(ProvenProcessTarget, AXTreeProcessIdentity?)] = []
        Injection.targetValidationObserver = { observed.append(($0, $1)) }
        XCTAssertThrowsError(try Injection.validateAuthorizedTarget(expected)) {
            XCTAssertEqual(($0 as? CUError)?.code, "stale_process")
        }
        XCTAssertEqual(observed.count, 1)
        XCTAssertEqual(observed.first?.0, expected)
        XCTAssertNil(observed.first?.1)
    }
}
#endif
