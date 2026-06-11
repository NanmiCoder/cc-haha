import { expect, test } from 'bun:test'
import { stopServerRuntimeForShutdown } from '../index.js'
import { conversationService } from '../services/conversationService.js'
import { cronScheduler } from '../services/cronScheduler.js'
import { teamWatcher } from '../services/teamWatcher.js'

test('server shutdown stops background schedulers before waiting for CLI sessions', async () => {
  const calls: string[] = []
  const originalTeamStop = teamWatcher.stop.bind(teamWatcher)
  const originalCronStop = cronScheduler.stop.bind(cronScheduler)
  const originalGetActiveSessions = conversationService.getActiveSessions.bind(conversationService)
  const originalStopAllSessionsAndWait = conversationService.stopAllSessionsAndWait.bind(conversationService)

  try {
    teamWatcher.stop = (() => {
      calls.push('teamWatcher.stop')
    }) as typeof teamWatcher.stop
    cronScheduler.stop = (() => {
      calls.push('cronScheduler.stop')
    }) as typeof cronScheduler.stop
    conversationService.getActiveSessions = (() => ['active-session']) as typeof conversationService.getActiveSessions
    conversationService.stopAllSessionsAndWait = (async () => {
      calls.push('conversationService.stopAllSessionsAndWait')
    }) as typeof conversationService.stopAllSessionsAndWait

    await stopServerRuntimeForShutdown({ waitForCli: true })

    expect(calls).toEqual([
      'teamWatcher.stop',
      'cronScheduler.stop',
      'conversationService.stopAllSessionsAndWait',
    ])
  } finally {
    teamWatcher.stop = originalTeamStop
    cronScheduler.stop = originalCronStop
    conversationService.getActiveSessions = originalGetActiveSessions
    conversationService.stopAllSessionsAndWait = originalStopAllSessionsAndWait
  }
})
