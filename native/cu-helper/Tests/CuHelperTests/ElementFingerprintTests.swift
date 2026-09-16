import XCTest
@testable import cc_haha_computer_use

final class ElementFingerprintTests: XCTestCase {
    private func button(_ identifier: String) -> ElementFingerprint {
        ElementFingerprint(
            role: "AXButton",
            subrole: nil,
            identifier: identifier,
            title: identifier.capitalized,
            valueKind: nil
        )
    }

    func testSameSemanticElementMatchesWhenValueChanges() {
        let old = ElementFingerprint(
            role: "AXTextField",
            subrole: nil,
            identifier: "search",
            title: "Search",
            valueKind: "string"
        )
        let fresh = ElementFingerprint(
            role: "AXTextField",
            subrole: nil,
            identifier: "search",
            title: "Search",
            valueKind: "string"
        )

        XCTAssertTrue(old.matches(fresh))
    }

    func testFingerprintsAndPathStepsAreHashableForUniqueLocatorReconciliation() throws {
        let search = ElementFingerprint(
            role: "AXTextField",
            subrole: nil,
            identifier: "search",
            title: "Search",
            valueKind: "string"
        )
        let step = try XCTUnwrap(
            SnapshotPathStep(selectedIndex: 0, childFingerprints: [search])
        )

        XCTAssertEqual(Set([search, search]).count, 1)
        XCTAssertEqual(Set([step, step]).count, 1)
    }

    func testDifferentIdentifierIsStale() {
        let old = ElementFingerprint(
            role: "AXButton",
            subrole: nil,
            identifier: "save",
            title: "Save",
            valueKind: nil
        )
        let fresh = ElementFingerprint(
            role: "AXButton",
            subrole: nil,
            identifier: "delete",
            title: "Delete",
            valueKind: nil
        )

        XCTAssertFalse(old.matches(fresh))
    }

    func testSnapshotElementHandleFormatsAndParsesRoundTrip() throws {
        let handle = SnapshotElementHandle(snapshotID: 17, index: 4)

        XCTAssertEqual(handle.rawValue, "g17:4")
        XCTAssertEqual(try XCTUnwrap(SnapshotElementHandle(rawValue: handle.rawValue)), handle)
    }

    func testSnapshotElementHandleRejectsBareAndNonCanonicalNumbers() {
        XCTAssertNil(SnapshotElementHandle(rawValue: "4"))
        XCTAssertNil(SnapshotElementHandle(rawValue: "g17:04"))
        XCTAssertNil(SnapshotElementHandle(rawValue: "g0:4"))
        XCTAssertNil(SnapshotElementHandle(rawValue: " g17:4"))
    }

    func testPathStepRejectsSiblingInsertion() throws {
        let save = button("save")
        let cancel = button("cancel")
        let step = try XCTUnwrap(
            SnapshotPathStep(selectedIndex: 0, childFingerprints: [save, cancel])
        )

        XCTAssertNil(step.selectedIndex(in: [button("new"), save, cancel]))
    }

    func testPathStepRejectsSiblingReorder() throws {
        let save = button("save")
        let cancel = button("cancel")
        let step = try XCTUnwrap(
            SnapshotPathStep(selectedIndex: 0, childFingerprints: [save, cancel])
        )

        XCTAssertNil(step.selectedIndex(in: [cancel, save]))
    }

    func testPathStepRejectsDuplicateSelectedFingerprint() {
        let save = button("save")

        XCTAssertNil(
            SnapshotPathStep(selectedIndex: 0, childFingerprints: [save, save])
        )
    }

    func testPathStepUsesUniqueChildTopologyForDuplicateAncestor() throws {
        let group = ElementFingerprint(
            role: "AXGroup",
            subrole: nil,
            identifier: nil,
            title: nil,
            valueKind: nil
        )
        let formatting = ["Bold", "Italic", "Underline"].map { label in
            ElementFingerprint(
                role: "AXCheckBox",
                subrole: "AXSegment",
                identifier: nil,
                title: nil,
                label: label,
                valueKind: "boolean"
            )
        }
        let alignment = ["Align Left", "Align Center", "Align Right"].map { label in
            ElementFingerprint(
                role: "AXCheckBox",
                subrole: "AXSegment",
                identifier: nil,
                title: nil,
                label: label,
                valueKind: "boolean"
            )
        }
        let publishedTopologies = [formatting, alignment]
        let step = try XCTUnwrap(
            SnapshotPathStep(
                selectedIndex: 0,
                childFingerprints: [group, group],
                childTopologyAt: { publishedTopologies[$0] }
            )
        )

        XCTAssertEqual(
            step.selectedIndex(
                in: [group, group],
                childTopologyAt: { [alignment, formatting][$0] }
            ),
            1
        )
        XCTAssertNil(
            step.selectedIndex(
                in: [group, group],
                childTopologyAt: { _ in formatting }
            )
        )
    }

