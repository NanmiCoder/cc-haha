import { describe, expect, test } from 'bun:test'
import { admitSessionUserTurn, registerSessionTurnAdmissionGuard } from './sessionTurnEvents.js'

describe('manual session admission host registration', () => {
  test('an obsolete host cannot unregister its replacement guard', async () => {
    const first = registerSessionTurnAdmissionGuard(async () => { throw new Error('obsolete') })
    let releases = 0
    const second = registerSessionTurnAdmissionGuard(async (id, canAdmit) => {
      expect(id).toBe('worker')
      expect(canAdmit()).toBe(true)
      return { release: async () => { releases++ } }
    })
    try {
      first()
      const lease = await admitSessionUserTurn('worker', () => true)
      await lease.release()
      expect(releases).toBe(1)
    } finally { second() }
    await (await admitSessionUserTurn('without-host', () => true)).release()
  })
})
