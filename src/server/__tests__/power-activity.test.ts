import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleSessionsApi } from '../api/sessions.js'
import { conversationService } from '../services/conversationService.js'
import { computerUseApprovalService } from '../services/computerUseApprovalService.js'
import * as teamPlans from '../../utils/swarm/teamPlanStore.js'
import { activeBackgroundTaskIds } from '../ws/agentTaskState.js'
import { cronScheduler } from '../services/cronScheduler.js'
import { CronService } from '../services/cronService.js'
import { hasPowerActivityLeases, releasePowerActivityLease } from '../services/powerActivityLease.js'
import {
  __markActiveTurnForTests, __registerPendingUserTurnForTests,
  __resetWebSocketHandlerStateForTests, __settleActiveTurnForTests,
  getSessionChatActivityState, hasSessionPowerActivity, handleWebSocket, stopSessionTurn, type WebSocketData,
} from '../ws/handler.js'
import type { ServerWebSocket } from 'bun'

type Snapshot = { epoch: string; revision: number; busy: boolean; completionSequence: number; scheduledCompletionSequence: number }
async function snapshot(): Promise<Snapshot> {
  const url = new URL('http://127.0.0.1/api/sessions/power-activity')
  const response = await handleSessionsApi(new Request(url), url, ['api', 'sessions', 'power-activity'])
  expect(response.status).toBe(200)
  return response.json() as Promise<Snapshot>
}

afterEach(() => {
  __resetWebSocketHandlerStateForTests()
  mock.restore()
})

