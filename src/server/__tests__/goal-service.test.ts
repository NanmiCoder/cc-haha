import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { GoalService } from '../services/goalService.js'

describe('GoalService', () => {
  let tmpDir: string
  let storagePath: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-haha-goals-'))
    storagePath = path.join(tmpDir, 'session-goals.json')
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('sets, reads, and replaces a session goal', async () => {
    const service = new GoalService({ storagePath })

    const first = await service.setGoalObjective('session-1', 'ship the feature')
    const second = await service.setGoalObjective('session-1', 'write tests')

    expect(first.goalId).not.toBe(second.goalId)
    expect(await service.getGoal('session-1')).toMatchObject({
      sessionId: 'session-1',
      goalId: second.goalId,
      objective: 'write tests',
      status: 'active',
      tokensUsed: 0,
    })
  })

  it('pauses, resumes, completes, and clears goals', async () => {
    const service = new GoalService({ storagePath })
    await service.setGoalObjective('session-1', 'finish task')

    expect(await service.setGoalStatus('session-1', 'paused')).toMatchObject({
      status: 'paused',
    })
    expect(await service.setGoalStatus('session-1', 'active')).toMatchObject({
      status: 'active',
    })
    expect(await service.setGoalStatus('session-1', 'complete')).toMatchObject({
      status: 'complete',
    })
    expect(await service.clearGoal('session-1')).toBe(true)
    expect(await service.getGoal('session-1')).toBeNull()
  })

  it('accounts usage and marks active goals budget limited', async () => {
    const service = new GoalService({ storagePath })
    await service.setGoalObjective('session-1', 'bounded task', { tokenBudget: 10 })

    const goal = await service.accountUsage(
      'session-1',
      { input_tokens: 4, output_tokens: 5, cache_read_tokens: 2 },
      3.4,
    )

    expect(goal).toMatchObject({
      status: 'budget_limited',
      tokensUsed: 11,
      timeUsedSeconds: 3,
    })
  })

  it('normalizes empty, malformed, and legacy root-shaped files', async () => {
    const service = new GoalService({ storagePath })

    await fs.writeFile(storagePath, '', 'utf-8')
    expect(await service.getGoal('missing')).toBeNull()

    await fs.writeFile(storagePath, '{not json', 'utf-8')
    expect(await service.getGoal('missing')).toBeNull()

    await fs.writeFile(
      storagePath,
      JSON.stringify({
        'legacy-session': {
          objective: 'legacy objective',
          status: 'active',
          tokensUsed: 5,
        },
      }),
      'utf-8',
    )
    expect(await service.getGoal('legacy-session')).toMatchObject({
      objective: 'legacy objective',
      status: 'active',
      tokensUsed: 5,
    })
  })
})
