import { listMobileSessionActivity } from '../ws/handler.js'
import { cronScheduler } from './cronScheduler.js'
import { getSessionCollaborationService } from './sessionCollaborationHost.js'
import { loadMobileSessionActivity } from './mobileSessionActivity.js'

/** Shared by the authenticated phone snapshot and background push delivery. */
export function getMobileSessionActivity() {
  return loadMobileSessionActivity({
    live: listMobileSessionActivity,
    completions: async () => (await getSessionCollaborationService()).listCompletionStates(),
    runs: options => cronScheduler.getRunsPage(options),
  })
}
