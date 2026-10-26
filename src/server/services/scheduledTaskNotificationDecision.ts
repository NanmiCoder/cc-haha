import { ApiError } from '../middleware/errorHandler.js'

type Decision = 'notify' | 'silent'
const activeRuns = new Map<string, { sessionId: string; decision?: Decision }>()

/** The host owns this registration; a tool cannot invent or borrow a run. */
export function registerScheduledTaskNotificationRun(runId: string, sessionId: string) {
  if (activeRuns.has(runId)) throw new Error('Scheduled run is already active')
  const run = { sessionId } as { sessionId: string; decision?: Decision }
  activeRuns.set(runId, run)
  return {
    decision: () => run.decision,
    dispose: () => { if (activeRuns.get(runId) === run) activeRuns.delete(runId) },
  }
}

export function reportScheduledTaskNotificationDecision(runId: string, callerSessionId: string, decision: Decision): void {
  const run = activeRuns.get(runId)
  if (!run || run.sessionId !== callerSessionId) throw ApiError.badRequest('This scheduled run is not active in the calling session')
  if (decision !== 'notify' && decision !== 'silent') throw ApiError.badRequest('Invalid notification decision')
  run.decision = decision
}
