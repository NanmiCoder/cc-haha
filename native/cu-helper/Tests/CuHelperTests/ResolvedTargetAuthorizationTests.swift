import XCTest
@testable import cc_haha_computer_use

final class ResolvedTargetAuthorizationTests: XCTestCase {
    private let terminalIdentity = AXTreeProcessIdentity(
        bundleID: "com.apple.Terminal",
        executablePath: "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal",
        launchTime: 100
    )
    private let calculatorIdentity = AXTreeProcessIdentity(
        bundleID: "com.apple.calculator",
        executablePath: "/System/Applications/Calculator.app/Contents/MacOS/Calculator",
        launchTime: 200
    )
    private let chromeIdentity = AXTreeProcessIdentity(
        bundleID: "com.google.Chrome",
        executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        launchTime: 300
    )

    func testChromePIDBundleNameAndPathSelectorsPreserveExactProvenIdentity() throws {
        let chrome = AppTargetCandidate(
            pid: 43,
            bundleIdentifier: "com.google.Chrome",
            bundleURL: URL(fileURLWithPath: "/Applications/Google Chrome.app"),
            localizedName: "Google Chrome",
            executableName: "Google Chrome"
        )
        let selectors: [AppTargetSelector] = [
            .pid(43),
            .bundleIdentifier("com.google.Chrome"),
            .app("com.google.Chrome"),
            .app("Google Chrome"),
            .app("Google Chrome.app"),
            .app("/Applications/Google Chrome.app"),
        ]

        for selector in selectors {
            let resolved = try XCTUnwrap(
                AppTargetResolver.resolve(selector: selector, candidates: [chrome])
            )
            let target = try ResolvedTargetAuthorization.authorize(
                resolved: resolved,
                currentIdentity: chromeIdentity
            )
            XCTAssertEqual(target.pid, chrome.pid)
            XCTAssertEqual(target.identity, chromeIdentity)
        }
    }

    func testAllowingChromeStillRejectsUnprovenOrMismatchedIdentity() {
        let unproven = AXTreeProcessIdentity(
            bundleID: chromeIdentity.bundleID,
            executablePath: chromeIdentity.executablePath,
            launchTime: nil
        )
        XCTAssertThrowsError(try ResolvedTargetAuthorization.authorize(
            pid: 43, identity: unproven, expectedBundleID: "com.google.Chrome"
        )) {
            XCTAssertEqual(($0 as? CUError)?.code, "app_denied")
        }
        XCTAssertThrowsError(try ResolvedTargetAuthorization.authorize(
            pid: 43, identity: terminalIdentity, expectedBundleID: "com.google.Chrome"
        )) {
            XCTAssertEqual(($0 as? CUError)?.code, "stale_process")
        }
    }

    func testNumericPIDAllowsTerminalAfterGlobalEnablement() throws {
        let target = try ResolvedTargetAuthorization.authorize(
            pid: 41,
            identity: terminalIdentity,
            expectedBundleID: nil
        )

        XCTAssertEqual(target.pid, 41)
        XCTAssertEqual(target.identity, terminalIdentity)
    }

    func testEveryAppCategoryAndHostAreAllowedWithProvenProcessIdentity() throws {
        let bundleIDs = [
            "com.google.Chrome",
            "com.apple.Safari",
            "com.apple.Terminal",
            "com.microsoft.VSCode",
            "com.apple.shortcuts",
            "com.webull.desktop.v1",
            "com.binance.BinanceDesktop",
            "com.ledger.live",
            "com.spotify.client",
            "com.apple.Music",
            "com.amazon.Kindle",
            "com.claude-code-haha.desktop",
            "dev.cchaha.cu-helper",
            "com.example.custom-host",
            "com.example.new-app",
        ]
        for bundleID in bundleIDs {
            let identity = AXTreeProcessIdentity(
                bundleID: bundleID,
                executablePath: "/Applications/Fixture.app/Contents/MacOS/Fixture",
                launchTime: 100
            )
            let target = try ResolvedTargetAuthorization.authorize(
                pid: 41,
                identity: identity,
                expectedBundleID: bundleID
            )
            XCTAssertEqual(target.pid, 41, bundleID)
            XCTAssertEqual(target.identity, identity, bundleID)
        }
    }

