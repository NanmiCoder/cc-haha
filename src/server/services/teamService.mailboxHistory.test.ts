import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  claimMailboxMessages,
  getInboxHistoryPath,
  getInboxPath,
  readUnreadMessages,
  writeToMailbox,
} from '../../utils/teammateMailbox.js'
import { TeamService } from './teamService.js'

const TEAM = 'history-team'

let configDir: string
let originalConfigDir: string | undefined
let service: TeamService

beforeEach(async () => {
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-haha-team-feed-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
  const teamDir = path.join(configDir, 'teams', TEAM)
  await fs.mkdir(teamDir, { recursive: true })
  await fs.writeFile(
    path.join(teamDir, 'config.json'),
    JSON.stringify({
      name: TEAM,
      createdAt: 1700000000000,
      leadAgentId: `team-lead@${TEAM}`,
      members: ['team-lead', 'worker'].map(name => ({
        agentId: `${name}@${TEAM}`,
        name,
        joinedAt: 1700000000000,
        tmuxPaneId: '',
        cwd: configDir,
        isActive: true,
      })),
    }),
  )
  service = new TeamService()
})

afterEach(async () => {
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  await fs.rm(configDir, { recursive: true, force: true })
})

describe('Agent Teams communication feed', () => {
  test('keeps delivered messages after the CLI prunes them from the live inbox', async () => {
    expect(
      await writeToMailbox(
        'team-lead',
        {
          from: 'worker',
          text: 'Analysis complete',
          summary: 'done',
          timestamp: '2026-10-03T00:00:01.000Z',
        },
        TEAM,
      ),
    ).toBe(true)
    expect(
      await writeToMailbox(
        'worker',
        {
          from: 'team-lead',
          text: 'Next: add regression tests',
          timestamp: '2026-10-03T00:00:02.000Z',
        },
        TEAM,
      ),
    ).toBe(true)
    const before = await service.getWorkbench(TEAM)

    await claimMailboxMessages(
      'team-lead',
      TEAM,
      await readUnreadMessages('team-lead', TEAM),
    )
    expect(await fs.readFile(getInboxPath('team-lead', TEAM), 'utf8')).toBe('[]')
    const after = await service.getWorkbench(TEAM)

    expect(after.messages).toEqual(before.messages)
    expect(
      after.messages.map(message => [
        message.from,
        message.text,
        message.recipients,
        message.summary,
      ]),
    ).toEqual([
      ['worker', 'Analysis complete', ['team-lead'], 'done'],
      ['team-lead', 'Next: add regression tests', ['worker'], undefined],
    ])
  })

  test('reads a recipient known only from its history file', async () => {
    const historyPath = getInboxHistoryPath(getInboxPath('worker', TEAM))
    await fs.mkdir(path.dirname(historyPath), { recursive: true })
    await fs.writeFile(
      historyPath,
      `${JSON.stringify({
        id: 'mailbox-archived',
        from: 'team-lead',
        text: 'Archived instruction',
        timestamp: '2026-10-03T00:00:03.000Z',
        read: true,
      })}\n`,
    )

    const snapshot = await service.getWorkbench(TEAM)

    expect(snapshot.messages.map(message => [message.text, message.recipients])).toEqual([
      ['Archived instruction', ['worker']],
    ])
    expect(snapshot.team.members.map(member => member.name).sort()).toEqual([
      'team-lead',
      'worker',
    ])
  })
})
