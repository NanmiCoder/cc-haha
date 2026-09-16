import CoreGraphics
import Foundation

/// Pure spring state. Starting or redirecting a glide changes only the desired
/// destination; the displayed position advances exclusively from `tick`.
struct CursorMotionState: Equatable, Sendable {
    private(set) var position: CGPoint
    private(set) var destination: CGPoint?
    private(set) var velocity: CGVector = .zero

    init(position: CGPoint) {
        self.position = position
    }

    mutating func startGlide(to destination: CGPoint) {
        self.destination = destination
    }

    mutating func tick(deltaTime: TimeInterval) {
        guard let destination else { return }
        let dt = CGFloat(deltaTime)
        guard dt > 0 else { return }

        let stiffness: CGFloat = 196
        let damping = 2.0 * 0.85 * sqrt(stiffness)
        let dx = destination.x - position.x
        let dy = destination.y - position.y
        velocity.dx += (stiffness * dx - damping * velocity.dx) * dt
        velocity.dy += (stiffness * dy - damping * velocity.dy) * dt
        position = CGPoint(
            x: position.x + velocity.dx * dt,
            y: position.y + velocity.dy * dt
        )
    }

    mutating func snap(to destination: CGPoint) {
        position = destination
        self.destination = nil
        velocity = .zero
    }

    mutating func stop() {
        destination = nil
        velocity = .zero
    }

    var remainingDistance: CGFloat {
        guard let destination else { return 0 }
        return hypot(destination.x - position.x, destination.y - position.y)
    }

    var speed: CGFloat {
        hypot(velocity.dx, velocity.dy)
    }
}

@MainActor
enum CursorActionTiming {
    /// Start visible feedback immediately. Coordinate gestures opt out of the
    /// bounded readability delay; indexed actions retain their current policy.
    /// Hidden/unrequested feedback snaps without calling `sleep`.
    static func perform(
        decision: OverlayPolicy.Decision,
        waitForVisualFeedback: Bool = true,
        startGlide: () -> Void,
        snap: () -> Void,
        sleep: (TimeInterval) async -> Void
    ) async {
        guard decision.visible else {
            snap()
            return
        }
        startGlide()
        if waitForVisualFeedback, decision.actionDelay > 0 {
            await sleep(decision.actionDelay)
        }
    }
}

@MainActor
enum CursorIndexedActionGate {
    /// The post-delay recheck is deliberately part of the shared sequence so an
    /// indexed click cannot mutate using a snapshot that changed while waiting.
    static func perform<Result>(
        moveForAction: () async -> Void,
        recheckStaleness: () throws -> Void,
        mutate: () async throws -> Result
    ) async rethrows -> Result {
        await moveForAction()
        try recheckStaleness()
        return try await mutate()
    }
}
