import { describe, expect, it } from 'vitest'
import { createTeamPlanGalleryFixture, installTeamPlanGalleryFixture } from './teamPlanGalleryFixture'
import { teamPlansApi } from '@/api/teamPlans'

describe('isolated team plan gallery', () => {
  it('uses fake provider ids and provides a complete review graph', () => {
    const plan = createTeamPlanGalleryFixture()
    expect(plan.members).toHaveLength(3)
    expect(new Set(plan.members.map(member => member.runtime.providerId))).toEqual(new Set(['economy', 'quality']))
    expect(plan.tasks.every(task => plan.members.some(member => member.id === task.ownerId))).toBe(true)
  })

  it('simulates review and revision without real server transport and restores API methods', async () => {
    const original = teamPlansApi.get
    const fixture = installTeamPlanGalleryFixture()
    try {
      const { plan } = await teamPlansApi.get('gallery-team-plan')
      const result = await teamPlansApi.act(plan!, 'approve', 'request')
      expect(result.plan.state).toBe('running')
      fixture.interrupt()
      expect((await teamPlansApi.get('gallery-team-plan')).plan?.state).toBe('interrupted')
    } finally {
      fixture.dispose()
    }
    expect(teamPlansApi.get).toBe(original)
  })
})
