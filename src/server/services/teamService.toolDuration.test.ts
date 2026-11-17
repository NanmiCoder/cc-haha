import { afterEach, beforeEach, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { TeamService } from './teamService.js'

const TEAM = 'duration-team'
const CREATED_AT = Date.parse('2026-11-16T04:00:00.000Z')

let configDir: string
let oldConfigDir: string | undefined
let oldLocalIndex: string | undefined

beforeEach(async () => {
  oldConfigDir = process.env.CLAUDE_CONFIG_DIR
  oldLocalIndex = process.env.CC_HAHA_LOCAL_INDEX
  configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-haha-team-duration-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
  process.env.CC_HAHA_LOCAL_INDEX = 'off'
})

afterEach(async () => {
  if (oldConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = oldConfigDir
  if (oldLocalIndex === undefined) delete process.env.CC_HAHA_LOCAL_INDEX
  else process.env.CC_HAHA_LOCAL_INDEX = oldLocalIndex
  await fs.rm(configDir, { recursive: true, force: true })
})

test('TeamService preserves finite non-negative tool_result durationMs across root and fragment member transcripts (#1915)', async () => {
  const teamDir = path.join(configDir, 'teams', TEAM)
  const projectDir = path.join(configDir, 'projects', '-tmp-project')
  const subagentsDir = path.join(projectDir, 'lead-session-1', 'subagents')
  await fs.mkdir(teamDir, { recursive: true })
  await fs.mkdir(subagentsDir, { recursive: true })

  await fs.writeFile(
    path.join(teamDir, 'config.json'),
    JSON.stringify({
      name: TEAM,
      createdAt: CREATED_AT,
      leadAgentId: `lead@${TEAM}`,
      leadSessionId: 'lead-session-1',
      members: [
        {
          agentId: `worker@${TEAM}`,
          name: 'worker',
          joinedAt: CREATED_AT,
          tmuxPaneId: '',
          cwd: '/tmp/project',
          sessionId: 'worker-session-1',
          isActive: false,
        },
        {
          agentId: `subworker@${TEAM}`,
          name: 'subworker',
          joinedAt: CREATED_AT,
          tmuxPaneId: '',
          cwd: '/tmp/project',
          isActive: false,
        },
      ],
    }),
  )

  const rootEntries = [
    {
      type: 'assistant',
      uuid: 'a-1',
      timestamp: '2026-11-16T04:00:01.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'edit-1', name: 'Edit', input: { file_path: 'a.ts' } },
          { type: 'tool_use', id: 'edit-denied', name: 'Edit', input: { file_path: 'b.ts' } },
          { type: 'tool_use', id: 'edit-legacy', name: 'Edit', input: { file_path: 'c.ts' } },
          { type: 'tool_use', id: 'edit-neg', name: 'Edit', input: { file_path: 'd.ts' } },
        ],
      },
    },
    {
      type: 'user',
      uuid: 'tr-timed',
      timestamp: '2026-11-16T04:00:02.500Z',
      durationMs: 220,
      toolUseResult: 'Updated a.ts',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'edit-1', content: 'Updated a.ts' }],
      },
    },
    {
      type: 'user',
      uuid: 'tr-zero',
      timestamp: '2026-11-16T04:00:03.500Z',
      durationMs: 0,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'edit-denied', content: 'Rejected', is_error: true }],
      },
    },
    {
      type: 'user',
      uuid: 'tr-legacy',
      timestamp: '2026-11-16T04:00:04.000Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'edit-legacy', content: 'Updated c.ts' }],
      },
    },
    {
      type: 'user',
      uuid: 'tr-neg',
      timestamp: '2026-11-16T04:00:04.500Z',
      durationMs: -10,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'edit-neg', content: 'Updated d.ts' }],
      },
    },
    {
      type: 'system',
      subtype: 'turn_duration',
      uuid: 'sys-turn',
      timestamp: '2026-11-16T04:00:05.000Z',
      durationMs: 9500,
      isMeta: false,
      content: null,
    },
  ]
  await fs.writeFile(
    path.join(projectDir, 'worker-session-1.jsonl'),
    rootEntries.map(entry => JSON.stringify(entry)).join('\n') + '\n',
  )

  await fs.writeFile(
    path.join(subagentsDir, 'agent-frag1.meta.json'),
    JSON.stringify({ agentType: 'subworker' }),
  )
  const fragmentEntries = [
    {
      type: 'assistant',
      uuid: 'frag-a-1',
      timestamp: '2026-11-16T04:00:01.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'ls' } }],
      },
    },
    {
      type: 'user',
      uuid: 'frag-tr-1',
      timestamp: '2026-11-16T04:00:03.000Z',
      durationMs: 145,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'bash-1', content: 'ok' }],
      },
    },
  ]
  await fs.writeFile(
    path.join(subagentsDir, 'agent-frag1.jsonl'),
    fragmentEntries.map(entry => JSON.stringify(entry)).join('\n') + '\n',
  )

  const service = new TeamService()
  const rootPage = await service.getMemberTranscriptPage(TEAM, `worker@${TEAM}`)
  const byId = new Map(rootPage.messages.map(msg => [msg.id, msg]))

  expect(byId.get('tr-timed')?.durationMs).toBe(220)
  expect(byId.get('tr-zero')?.durationMs).toBe(0)
  expect('durationMs' in byId.get('tr-legacy')!).toBe(false)
  expect('durationMs' in byId.get('tr-neg')!).toBe(false)
  expect('durationMs' in byId.get('sys-turn')!).toBe(false)

  const fragmentPage = await service.getMemberTranscriptPage(TEAM, `subworker@${TEAM}`)
  const fragResult = fragmentPage.messages.find(msg => msg.id.endsWith('frag-tr-1'))
  expect(fragResult?.durationMs).toBe(145)
})
