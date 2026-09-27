import { afterEach, expect, test } from 'bun:test'
import { spawnInProcessTeammate } from './spawnInProcess.js'

const original = process.env.CC_HAHA_TEAM_REVIEW_REQUIRED
afterEach(() => {
  if (original === undefined) delete process.env.CC_HAHA_TEAM_REVIEW_REQUIRED
  else process.env.CC_HAHA_TEAM_REVIEW_REQUIRED = original
})

test('a direct backend call cannot bypass whole-team review or register an in-process task', async () => {
  process.env.CC_HAHA_TEAM_REVIEW_REQUIRED = '1'
  let registrations = 0
  const result = await spawnInProcessTeammate({ name: 'worker', teamName: 'reviewed-team', prompt: 'Do work', planModeRequired: false }, { setAppState: () => { registrations++ } })
  expect(result.success).toBe(false)
  expect(result.error).toContain('approved server snapshot')
  expect(registrations).toBe(0)
  expect(result.taskId).toBeUndefined()
})
