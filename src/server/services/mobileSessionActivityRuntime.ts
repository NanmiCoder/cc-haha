import { listMobileSessionActivity } from '../ws/handler.js'
import { cronScheduler } from './cronScheduler.js'
import { getSessionCollaborationService } from './sessionCollaborationHost.js'
import { loadMobileSessionActivity } from './mobileSessionActivity.js'
import { listTeamPlansAwaitingReview } from '../../utils/swarm/teamPlanStore.js'

/** Shared by the authenticated phone snapshot and background push delivery. */
export function getMobileSessionActivity() {
  return loadMobileSessionActivity({
    live: listMobileSessionActivity,
    completions: async () => (await getSessionCollaborationService()).listCompletionStates(),
    runs: options => cronScheduler.getRunsPage(options),
    teamReviews: async () => (await listTeamPlansAwaitingReview()).map(plan => ({ sessionId: plan.sessionId, addition: !!plan.parentPlanId })),
  })
}
