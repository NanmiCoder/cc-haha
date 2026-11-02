import { hasSessionPowerActivity } from '../ws/handler.js'
import { migrationMaintenance } from '../migrationMaintenance.js'
import { hasSideQuestionPowerActivity } from '../api/sideQuestions.js'
import { hasSessionCollaborationPowerActivity } from './sessionCollaborationHost.js'
import { readdir } from 'node:fs/promises'
import { listTeamPlansAwaitingReview, readTeamPlan } from '../../utils/swarm/teamPlanStore.js'
import { getTeamsDir } from '../../utils/envUtils.js'
import { readTeamFileAsync } from '../../utils/swarm/teamHelpers.js'
import { cronScheduler } from './cronScheduler.js'
import { hasPendingTeamPowerWork } from './teamPlanRuntime.js'
import { teamPlanService } from './teamPlanService.js'
import { hasPowerActivityLeases } from './powerActivityLease.js'
import { powerActivityClock, type PowerActivitySnapshot } from './powerActivityClock.js'

async function readPowerTeamReviews() {
  // The phone intentionally skips corrupt plans. Power management must not
  // interpret that forgiving presentation as proof there are no decisions.
  let names: string[]
  try { names = await readdir(getTeamsDir()) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    names = []
  }
  await Promise.all(names.map(async name => {
    const plan = await readTeamPlan(name)
    if (plan?.state === 'review_pending' && !await readTeamFileAsync(name)) {
      throw new Error('Pending team review authority is unavailable')
    }
  }))
  return listTeamPlansAwaitingReview()
}

/** Read live authority last; any producer change during disk reads invalidates idle. */
export async function getPowerActivitySnapshot(): Promise<PowerActivitySnapshot> {
  const before = powerActivityClock.read(false).revision
  const [reviews, teamWork] = await Promise.all([
    readPowerTeamReviews(),
    hasPendingTeamPowerWork(),
  ])
  const busy = migrationMaintenance.isActive || reviews.length > 0 || teamWork || teamPlanService.hasActiveOperations()
    || cronScheduler.hasActiveWork() || hasSessionPowerActivity() || hasPowerActivityLeases()
    || hasSideQuestionPowerActivity() || hasSessionCollaborationPowerActivity()
  const snapshot = powerActivityClock.read(busy)
  if (snapshot.revision !== before) snapshot.busy = true
  return snapshot
}
