import AppKit
import Darwin
import Foundation

enum ForegroundDecision: Equatable, Sendable {
    case unchanged
    case restore(pid_t)
    case userInterference
    case userInterferenceResultUnknown
    case isolationUnavailable
}

/// One race-bounded observation in the required order:
/// input snapshot -> frontmost process identity -> input snapshot.
struct ForegroundEvidence: Equatable, Sendable {
    let epochBefore: UInt64
    let frontmost: ProvenProcessTarget?
    let epochAfter: UInt64
    let monitorAvailableBefore: Bool
    let monitorAvailableAfter: Bool
    let continuityGenerationBefore: UInt64
    let continuityGenerationAfter: UInt64

    var epochIsStable: Bool { epochBefore == epochAfter }
    var continuityIsStable: Bool {
        continuityGenerationBefore == continuityGenerationAfter
    }
    var monitorIsContinuouslyAvailable: Bool {
        monitorAvailableBefore
            && monitorAvailableAfter
            && continuityIsStable
    }
}

/// Immutable evidence retained across one mutation. `original == nil` means
/// there was no provable frontmost app at acquisition; that is safe only while
/// finalization also observes nil.
struct ForegroundLeaseSnapshot: Equatable, Sendable {
    let original: ProvenProcessTarget?
    let target: ProvenProcessTarget
    let acquiredEpoch: UInt64
    let acquiredContinuityGeneration: UInt64
    let monitorAvailable: Bool
}

enum ForegroundLeasePolicy {
    static func decision(
        lease: ForegroundLeaseSnapshot,
        finalEvidence: ForegroundEvidence,
        currentOriginalIdentity: AXTreeProcessIdentity?
    ) throws -> ForegroundDecision {
        // When the target was already foreground, the user's physical input
        // lands in the SAME app as PID-directed Agent input. Even though focus
        // did not move, an epoch change means the streams may have interleaved
        // and the mutation result is unknown; it must not be reported success
        // or retried. A monitor gap is likewise unsafe.
        if finalEvidence.frontmost == lease.original {
            if lease.original == lease.target {
                guard lease.monitorAvailable,
                      finalEvidence.monitorIsContinuouslyAvailable,
                      finalEvidence.continuityGenerationBefore
                        == lease.acquiredContinuityGeneration else {
                    return .isolationUnavailable
                }
                guard finalEvidence.epochIsStable,
                      finalEvidence.epochBefore == lease.acquiredEpoch else {
                    return .userInterferenceResultUnknown
                }
            }
            return .unchanged
        }

        // If the target was already foreground, never activate anything. A
        // different or nil final frontmost belongs to the user/system.
        if lease.original == lease.target {
            return .userInterference
        }

        // Third app, nil after a proven original, or a recycled target pid.
        guard finalEvidence.frontmost == lease.target else {
            return .userInterference
        }

        // nil -> target means the action stole foreground but there is no
        // original identity to restore. Never invent a fallback.
        guard let original = lease.original else {
            throw CUError(
                "focus_restore_failed",
                "The target took foreground but no proven original application was available to restore."
            )
        }

        // A disabled/restarted event tap creates an unobservable gap even when
        // it successfully re-enabled and the numeric epoch did not change.
        guard lease.monitorAvailable,
              finalEvidence.monitorIsContinuouslyAvailable,
              finalEvidence.continuityGenerationBefore
                == lease.acquiredContinuityGeneration else {
            return .isolationUnavailable
        }

        guard finalEvidence.epochIsStable,
              finalEvidence.epochBefore == lease.acquiredEpoch else {
            return .userInterference
        }

        guard original.validatedPid(
            currentIdentity: currentOriginalIdentity
        ) != nil else {
            throw CUError(
                "focus_restore_failed",
                "The original foreground application exited or changed process identity; focus was not restored."
            )
        }

        return .restore(original.pid)
    }
}

/// AppKit/monitor seams. `activate` takes the complete expected process identity,
/// not a pid, so production can revalidate inside the one activation closure and
/// close the policy-check -> activation PID-reuse window.
@MainActor
struct ForegroundLeaseRuntime {
    let inputSnapshot: () -> PhysicalInputEpochSnapshot
    let frontmostTarget: () -> ProvenProcessTarget?
    let currentIdentity: (pid_t) -> AXTreeProcessIdentity?
    let activate: (ProvenProcessTarget) -> Bool
    let verifyFrontmost: (ProvenProcessTarget) async -> Bool

