// A successful submit yields after its complete tool batch. This is scoped to
// the current turn's controller, not a process-global "paused" session flag.
const pending = new WeakSet<AbortController>()

export function requestTeamPlanTurnPause(controller: AbortController): void {
  pending.add(controller)
}

export function consumeTeamPlanTurnPause(controller: AbortController): boolean {
  const requested = pending.has(controller)
  pending.delete(controller)
  return requested
}
