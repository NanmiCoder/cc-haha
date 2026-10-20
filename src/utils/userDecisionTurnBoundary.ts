// Yield only after the complete tool batch has produced its results. A pending
// desktop decision must not keep calling a model while waiting for the user.
const pending = new WeakSet<AbortController>()

export function requestUserDecisionTurnPause(controller: AbortController): void {
  pending.add(controller)
}

export function consumeUserDecisionTurnPause(controller: AbortController): boolean {
  const requested = pending.has(controller)
  pending.delete(controller)
  return requested
}