    func testPathStepRejectsDuplicateAncestorWithIdenticalChildTopology() {
        let group = ElementFingerprint(
            role: "AXGroup",
            subrole: nil,
            identifier: nil,
            title: nil,
            valueKind: nil
        )
        let formatting = [button("bold"), button("italic")]

        XCTAssertNil(
            SnapshotPathStep(
                selectedIndex: 0,
                childFingerprints: [group, group],
                childTopologyAt: { _ in formatting }
            )
        )
    }

    func testDescriptionOnlySiblingControlsRemainUniquelyAddressable() throws {
        let controls = ["Bold", "Italic", "Underline"].map { label in
            ElementFingerprint(
                role: "AXCheckBox",
                subrole: nil,
                identifier: nil,
                title: nil,
                label: label,
                valueKind: "boolean"
            )
        }

        let bold = try XCTUnwrap(
            SnapshotPathStep(selectedIndex: 0, childFingerprints: controls)
        )
        XCTAssertEqual(bold.selectedIndex(in: controls), 0)
    }

    func testWindowTitlesRequireSymmetricEvidence() {
        XCTAssertTrue(SnapshotWindowIdentityEvidence.titlesMatch(axTitle: " Docs ", cgTitle: "Docs"))
        XCTAssertTrue(SnapshotWindowIdentityEvidence.titlesMatch(axTitle: nil, cgTitle: nil))
        XCTAssertFalse(SnapshotWindowIdentityEvidence.titlesMatch(axTitle: nil, cgTitle: "Docs"))
        XCTAssertFalse(SnapshotWindowIdentityEvidence.titlesMatch(axTitle: "Docs", cgTitle: nil))
        XCTAssertFalse(SnapshotWindowIdentityEvidence.titlesMatch(axTitle: "Docs", cgTitle: "Other"))
    }

    func testDuplicateSnapshotWindowIDInvalidatesEveryRoot() {
        let mappings: [UInt32?] = [11, 11, nil]

        XCTAssertEqual(
            SnapshotWindowIdentityEvidence.validateUniqueRootIDs(mappings),
            [nil, nil, nil]
        )
    }

    func testUniqueSnapshotWindowIDsRemainVerifiable() {
        let mappings: [UInt32?] = [11, nil, 12]

        XCTAssertEqual(
            SnapshotWindowIdentityEvidence.validateUniqueRootIDs(mappings),
            mappings
        )
    }

    func testWindowMappingPrefersUniqueFrameAndBilateralTitleEvidence() {
        let candidates = [
            SnapshotWindowIdentityEvidence.Candidate(
                id: 11,
                frameMatches: true,
                title: "Document"
            ),
            SnapshotWindowIdentityEvidence.Candidate(
                id: 12,
                frameMatches: false,
                title: "Document"
            ),
        ]

        XCTAssertEqual(
            SnapshotWindowIdentityEvidence.mappedWindowID(
                axTitle: "Document",
                candidates: candidates
            ),
            11
        )
    }

    func testNativeWindowIDMatchesChromeDespiteDecoratedAXAndAudioCGTitles() {
        let candidates = [
            SnapshotWindowIdentityEvidence.Candidate(id: 17673, frameMatches: false, title: "Window"),
            SnapshotWindowIdentityEvidence.Candidate(id: 16290, frameMatches: true, title: "“Townscaper”🔊"),
        ]
        XCTAssertNil(SnapshotWindowIdentityEvidence.mappedWindowID(
            axTitle: "Townscaper - Google Chrome - Mi", candidates: candidates
        ))
        XCTAssertEqual(SnapshotWindowIdentityEvidence.mappedWindowID(
            axTitle: "Townscaper - Google Chrome - Mi", candidates: candidates,
            nativeWindowID: 16290
        ), 16290)
    }