    func testPIDBundleAndLocalizedNameSelectorsAllAuthorizeActualResolvedBundle() throws {
        let terminal = AppTargetCandidate(
            pid: 41,
            bundleIdentifier: "com.apple.Terminal",
            bundleURL: URL(fileURLWithPath: "/System/Applications/Utilities/Terminal.app"),
            localizedName: "终端",
            executableName: "Terminal"
        )
        let selectors: [AppTargetSelector] = [
            .pid(41),
            .bundleIdentifier("com.apple.Terminal"),
            .app("终端"),
        ]

        for selector in selectors {
            let resolved = try XCTUnwrap(
                AppTargetResolver.resolve(selector: selector, candidates: [terminal])
            )
            let target = try ResolvedTargetAuthorization.authorize(
                resolved: resolved,
                currentIdentity: terminalIdentity
            )
            XCTAssertEqual(target.pid, 41)
            XCTAssertEqual(target.identity, terminalIdentity)
        }
    }

    func testWorktreeHostPathResolutionAuthorizesExactProcess() throws {
        let installed = AppTargetCandidate(
            pid: 100,
            bundleIdentifier: "com.claude-code-haha.desktop",
            bundleURL: URL(fileURLWithPath: "/Applications/Claude Code Haha.app"),
            localizedName: "Claude Code Haha",
            executableName: "Claude Code Haha"
        )
        let worktree = AppTargetCandidate(
            pid: 200,
            bundleIdentifier: installed.bundleIdentifier,
            bundleURL: URL(fileURLWithPath: "/Users/test/worktree/desktop/build-artifacts/macos-arm64/Claude Code Haha.app"),
            localizedName: installed.localizedName,
            executableName: installed.executableName
        )
        let resolved = try AppTargetResolver.match(
            identifier: worktree.bundleURL!.path,
            candidates: [installed, worktree]
        )
        let identity = AXTreeProcessIdentity(
            bundleID: worktree.bundleIdentifier,
            executablePath: worktree.bundleURL!.appendingPathComponent("Contents/MacOS/Claude Code Haha").path,
            launchTime: 300
        )

        XCTAssertEqual(resolved.pid, worktree.pid)
        let target = try ResolvedTargetAuthorization.authorize(
            resolved: resolved,
            currentIdentity: identity
        )
        XCTAssertEqual(target.pid, worktree.pid)
        XCTAssertEqual(target.identity, identity)
    }

    func testOmittedFrontmostAndLaunchedTargetsUseSameActualBundlePolicy() throws {
        // Both paths ultimately produce this same resolved target shape. The
        // authorizer intentionally has no selector-specific bypass.
        let resolved = ResolvedAppTarget(
            pid: 41,
            bundleIdentifier: "com.apple.Terminal",
            bundleURL: URL(fileURLWithPath: "/System/Applications/Utilities/Terminal.app")
        )

        for _ in ["omitted-frontmost", "launched-get-app-state"] {
            let target = try ResolvedTargetAuthorization.authorize(
                resolved: resolved,
                currentIdentity: terminalIdentity
            )
            XCTAssertEqual(target.pid, 41)
            XCTAssertEqual(target.identity, terminalIdentity)
        }
    }

    func testAllowedResolvedTargetReturnsExactProvenProcessLifetime() throws {
        let target = try ResolvedTargetAuthorization.authorize(
            pid: 42,
            identity: calculatorIdentity,
            expectedBundleID: "com.apple.calculator"
        )

        XCTAssertEqual(target.pid, 42)
        XCTAssertEqual(target.identity, calculatorIdentity)
    }

    func testMissingBundleAndResolverIdentityMismatchFailClosed() {
        let missingBundle = AXTreeProcessIdentity(
            bundleID: nil,
            executablePath: "/Applications/Unknown.app/Contents/MacOS/Unknown",
            launchTime: 100
        )

        XCTAssertThrowsError(
            try ResolvedTargetAuthorization.authorize(
                pid: 42,
                identity: missingBundle,
                expectedBundleID: nil
            )
        ) {
            XCTAssertEqual(($0 as? CUError)?.code, "app_denied")
        }

        XCTAssertThrowsError(
            try ResolvedTargetAuthorization.authorize(
                pid: 42,
                identity: calculatorIdentity,
                expectedBundleID: "com.example.reused"
            )
        ) {
            XCTAssertEqual(($0 as? CUError)?.code, "stale_process")
        }
    }
}