    static func live(monitor: PhysicalInputEpochMonitor) -> ForegroundLeaseRuntime {
        ForegroundLeaseRuntime(
            inputSnapshot: { monitor.snapshot },
            frontmostTarget: { currentFrontmostTarget() },
            currentIdentity: { AXTree.currentProcessIdentity(pid: $0) },
            activate: { expected in
                guard let app = NSRunningApplication(
                    processIdentifier: expected.pid
                ) else { return false }

                // Build identity from the exact application object that will be
                // activated. Do not validate one lookup and activate another.
                let liveIdentity = AXTreeProcessIdentity(
                    bundleID: app.bundleIdentifier,
                    executablePath: app.executableURL?.path,
                    launchTime: app.launchDate?.timeIntervalSinceReferenceDate
                )
                guard expected.validatedPid(
                    currentIdentity: liveIdentity
                ) != nil else { return false }

                return app.activate(options: [])
            },
            verifyFrontmost: { expected in
                // One bounded settle, then exactly one identity observation. No
                // polling and no activation retry.
                try? await Task.sleep(nanoseconds: 100_000_000)
                return currentFrontmostTarget() == expected
            }
        )
    }

    private static func currentFrontmostTarget() -> ProvenProcessTarget? {
        guard let app = NSWorkspace.shared.frontmostApplication else {
            return nil
        }
        let identity = AXTreeProcessIdentity(
            bundleID: app.bundleIdentifier,
            executablePath: app.executableURL?.path,
            launchTime: app.launchDate?.timeIntervalSinceReferenceDate
        )
        return ProvenProcessTarget(pid: app.processIdentifier, identity: identity)
    }
}

@MainActor
final class ForegroundLease {
    private let snapshot: ForegroundLeaseSnapshot
    private let runtime: ForegroundLeaseRuntime
    private var didFinalize = false

    private init(
        snapshot: ForegroundLeaseSnapshot,
        runtime: ForegroundLeaseRuntime
    ) {
        self.snapshot = snapshot
        self.runtime = runtime
    }

    static func acquire(
        target: ProvenProcessTarget,
        runtime: ForegroundLeaseRuntime
    ) throws -> ForegroundLease {
        guard target.validatedPid(
            currentIdentity: runtime.currentIdentity(target.pid)
        ) != nil else {
            throw CUError(
                "target_not_running",
                "The mutation target exited or changed process identity before foreground isolation began."
            )
        }

        let evidence = captureEvidence(runtime: runtime)
        guard evidence.monitorIsContinuouslyAvailable else {
            throw CUError(
                "focus_isolation_unavailable",
                "Physical-input monitoring was unavailable or lost continuity while foreground isolation was being acquired; the action was not run."
            )
        }
        guard evidence.epochIsStable else {
            throw CUError(
                "user_interference",
                "Physical input changed while foreground isolation was being acquired; the action was not run."
            )
        }

        return ForegroundLease(
            snapshot: ForegroundLeaseSnapshot(
                original: evidence.frontmost,
                target: target,
                acquiredEpoch: evidence.epochAfter,
                acquiredContinuityGeneration:
                    evidence.continuityGenerationAfter,
                monitorAvailable: evidence.monitorIsContinuouslyAvailable
            ),
            runtime: runtime
        )
    }

