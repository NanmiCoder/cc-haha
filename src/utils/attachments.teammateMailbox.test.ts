import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { getIsInteractive, setIsInteractive } from '../bootstrap/state.js'
import type { AppState } from '../state/AppState.js'
import type { ToolUseContext } from '../Tool.js'
import { getTeammateMailboxAttachments } from './attachments.js'
import { clearDynamicTeamContext, setDynamicTeamContext } from './teammate.js'
import {
  createTeammateContext,
  runWithTeammateContext,
} from './teammateContext.js'
import * as mailbox from './teammateMailbox.js'

const TEAM = 'attach-team'
const LEAD_ID = `team-lead@${TEAM}`
const WORKER_ID = `worker@${TEAM}`

const ENV_KEYS = [
  'CLAUDE_CONFIG_DIR',
  'USER_TYPE',
  'CC_HAHA_AGENT_TEAMS_ENABLED',
  'CC_HAHA_TEAM_WORKER',
] as const
let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>>
let savedInteractive: boolean
let configDir: string

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))
  savedInteractive = getIsInteractive()
  configDir = await mkdtemp(join(tmpdir(), 'cc-haha-mailbox-attachments-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
  process.env.CC_HAHA_AGENT_TEAMS_ENABLED = '1'
  delete process.env.USER_TYPE
  delete process.env.CC_HAHA_TEAM_WORKER
  // The desktop lead runs in print mode.
  setIsInteractive(false)
})

afterEach(async () => {
  clearDynamicTeamContext()
  setIsInteractive(savedInteractive)
  for (const key of ENV_KEYS) {
    const value = savedEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await rm(configDir, { recursive: true, force: true })
})

function leadState(inbox: AppState['inbox']['messages'] = []): AppState {
  return {
    teamContext: {
      teamName: TEAM,
      leadAgentId: LEAD_ID,
      teammates: {
        [LEAD_ID]: { name: 'team-lead' },
        [WORKER_ID]: { name: 'worker' },
      },
    },
    inbox: { messages: inbox },
    tasks: {},
  } as unknown as AppState
}

function contextFor(state: AppState, agentId?: string): ToolUseContext {
  let current = state
  return {
    agentId,
    getAppState: () => current,
    setAppState: (update: (previous: AppState) => AppState) => {
      current = update(current)
    },
  } as unknown as ToolUseContext
}

async function send(
  recipient: string,
  from: string,
  text: string,
  second: number,
): Promise<void> {
  const timestamp = new Date(Date.UTC(2026, 9, 3, 0, 0, second)).toISOString()
  expect(
    await mailbox.writeToMailbox(recipient, { from, text, timestamp }, TEAM),
  ).toBe(true)
}

async function unreadTexts(recipient: string): Promise<string[]> {
  return (await mailbox.readUnreadMessages(recipient, TEAM)).map(m => m.text)
}

function attachedTexts(attachments: unknown[]): string[] {
  const [attachment] = attachments as Array<{
    type: string
    messages: Array<{ text: string }>
  }>
  expect(attachment?.type).toBe('teammate_mailbox')
  return attachment!.messages.map(message => message.text)
}

function joinAsWorker(): void {
  setDynamicTeamContext({
    agentId: WORKER_ID,
    agentName: 'worker',
    teamName: TEAM,
    planModeRequired: false,
  })
}

describe('external builds deliver teammate mail between turns only', () => {
  test("the lead's mail waits for its next turn, where the chat shows it", async () => {
    await send('team-lead', 'worker', 'Analysis complete', 1)

    expect(await getTeammateMailboxAttachments(contextFor(leadState()))).toEqual([])
    expect(await unreadTexts('team-lead')).toEqual(['Analysis complete'])
  })

  test('no teammate consumes any inbox mid-turn', async () => {
    await send('worker', 'team-lead', 'next task', 1)
    await send('team-lead', 'worker', 'for the lead', 2)

    // A desktop process worker leaves both inboxes to the server and the lead.
    process.env.CC_HAHA_TEAM_WORKER = '1'
    expect(await getTeammateMailboxAttachments(contextFor(leadState()))).toEqual([])
    delete process.env.CC_HAHA_TEAM_WORKER

    joinAsWorker()
    expect(await getTeammateMailboxAttachments(contextFor(leadState()))).toEqual([])
    clearDynamicTeamContext()

    const teammate = createTeammateContext({
      agentId: WORKER_ID,
      agentName: 'worker',
      teamName: TEAM,
      planModeRequired: false,
      parentSessionId: 'lead-session',
      abortController: new AbortController(),
    })
    expect(
      await runWithTeammateContext(teammate, () =>
        getTeammateMailboxAttachments(contextFor(leadState(), WORKER_ID)),
      ),
    ).toEqual([])

    expect(await unreadTexts('worker')).toEqual(['next task'])
    expect(await unreadTexts('team-lead')).toEqual(['for the lead'])
  })
})

describe('ant builds deliver mail mid-turn', () => {
  beforeEach(() => {
    process.env.USER_TYPE = 'ant'
  })

  test('attaches teammate mail and leaves protocol messages for the poller', async () => {
    const idle = JSON.stringify(
      mailbox.createIdleNotification('worker', {
        idleReason: 'failed',
        failureReason: 'provider stream ended',
      }),
    )
    const permissionRequest = JSON.stringify(
      mailbox.createPermissionRequestMessage({
        request_id: 'perm-1',
        agent_id: 'worker',
        tool_name: 'Bash',
        tool_use_id: 'tool-1',
        description: 'run tests',
        input: { command: 'bun test' },
      }),
    )
    await send('team-lead', 'worker', 'Analysis complete', 1)
    await send('team-lead', 'worker', idle, 2)
    await send('team-lead', 'worker', permissionRequest, 3)

    const attachments = await getTeammateMailboxAttachments(
      contextFor(leadState()),
    )

    expect(attachedTexts(attachments)).toEqual(['Analysis complete', idle])
    expect(await unreadTexts('team-lead')).toEqual([permissionRequest])
    expect(
      (await mailbox.readMailboxHistory('team-lead', TEAM))
        .filter(message => message.read)
        .map(message => message.text),
    ).toEqual(['Analysis complete', idle])
  })

  test('acknowledges only what it attached', async () => {
    await send('team-lead', 'worker', 'first result', 1)
    const readUnread = mailbox.readUnreadMessages
    const read = spyOn(mailbox, 'readUnreadMessages').mockImplementation(
      async (agentName, teamName) => {
        const batch = await readUnread(agentName, teamName)
        await send('team-lead', 'reviewer', 'arrived after the read', 2)
        return batch
      },
    )

    try {
      expect(
        attachedTexts(
          await getTeammateMailboxAttachments(contextFor(leadState())),
        ),
      ).toEqual(['first result'])
    } finally {
      read.mockRestore()
    }

    expect(await unreadTexts('team-lead')).toEqual(['arrived after the read'])
  })

  test('a teammate receives its own mail', async () => {
    joinAsWorker()
    await send('worker', 'team-lead', 'next task', 1)

    expect(
      attachedTexts(
        await getTeammateMailboxAttachments(contextFor(leadState())),
      ),
    ).toEqual(['next task'])
    expect(await unreadTexts('worker')).toEqual([])
  })
})
