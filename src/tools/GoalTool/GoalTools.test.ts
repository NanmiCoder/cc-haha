import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { getSessionId } from '../../bootstrap/state.js'
import { goalService } from '../../server/services/goalService.js'
import {
  CreateGoalTool,
  GetGoalTool,
  UpdateGoalTool,
} from './GoalTools.js'

describe('Goal tools', () => {
  let tmpDir: string
  let originalConfigDir: string | undefined
  let originalServerUrl: string | undefined

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-haha-goal-tools-'))
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    originalServerUrl = process.env.CC_HAHA_DESKTOP_SERVER_URL
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    process.env.CC_HAHA_DESKTOP_SERVER_URL = 'http://127.0.0.1:3456'
    await goalService.clearGoal(getSessionId())
  })

  afterEach(async () => {
    await goalService.clearGoal(getSessionId())
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    if (originalServerUrl === undefined) delete process.env.CC_HAHA_DESKTOP_SERVER_URL
    else process.env.CC_HAHA_DESKTOP_SERVER_URL = originalServerUrl
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('creates, reads, and completes the current session goal', async () => {
    expect(CreateGoalTool.isEnabled()).toBe(true)

    const created = await (CreateGoalTool.call as any)({
      objective: 'finish the migration',
    })
    expect(created.data.goal).toMatchObject({
      sessionId: getSessionId(),
      objective: 'finish the migration',
      status: 'active',
    })

    const read = await (GetGoalTool.call as any)({})
    expect(read.data.goal).toMatchObject({
      objective: 'finish the migration',
      status: 'active',
    })

    const completed = await (UpdateGoalTool.call as any)({ status: 'complete' })
    expect(completed.data.goal).toMatchObject({
      objective: 'finish the migration',
      status: 'complete',
    })
  })
})
