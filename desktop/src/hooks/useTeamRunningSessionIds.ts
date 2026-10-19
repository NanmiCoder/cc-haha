import { useShallow } from 'zustand/react/shallow'
import { areTeamMembersAllStopped, isTeamPlanActive } from '../lib/teamRunning'
import { useTeamPlanStore } from '../stores/teamPlanStore'
import { useTeamStore } from '../stores/teamStore'

/**
 * The given sessions whose Agent Team is still working (see `isTeamRunning`).
 *
 * Two narrow selectors, plan first: only sessions with a launched plan are
 * looked up in the team store, and each returns a small id list that `useShallow`
 * keeps referentially stable, so streaming tokens and roster polls that change
 * nothing here never re-render the caller (#1480).
 */
export function useTeamRunningSessionIds(sessionIds: readonly string[]): string[] {
  const planActiveIds = useTeamPlanStore(useShallow((state) =>
    sessionIds.filter((sessionId) => isTeamPlanActive(state.bySession[sessionId]?.plan))))
  return useTeamStore(useShallow((state) =>
    planActiveIds.filter((sessionId) =>
      !areTeamMembersAllStopped(state.workbenchesBySession[sessionId]?.snapshots.at(-1)?.team))))
}
