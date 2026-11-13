import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import * as mailbox from '../utils/teammateMailbox.js'
import {
  createLeadMailboxPollState,
  resumeLeadMailboxPoll,
  pauseLeadMailboxPoll,
  type LeadMailboxPollStep,
  MAX_LEAD_MAILBOX_ACK_FAILURES,
  takeLeadMailboxBatch,
} from './print.js'

const TEAM = 'print-lead-team'

let configDir: string
let originalConfigDir: string | undefined

beforeEach(async () => {
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  configDir = await mkdtemp(join(tmpdir(), 'cc-haha-print-lead-mailbox-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
})

afterEach(async () => {
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  await rm(configDir, { recursive: true, force: true })
})

async function send(from: string, text: string, second: number): Promise<void> {
  const timestamp = new Date(Date.UTC(2026, 9, 3, 0, 0, second)).toISOString()
  expect(
    await mailbox.writeToMailbox('team-lead', { from, text, timestamp }, TEAM),
  ).toBe(true)
}

async function unreadTexts(): Promise<string[]> {
  return (await mailbox.readUnreadMessages('team-lead', TEAM)).map(m => m.text)
}

function texts(step: LeadMailboxPollStep): string[] | undefined {
  return step.kind === 'batch' ? step.messages.map(m => m.text) : undefined
}

describe('print-mode team lead mailbox poll', () => {
  for (const hasReport of [true, false]) test(`a Stop during inbox read keeps the poll held (${hasReport ? 'report' : 'empty'})`, async () => {
    if (hasReport) await send('worker', 'report arriving at Stop', 1)
    const state = createLeadMailboxPollState()
    const original = mailbox.readUnreadMessages
    const read = spyOn(mailbox, 'readUnreadMessages').mockImplementation(async (agent, team) => {
      const messages = await original(agent, team)
      state.held = true
      return messages
    })
    try {
      expect(await takeLeadMailboxBatch(state, { teamName: TEAM, hasActiveTeammates: false })).toEqual({ kind: 'held' })
      expect(state.held).toBe(true)
    } finally { read.mockRestore() }
    expect(await unreadTexts()).toEqual(hasReport ? ['report arriving at Stop'] : [])
  })

  test('a Stop after claim returns reports unread and a new resume invalidates the old poll', async () => {
    await send('worker', 'claimed report', 1)
    const state = createLeadMailboxPollState()
    const original = mailbox.claimMailboxMessages
    const claim = spyOn(mailbox, 'claimMailboxMessages').mockImplementation(async (...args) => {
      const batch = await original(...args)
      pauseLeadMailboxPoll(state)
      resumeLeadMailboxPoll(state, async () => {})
      return batch
    })
    try {
      expect(await takeLeadMailboxBatch(state, { teamName: TEAM, hasActiveTeammates: true })).toEqual({ kind: 'held' })
    } finally { claim.mockRestore() }
    expect(state.held).toBe(false)
    expect(await unreadTexts()).toEqual(['claimed report'])
    expect(texts(await takeLeadMailboxBatch(state, { teamName: TEAM, hasActiveTeammates: true }))).toEqual(['claimed report'])
  })
  test('explicit resume restarts an ended poll and drains reports held by Stop', async () => {
    const state = createLeadMailboxPollState()
    state.held = true
    state.finalDrainDone = true
    await send('worker', 'report kept while paused', 1)
    expect(await takeLeadMailboxBatch(state, { teamName: TEAM, hasActiveTeammates: false })).toEqual({ kind: 'held' })
    let delivered: string[] | undefined
    let finished!: () => void
    const completion = new Promise<void>(resolve => { finished = resolve })
    resumeLeadMailboxPoll(state, async () => {
      delivered = texts(await takeLeadMailboxBatch(state, { teamName: TEAM, hasActiveTeammates: false }))
      finished()
    })
    await completion
    expect(delivered).toEqual(['report kept while paused'])
    expect(await unreadTexts()).toEqual([])
  })

  test('acknowledges only the batch it read', async () => {
    await send('alice', 'report', 1)
    const readUnread = mailbox.readUnreadMessages
    const read = spyOn(mailbox, 'readUnreadMessages').mockImplementation(
      async (agentName, teamName) => {
        const batch = await readUnread(agentName, teamName)
        // A teammate fails while the lead is between its read and its ack.
        await send('bob', 'failed: provider stream ended', 2)
        return batch
      },
    )

    try {
      const step = await takeLeadMailboxBatch(createLeadMailboxPollState(), {
        teamName: TEAM,
        hasActiveTeammates: true,
      })
      expect(texts(step)).toEqual(['report'])
    } finally {
      read.mockRestore()
    }

    expect(await unreadTexts()).toEqual(['failed: provider stream ended'])
  })

  test('keeps polling quietly while teammates work and nothing is unread', async () => {
    expect(
      await takeLeadMailboxBatch(createLeadMailboxPollState(), {
        teamName: TEAM,
        hasActiveTeammates: true,
      }),
    ).toEqual({ kind: 'idle' })
  })

  test('drains mail left behind by the last teammate before stopping', async () => {
    await send('worker', 'final report', 1)
    const state = createLeadMailboxPollState()
    const departed = { teamName: TEAM, hasActiveTeammates: false }

    expect(texts(await takeLeadMailboxBatch(state, departed))).toEqual([
      'final report',
    ])
    expect(await takeLeadMailboxBatch(state, departed)).toEqual({ kind: 'stop' })
    expect(await unreadTexts()).toEqual([])
  })

  test('drains only once per departure, then waits for an active teammate', async () => {
    await send('worker', 'final report', 1)
    const state = createLeadMailboxPollState()
    const departed = { teamName: TEAM, hasActiveTeammates: false }

    expect(texts(await takeLeadMailboxBatch(state, departed))).toEqual([
      'final report',
    ])
    await send('worker', 'written during the drain turn', 2)
    expect(await takeLeadMailboxBatch(state, departed)).toEqual({ kind: 'stop' })
    expect(await unreadTexts()).toEqual(['written during the drain turn'])

    expect(
      texts(
        await takeLeadMailboxBatch(state, {
          teamName: TEAM,
          hasActiveTeammates: true,
        }),
      ),
    ).toEqual(['written during the drain turn'])
  })

  test('retries an unacknowledged batch before processing it anyway', async () => {
    await send('alice', 'report', 1)
    const claim = spyOn(mailbox, 'claimMailboxMessages').mockResolvedValue(
      undefined,
    )
    const state = createLeadMailboxPollState()
    const active = { teamName: TEAM, hasActiveTeammates: true }

    try {
      for (let poll = 1; poll < MAX_LEAD_MAILBOX_ACK_FAILURES; poll++) {
        expect(await takeLeadMailboxBatch(state, active)).toEqual({
          kind: 'retry',
        })
      }
      expect(texts(await takeLeadMailboxBatch(state, active))).toEqual(['report'])
    } finally {
      claim.mockRestore()
    }

    // Acknowledging works again: the failure streak resets.
    expect(texts(await takeLeadMailboxBatch(state, active))).toEqual(['report'])
    expect(state.consecutiveAckFailures).toBe(0)
    expect(await unreadTexts()).toEqual([])
  })
})
