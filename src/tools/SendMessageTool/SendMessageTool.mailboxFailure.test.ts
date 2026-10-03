import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AppState } from '../../state/AppState.js'
import type { ToolUseContext } from '../../Tool.js'
import * as gracefulShutdownModule from '../../utils/gracefulShutdown.js'
import * as lockfile from '../../utils/lockfile.js'
import {
  clearDynamicTeamContext,
  setDynamicTeamContext,
} from '../../utils/teammate.js'
import * as mailbox from '../../utils/teammateMailbox.js'
import { SendMessageTool } from './SendMessageTool.js'

const TEAM = 'send-team'

let configDir: string
let originalConfigDir: string | undefined

beforeEach(async () => {
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  configDir = await mkdtemp(join(tmpdir(), 'cc-haha-send-message-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
})

afterEach(async () => {
  clearDynamicTeamContext()
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  await rm(configDir, { recursive: true, force: true })
})

function toolContext(): ToolUseContext {
  const appState = {
    teamContext: {
      teamName: TEAM,
      leadAgentId: `team-lead@${TEAM}`,
      teammates: {
        [`team-lead@${TEAM}`]: { name: 'team-lead' },
        [`worker@${TEAM}`]: { name: 'worker' },
        [`reviewer@${TEAM}`]: { name: 'reviewer' },
      },
    },
    agentNameRegistry: new Map(),
    tasks: {},
    toolPermissionContext: { mode: 'default' },
  } as unknown as AppState
  return {
    getAppState: () => appState,
    setAppState: () => {},
    abortController: new AbortController(),
  } as unknown as ToolUseContext
}

async function call(input: unknown): Promise<{ success: boolean } & Record<string, unknown>> {
  const result = await SendMessageTool.call(
    input as never,
    toolContext(),
    undefined as never,
    undefined as never,
  )
  return result.data as { success: boolean } & Record<string, unknown>
}

describe('SendMessage when a mailbox write fails', () => {
  test('reports a held inbox lock instead of claiming the message was sent', async () => {
    expect(
      await mailbox.writeToMailbox(
        'worker',
        { from: 'team-lead', text: 'seed', timestamp: new Date().toISOString() },
        TEAM,
      ),
    ).toBe(true)
    const inboxPath = mailbox.getInboxPath('worker', TEAM)
    const release = await lockfile.lock(inboxPath, {
      lockfilePath: `${inboxPath}.lock`,
    })

    let data: Awaited<ReturnType<typeof call>>
    try {
      data = await call({
        to: 'worker',
        summary: 'rerun tests',
        message: 'Please rerun the tests',
      })
    } finally {
      await release()
    }

    expect(data).toEqual({
      success: false,
      message: "Failed to write to worker's inbox — nothing was sent. Try again.",
    })
    expect((await mailbox.readMailbox('worker', TEAM)).map(m => m.text)).toEqual([
      'seed',
    ])
  }, 15_000)

  test('names the broadcast recipients that did not receive the message', async () => {
    const teamDir = join(configDir, 'teams', TEAM)
    await mkdir(teamDir, { recursive: true })
    await writeFile(
      join(teamDir, 'config.json'),
      JSON.stringify({
        name: TEAM,
        createdAt: 1,
        leadAgentId: `team-lead@${TEAM}`,
        members: ['team-lead', 'worker', 'reviewer'].map(name => ({
          agentId: `${name}@${TEAM}`,
          name,
          joinedAt: 1,
          tmuxPaneId: '',
          cwd: configDir,
          subscriptions: [],
        })),
      }),
    )
    const write = spyOn(mailbox, 'writeToMailbox').mockImplementation(
      async recipient => recipient !== 'reviewer',
    )

    try {
      const data = await call({
        to: '*',
        summary: 'status',
        message: 'Status check',
      })

      expect(data).toMatchObject({
        success: false,
        recipients: ['worker'],
      })
      expect(data.message).toContain('1 of 2 teammate(s): worker')
      expect(data.message).toContain('inbox of reviewer')
    } finally {
      write.mockRestore()
    }
  })

  test('reports every structured protocol message that could not be written', async () => {
    const write = spyOn(mailbox, 'writeToMailbox').mockResolvedValue(false)

    try {
      expect(
        await call({
          to: 'worker',
          message: { type: 'shutdown_request', reason: 'work is done' },
        }),
      ).toMatchObject({
        success: false,
        message:
          "Failed to write the shutdown request to worker's inbox — nothing was sent. Try again.",
        target: 'worker',
      })
      expect(
        await call({
          to: 'worker',
          message: {
            type: 'plan_approval_response',
            request_id: 'plan-1',
            approve: true,
          },
        }),
      ).toEqual({
        success: false,
        message:
          "Failed to write the plan approval to worker's inbox — nothing was sent. Try again.",
        request_id: 'plan-1',
      })
      expect(
        await call({
          to: 'worker',
          message: {
            type: 'plan_approval_response',
            request_id: 'plan-2',
            approve: false,
            feedback: 'split the migration',
          },
        }),
      ).toEqual({
        success: false,
        message:
          "Failed to write the plan rejection to worker's inbox — nothing was sent. Try again.",
        request_id: 'plan-2',
      })

      setDynamicTeamContext({
        agentId: `worker@${TEAM}`,
        agentName: 'worker',
        teamName: TEAM,
        planModeRequired: false,
      })
      expect(
        await call({
          to: 'team-lead',
          message: {
            type: 'shutdown_response',
            request_id: 'shutdown-2',
            approve: false,
            reason: 'still migrating',
          },
        }),
      ).toEqual({
        success: false,
        message:
          "Failed to write the shutdown rejection to team-lead's inbox — nothing was sent. Try again.",
        request_id: 'shutdown-2',
      })
    } finally {
      write.mockRestore()
    }
  })

  test('keeps a teammate running when its shutdown approval cannot reach the lead', async () => {
    setDynamicTeamContext({
      agentId: `worker@${TEAM}`,
      agentName: 'worker',
      teamName: TEAM,
      planModeRequired: false,
    })
    const write = spyOn(mailbox, 'writeToMailbox').mockResolvedValue(false)
    const shutdown = spyOn(
      gracefulShutdownModule,
      'gracefulShutdown',
    ).mockResolvedValue(undefined as never)

    try {
      const data = await call({
        to: 'team-lead',
        message: {
          type: 'shutdown_response',
          request_id: 'shutdown-1',
          approve: true,
        },
      })
      await new Promise<void>(resolve => setImmediate(resolve))

      expect(data).toMatchObject({ success: false, request_id: 'shutdown-1' })
      expect(data.message).toContain('worker is still running')
      expect(shutdown).not.toHaveBeenCalled()
    } finally {
      write.mockRestore()
      shutdown.mockRestore()
    }
  })
})