    func testNativeWindowIDSurvivesMissingTitleAndMovedFrame() {
        XCTAssertEqual(SnapshotWindowIdentityEvidence.mappedWindowID(
            axTitle: "Document", candidates: [
                .init(id: 11, frameMatches: false, title: nil),
            ], nativeWindowID: 11
        ), 11)
    }

    func testNativeWindowIDOutsideTargetCandidatesCannotFallBackToLookalike() {
        XCTAssertNil(SnapshotWindowIdentityEvidence.mappedWindowID(
            axTitle: "Document", candidates: [
                .init(id: 11, frameMatches: true, title: "Document"),
            ], nativeWindowID: 12
        ))
    }

    func testAmbiguousNativeWindowIDIsRejected() {
        XCTAssertNil(SnapshotWindowIdentityEvidence.mappedWindowID(
            axTitle: "Document", candidates: [
                .init(id: 11, frameMatches: true, title: "Document"),
                .init(id: 11, frameMatches: false, title: "Other"),
            ], nativeWindowID: 11
        ))
    }

    func testUnavailableNativeWindowIDPreservesStrictTitleFallback() {
        let candidates = [SnapshotWindowIdentityEvidence.Candidate(
            id: 11, frameMatches: true, title: "Document"
        )]
        XCTAssertEqual(SnapshotWindowIdentityEvidence.mappedWindowID(
            axTitle: "Document", candidates: candidates, nativeWindowID: 0
        ), 11)
        XCTAssertNil(SnapshotWindowIdentityEvidence.mappedWindowID(
            axTitle: "Other", candidates: candidates, nativeWindowID: 0
        ))
    }

    func testStageManagerFallsBackToUniqueBilateralTitleWhenNoFrameMatches() {
        let candidates = [
            SnapshotWindowIdentityEvidence.Candidate(
                id: 11,
                frameMatches: false,
                title: "Untitled"
            ),
            SnapshotWindowIdentityEvidence.Candidate(
                id: 12,
                frameMatches: false,
                title: "Other"
            ),
        ]

        XCTAssertEqual(
            SnapshotWindowIdentityEvidence.mappedWindowID(
                axTitle: " Untitled ",
                candidates: candidates
            ),
            11
        )
    }

    func testStageManagerTitleFallbackRejectsDuplicateTitles() {
        let candidates = [
            SnapshotWindowIdentityEvidence.Candidate(
                id: 11,
                frameMatches: false,
                title: "Untitled"
            ),
            SnapshotWindowIdentityEvidence.Candidate(
                id: 12,
                frameMatches: false,
                title: " Untitled "
            ),
        ]

        XCTAssertNil(
            SnapshotWindowIdentityEvidence.mappedWindowID(
                axTitle: "Untitled",
                candidates: candidates
            )
        )
    }

    func testStageManagerTitleFallbackRequiresAXTitle() {
        let candidates = [
            SnapshotWindowIdentityEvidence.Candidate(
                id: 11,
                frameMatches: false,
                title: nil
            ),
        ]

        XCTAssertNil(
            SnapshotWindowIdentityEvidence.mappedWindowID(
                axTitle: nil,
                candidates: candidates
            )
        )
    }

    func testStageManagerTitleFallbackRejectsOneSidedTitleEvidence() {
        let candidates = [
            SnapshotWindowIdentityEvidence.Candidate(
                id: 11,
                frameMatches: false,
                title: nil
            ),
        ]

        XCTAssertNil(
            SnapshotWindowIdentityEvidence.mappedWindowID(
                axTitle: "Untitled",
                candidates: candidates
            )
        )
    }

    func testStageManagerTitleFallbackDoesNotBypassExistingFrameCandidate() {
        let candidates = [
            SnapshotWindowIdentityEvidence.Candidate(
                id: 11,
                frameMatches: true,
                title: "Wrong"
            ),
            SnapshotWindowIdentityEvidence.Candidate(
                id: 12,
                frameMatches: false,
                title: "Untitled"
            ),
        ]

        XCTAssertNil(
            SnapshotWindowIdentityEvidence.mappedWindowID(
                axTitle: "Untitled",
                candidates: candidates
            )
        )
    }
}