describe('authoritative power activity snapshot', () => {
  it('transfers a local IM lease only after synchronous session admission owns the work', async () => {
    const previous = process.env.CC_HAHA_LOCAL_ACCESS_TOKEN
    process.env.CC_HAHA_LOCAL_ACCESS_TOKEN = 'power-handoff-fixture'
    const leaseId = 'power-handoff:message'
    const url = new URL('http://127.0.0.1/api/sessions/power-activity-lease')
    try {
      const response = await handleSessionsApi(new Request(url, {
        method: 'POST', headers: { Authorization: 'Bearer power-handoff-fixture' },
        body: JSON.stringify({ leaseId, active: true }),
      }), url, ['api', 'sessions', 'power-activity-lease'])
      expect(response.status).toBe(200)
      expect(hasPowerActivityLeases()).toBe(true)
      const ws = {
        data: { sessionId: 'handoff', channel: 'client', clientKind: 'full', powerActivityLeaseAuthorized: true,
          connectedAt: Date.now(), sdkToken: null, serverPort: 0, serverHost: '127.0.0.1' },
        send: mock(() => {}), close: mock(() => {}),
      } as unknown as ServerWebSocket<WebSocketData>
      handleWebSocket.message(ws, JSON.stringify({ type: 'user_message', content: 'fixture', powerActivityLeaseId: leaseId }))
      expect(hasPowerActivityLeases()).toBe(false)
      expect(hasSessionPowerActivity()).toBe(true)
      // Revoke the fixture before asynchronous startup can launch a CLI.
      __settleActiveTurnForTests('handoff', { type: 'result', is_error: true })
      for (let i = 0; i < 10; i++) await Promise.resolve()
      expect((await snapshot()).busy).toBe(false)
    } finally {
      releasePowerActivityLease(leaseId)
      if (previous === undefined) delete process.env.CC_HAHA_LOCAL_ACCESS_TOKEN
      else process.env.CC_HAHA_LOCAL_ACCESS_TOKEN = previous
    }
  })

  it('remembers a successful turn entirely between polls without replaying history', async () => {
    const initial = await snapshot()
    expect(initial.busy).toBe(false)
    __markActiveTurnForTests('fast-remote-turn')
    __settleActiveTurnForTests('fast-remote-turn', { type: 'result', subtype: 'success', is_error: false })
    const completed = await snapshot()
    expect(completed.epoch).toBe(initial.epoch)
    expect(completed.revision).toBeGreaterThan(initial.revision)
    expect(completed.completionSequence).toBe(initial.completionSequence + 1)
    expect(completed.scheduledCompletionSequence).toBe(initial.scheduledCompletionSequence)
    expect(completed.busy).toBe(false)
    __settleActiveTurnForTests('fast-remote-turn', { type: 'result', subtype: 'success', is_error: false })
    expect(await snapshot()).toEqual(completed)
  })

  it('includes unseen main, H5 and IM turns through admission and the last concurrent completion', async () => {
    __registerPendingUserTurnForTests('main-before-cli-start')
    __markActiveTurnForTests('h5-background')
    __markActiveTurnForTests('im-background')
    expect((await snapshot()).busy).toBe(true)
    for (const id of ['main-before-cli-start', 'h5-background']) {
      __settleActiveTurnForTests(id, { type: 'result', is_error: false })
      expect((await snapshot()).busy).toBe(true)
    }
    __settleActiveTurnForTests('im-background', { type: 'result', is_error: false })
    expect((await snapshot()).busy).toBe(false)
  })

  it('does not mistake explicit Stop or failed execution for successful completion', async () => {
    const initial = await snapshot()
    __markActiveTurnForTests('stopped')
    spyOn(conversationService, 'hasSession').mockReturnValue(false)
    stopSessionTurn('stopped')
    __settleActiveTurnForTests('stopped', { type: 'result', is_error: false })
    __markActiveTurnForTests('failed')
    __settleActiveTurnForTests('failed', { type: 'result', is_error: true })
    const final = await snapshot()
    expect(final.busy).toBe(false)
    expect(final.revision).toBeGreaterThan(initial.revision)
    expect(final.completionSequence).toBe(initial.completionSequence)
  })

  it.each(['Bash', 'AskUserQuestion'])('counts pending %s even when Stop makes the visual session idle', async toolName => {
    __markActiveTurnForTests('waiting')
    spyOn(conversationService, 'hasSession').mockReturnValue(false)
    spyOn(conversationService, 'getActiveSessions').mockReturnValue(['waiting'])
    spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([{ requestId: 'decision', toolName, input: {} }])
    stopSessionTurn('waiting')
    __settleActiveTurnForTests('waiting', { type: 'result', is_error: true })
    expect(getSessionChatActivityState('waiting')).toBe('idle')
    expect((await snapshot()).busy).toBe(true)
  })

  it('retains standalone background Bash and subagent work without a live root process', async () => {
    for (const id of ['background-shell', 'background-subagent']) activeBackgroundTaskIds.set(id, new Set(['task']))
    expect((await snapshot()).busy).toBe(true)
    activeBackgroundTaskIds.delete('background-shell')
    expect((await snapshot()).busy).toBe(true)
    activeBackgroundTaskIds.delete('background-subagent')
    expect((await snapshot()).busy).toBe(false)
  })

  it('blocks on team plan review and Computer Use decisions', async () => {
    const reviews = spyOn(teamPlans, 'listTeamPlansAwaitingReview').mockResolvedValue([{ sessionId: 'review' }] as never)
    expect((await snapshot()).busy).toBe(true)
    reviews.mockResolvedValue([])
    spyOn(conversationService, 'getActiveSessions').mockReturnValue(['computer'])
    spyOn(computerUseApprovalService, 'getPendingRequests').mockReturnValue([{ requestId: 'cu' }] as never)
    expect((await snapshot()).busy).toBe(true)
  })

  it('rejects an unreadable authority instead of returning an idle success', async () => {
    spyOn(teamPlans, 'listTeamPlansAwaitingReview').mockRejectedValue(new Error('fixture unreadable team state'))
    const url = new URL('http://127.0.0.1/api/sessions/power-activity')
    const response = await handleSessionsApi(new Request(url), url, ['api', 'sessions', 'power-activity'])
    expect(response.status).toBe(500)
  })

  it('includes a real standalone scheduled CLI from admission until exit and records its scheduled completion', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'power-cron-'))
    const saved = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CLAUDE_CLI_PATH: process.env.CLAUDE_CLI_PATH, CC_HAHA_LOCAL_INDEX: process.env.CC_HAHA_LOCAL_INDEX }
    const releasePath = join(directory, 'release')
    const readyPath = join(directory, 'ready')
    const cliPath = join(directory, 'fixture-cli.ts')
    let execution: ReturnType<typeof cronScheduler.executeTask> | undefined
    try {
      process.env.CLAUDE_CONFIG_DIR = directory
      process.env.CLAUDE_CLI_PATH = cliPath
      process.env.CC_HAHA_LOCAL_INDEX = 'off'
      await writeFile(cliPath, `import { existsSync, writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(readyPath)}, 'ready')\nwhile (!existsSync(${JSON.stringify(releasePath)})) await Bun.sleep(5)\nconsole.log(JSON.stringify({type:'result', subtype:'success', is_error:false, result:'fixture complete'}))\n`)
      spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Public network forbidden in fixture'))
      const task = await new CronService().createTask({ cron: '* * * * *', prompt: 'fixture', folderPath: directory, recurring: true })
      const initial = await snapshot()
      execution = cronScheduler.executeTask(task)
      expect((await snapshot()).busy).toBe(true)
      for (let attempt = 0; attempt < 1000 && !await stat(readyPath).then(() => true, () => false); attempt++) await Bun.sleep(5)
      expect(await stat(readyPath).then(() => true, () => false)).toBe(true)
      expect(conversationService.getActiveSessions()).toEqual([])
      expect((await snapshot()).busy).toBe(true)
      await writeFile(releasePath, 'release')
      expect((await execution).status).toBe('completed')
      const completed = await snapshot()
      expect(completed.busy).toBe(false)
      expect(completed.scheduledCompletionSequence).toBe(initial.scheduledCompletionSequence + 1)
      expect(completed.completionSequence).toBe(initial.completionSequence + 1)
    } finally {
      await writeFile(releasePath, 'release')
      await execution?.catch(() => {})
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      await rm(directory, { recursive: true, force: true })
    }
  }, 15_000)

  it('fails closed on a malformed persisted team plan without altering it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'power-review-'))
    const saved = process.env.CLAUDE_CONFIG_DIR
    try {
      process.env.CLAUDE_CONFIG_DIR = directory
      await mkdir(join(directory, 'teams', 'fixture'), { recursive: true })
      await writeFile(join(directory, 'teams', 'fixture', 'plan.json'), '{broken')
      const url = new URL('http://127.0.0.1/api/sessions/power-activity')
      const response = await handleSessionsApi(new Request(url), url, ['api', 'sessions', 'power-activity'])
      expect(response.status).toBe(500)
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = saved
      await rm(directory, { recursive: true, force: true })
    }
  })
})