    /// Exactly-once safety finalization. Safety errors are authoritative over an
    /// action error and retain it as diagnostic context.
    func finalize(actionError: Error? = nil) async throws {
        guard !didFinalize else {
            throw CUError(
                "foreground_lease_finalized",
                "Foreground isolation was already finalized for this action."
            )
        }
        didFinalize = true

        let evidence = Self.captureEvidence(runtime: runtime)
        let originalIdentity = snapshot.original.flatMap {
            runtime.currentIdentity($0.pid)
        }
        let decision: ForegroundDecision
        do {
            decision = try ForegroundLeasePolicy.decision(
                lease: snapshot,
                finalEvidence: evidence,
                currentOriginalIdentity: originalIdentity
            )
        } catch let error as CUError {
            throw attaching(actionError, to: error)
        }

        switch decision {
        case .unchanged:
            return

        case .restore:
            guard let original = snapshot.original else {
                throw attaching(
                    actionError,
                    to: CUError(
                        "focus_restore_failed",
                        "No proven original foreground application was available to restore."
                    )
                )
            }

            // Close the final-evidence -> activation race. Sample once more in
            // epoch -> frontmost identity -> epoch order immediately before the
            // one activation attempt and run the same policy over that evidence.
            let activationEvidence = Self.captureEvidence(runtime: runtime)
            let activationDecision: ForegroundDecision
            do {
                activationDecision = try ForegroundLeasePolicy.decision(
                    lease: snapshot,
                    finalEvidence: activationEvidence,
                    currentOriginalIdentity: runtime.currentIdentity(original.pid)
                )
            } catch let error as CUError {
                throw attaching(actionError, to: error)
            }
            switch activationDecision {
            case .unchanged:
                // Focus returned naturally between samples. Never activate.
                return
            case .userInterference:
                throw attaching(
                    actionError,
                    to: CUError(
                        "user_interference",
                        "Physical input or another foreground application appeared before restoration; focus was not changed."
                    )
                )
            case .userInterferenceResultUnknown:
                throw attaching(
                    actionError,
                    to: CUError(
                        "user_interference_result_unknown",
                        "Physical input may have interleaved with the action; its result is unknown and it must not be retried."
                    )
                )
            case .isolationUnavailable:
                throw attaching(
                    actionError,
                    to: CUError(
                        "focus_isolation_unavailable",
                        "Physical-input isolation became unavailable before restoration; focus was not changed."
                    )
                )
            case .restore:
                break
            }

            guard runtime.activate(original) else {
                throw attaching(
                    actionError,
                    to: CUError(
                        "focus_restore_failed",
                        "The original foreground application could not be reactivated; no fallback was attempted."
                    )
                )
            }
            guard await runtime.verifyFrontmost(original) else {
                throw attaching(
                    actionError,
                    to: CUError(
                        "focus_restore_failed",
                        "The one focus restoration attempt did not restore the original process identity; no retry was attempted."
                    )
                )
            }

        case .userInterference:
            throw attaching(
                actionError,
                to: CUError(
                    "user_interference",
                    "Physical input or another foreground application was detected; focus was not changed."
                )
            )

        case .userInterferenceResultUnknown:
            throw attaching(
                actionError,
                to: CUError(
                    "user_interference_result_unknown",
                    "Physical input may have interleaved with the action in the foreground target; its result is unknown and it must not be retried."
                )
            )

        case .isolationUnavailable:
            throw attaching(
                actionError,
                to: CUError(
                    "focus_isolation_unavailable",
                    "Physical-input isolation was unavailable after the target took foreground; focus was not changed."
                )
            )
        }
    }

    private static func captureEvidence(
        runtime: ForegroundLeaseRuntime
    ) -> ForegroundEvidence {
        let before = runtime.inputSnapshot()
        let frontmost = runtime.frontmostTarget()
        let after = runtime.inputSnapshot()
        return ForegroundEvidence(
            epochBefore: before.epoch,
            frontmost: frontmost,
            epochAfter: after.epoch,
            monitorAvailableBefore: before.available,
            monitorAvailableAfter: after.available,
            continuityGenerationBefore: before.continuityGeneration,
            continuityGenerationAfter: after.continuityGeneration
        )
    }

    private func attaching(_ actionError: Error?, to safety: CUError) -> CUError {
        guard let actionError else { return safety }
        return CUError(
            safety.code,
            "\(safety.message) The action also failed: \(actionError.localizedDescription)"
        )
    }
}

/// Runs the action and then finalizes the lease exactly once on both success and
/// failure paths. No `defer`: async restoration must complete before propagation.
@MainActor
enum ForegroundMutationRunner {
    static func run<T>(
        lease: ForegroundLease,
        targetPID: pid_t? = nil,
        action: () async throws -> T
    ) async throws -> T {
        // Every input path crosses this boundary, including synthetic events
        // that never call AXAction.settle(). A throw can follow a partial
        // delivery, so neither success nor failure may reuse pre-action pixels.
        defer { MutationClock.recordMutation(pid: targetPID) }
        let result: Result<T, Error>
        do {
            result = .success(try await action())
        } catch {
            result = .failure(error)
        }

        let actionError: Error?
        switch result {
        case .success: actionError = nil
        case .failure(let error): actionError = error
        }
        try await lease.finalize(actionError: actionError)
        return try result.get()
    }
}

enum HeldInputReleasePolicy {
    enum TeardownPlan: Equatable {
        case retainForRetry
        case discardInvalidTarget
        case postAndComplete
    }

    static func pid(
        for target: ProvenProcessTarget,
        currentIdentity: AXTreeProcessIdentity?
    ) -> pid_t? {
        target.validatedPid(currentIdentity: currentIdentity)
    }

    static func teardownPlan(
        identityMatches: Bool,
        sourceAvailable: Bool,
        eventAllocated: Bool
    ) -> TeardownPlan {
        guard identityMatches else { return .discardInvalidTarget }
        guard sourceAvailable, eventAllocated else { return .retainForRetry }
        return .postAndComplete
    }
}

enum CommandForegroundPolicy {
    private static let leasedCommands: Set<String> = [
        "click", "set_value", "select_text", "perform_secondary_action",
        "scroll", "type_text", "paste", "press_key", "drag",
        "key", "hold_key", "type", "paste_clipboard", "mouse_down", "mouse_up",
    ]

    static func requiresLease(_ command: String) -> Bool {
        leasedCommands.contains(command)
    }
}
