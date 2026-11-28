import { useShallow } from 'zustand/react/shallow'
import { areTeamMembersAllStopped, isAntigravitySwarmRunning, isTeamPlanActive } from '../lib/teamRunning'
import { useTeamPlanStore } from '../stores/teamPlanStore'
import { useTeamStore } from '../stores/teamStore'

/**
 * The given sessions whose Agent Team is still working (see `isTeamRunning`).
 *
 * Two narrow selectors keep the returned id list referentially stable via
 * `useShallow`, so streaming tokens and roster polls that change nothing here
 * never re-render the caller (#1480).
 */
export function useTeamRunningSessionIds(sessionIds: readonly string[]): string[] {
  const planActiveIds = useTeamPlanStore(useShallow((state) =>
    sessionIds.filter((sessionId) => isTeamPlanActive(state.bySession[sessionId]?.plan))))
  return useTeamStore(useShallow((state) => {
    const planActiveSet = new Set(planActiveIds)
    return sessionIds.filter((sessionId) => {
      const latest = state.workbenchesBySession[sessionId]?.snapshots.at(-1)
      if (planActiveSet.has(sessionId) && !areTeamMembersAllStopped(latest?.team)) {
        return true
      }
      return isAntigravitySwarmRunning(latest)
    })
  }))
}
