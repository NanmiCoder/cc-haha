/**
 * Unit tests for TeamService and Teams API
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import * as crypto from 'node:crypto'
import { AsyncResource } from 'node:async_hooks'
import {
  TeamService,
  projectTeamWorkbenchesFromTranscript,
  teamIncarnationId,
} from '../services/teamService.js'
import type { TeamWorkbenchSnapshot } from '../services/teamService.js'
import type { MessageEntry } from '../services/sessionService.js'
import * as lockfile from '../../utils/lockfile.js'
import { getSessionCreatedTeams } from '../../bootstrap/state.js'
import {
  cleanupSessionTeams,
  cleanupTeamDirectories,
  registerTeamForSessionCleanup,
  unregisterTeamForSessionCleanup,
} from '../../utils/swarm/teamHelpers.js'
import {
  beginTaskListLifecycle,
  completeTaskListLifecycle,
  createTaskWithCommit,
  readTaskListLifecycleState,
  readTaskListSnapshot,
  resetTaskList,
  updateTask,
  withTaskListLifecycleLock,
} from '../../utils/tasks.js'
import {
  captureSourceFingerprint,
  serializeSourceFingerprint,
} from '../services/localIndex/sourceFingerprint.js'
import { readSessionEntriesByLocator } from '../services/localIndex/sessionEntries.js'
import type {
  LocalIndexGateway,
  SessionEntryLocatorPage,
} from '../services/localIndex/sessionIndex.js'

// ============================================================================
// Test helpers
// ============================================================================

let tmpDir: string
let service: TeamService

async function setupTmpConfigDir(): Promise<string> {
  tmpDir = path.join(
    os.tmpdir(),
    `claude-teams-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  await fs.mkdir(path.join(tmpDir, 'teams'), { recursive: true })
  await fs.mkdir(path.join(tmpDir, 'projects'), { recursive: true })
  process.env.CLAUDE_CONFIG_DIR = tmpDir
  return tmpDir
}

async function cleanupTmpDir(): Promise<void> {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
  delete process.env.CLAUDE_CONFIG_DIR
}

/** Write a team config.json to the temp directory. */
async function writeTeamConfig(
  teamName: string,
  config: Record<string, unknown>,
): Promise<string> {
  const teamDir = path.join(tmpDir, 'teams', teamName)
  await fs.mkdir(teamDir, { recursive: true })
  const configPath = path.join(teamDir, 'config.json')
  await fs.writeFile(configPath, JSON.stringify(config), 'utf-8')
  return configPath
}

async function writeTeamTask(
  teamName: string,
  task: Record<string, unknown>,
): Promise<void> {
  const taskDir = path.join(tmpDir, 'tasks', teamName)
  await fs.mkdir(taskDir, { recursive: true })
  await fs.writeFile(path.join(taskDir, `${task.id}.json`), JSON.stringify(task), 'utf8')
}

async function writeTeamInbox(
  teamName: string,
  recipient: string,
  messages: Record<string, unknown>[],
): Promise<void> {
  const inboxDir = path.join(tmpDir, 'teams', teamName, 'inboxes')
  await fs.mkdir(inboxDir, { recursive: true })
  await fs.writeFile(path.join(inboxDir, `${recipient}.json`), JSON.stringify(messages), 'utf8')
}

/** Write a mock JSONL transcript file under projects. */
async function writeTranscriptFile(
  projectDir: string,
  sessionId: string,
  entries: Record<string, unknown>[],
): Promise<string> {
  const dir = path.join(tmpDir, 'projects', projectDir)
  await fs.mkdir(dir, { recursive: true })
  const filePath = path.join(dir, `${sessionId}.jsonl`)
  const content = entries.map((e) => JSON.stringify(e)).join('\n') + '\n'
  await fs.writeFile(filePath, content, 'utf-8')
  return filePath
}

async function writeSubagentTranscriptFile(
  projectDir: string,
  leadSessionId: string,
  fileName: string,
  entries: Record<string, unknown>[],
): Promise<string> {
  const dir = path.join(tmpDir, 'projects', projectDir, leadSessionId, 'subagents')
  await fs.mkdir(dir, { recursive: true })
  const filePath = path.join(dir, fileName)
  const content = entries.map((e) => JSON.stringify(e)).join('\n') + '\n'
  await fs.writeFile(filePath, content, 'utf-8')
  return filePath
}

/** Create a standard team config for testing. */
function makeTeamConfig(overrides?: Record<string, unknown>) {
  return {
    name: 'test-team',
    description: 'A test team',
    createdAt: 1700000000000,
    leadAgentId: 'agent-lead',
    members: [
      {
        agentId: 'agent-lead',
        name: 'Lead Agent',
        agentType: 'lead',
        model: 'claude-opus-4-7',
        color: '#ff0000',
        joinedAt: 1700000000000,
        tmuxPaneId: '%0',
        cwd: '/tmp/project',
        sessionId: 'session-lead-001',
        isActive: true,
      },
      {
        agentId: 'agent-worker',
        name: 'Worker Agent',
        agentType: 'worker',
        model: 'claude-sonnet-4-20250514',
        color: '#00ff00',
        joinedAt: 1700000001000,
        tmuxPaneId: '%1',
        cwd: '/tmp/project/src',
        sessionId: 'session-worker-001',
        isActive: false,
      },
    ],
    ...overrides,
  }
}

function transcriptToolUse(
  id: string,
  name: string,
  input: Record<string, unknown>,
  timestamp: string,
): MessageEntry {
  return {
    id: `message-${id}`,
    type: 'tool_use',
    content: [{ type: 'tool_use', id, name, input }],
    timestamp,
    cwd: '/tmp/project',
  }
}

function transcriptToolResult(
  id: string,
  toolUseResult: Record<string, unknown>,
  timestamp: string,
  isError = false,
): MessageEntry {
  return {
    id: `result-${id}`,
    type: 'tool_result',
    content: [{
      type: 'tool_result',
      tool_use_id: id,
      content: 'ok',
      ...(isError ? { is_error: true } : {}),
    }],
    toolUseResult,
    timestamp,
  }
}

function disabledIndexGateway(): LocalIndexGateway {
  return {
    async start() {},
    async stop() {},
    getMode: () => 'off',
    getPublicStatus: () => ({
      mode: 'off',
      state: 'off',
      discovered: 0,
      indexed: 0,
      degradedSources: 0,
      databaseBytes: 0,
      walBytes: 0,
      lastUpdatedAt: null,
      lastErrorCode: null,
    }),
    isSessionScopeReady: () => false,
    listSessions: () => ({ sessions: [], total: 0 }),
    findSessionFiles: () => [],
    async rebuild() { return this.getPublicStatus() },
  }
}

// ============================================================================
// TeamService tests
// ============================================================================

describe('TeamService', () => {
  beforeEach(async () => {
    await setupTmpConfigDir()
    service = new TeamService()
  })

  afterEach(async () => {
    await cleanupTmpDir()
  })

  // --------------------------------------------------------------------------
  // listTeams
  // --------------------------------------------------------------------------

  it('should return empty list when no teams exist', async () => {
    const teams = await service.listTeams()
    expect(teams).toEqual([])
  })

  it('should return empty list when teams directory does not exist', async () => {
    await fs.rm(path.join(tmpDir, 'teams'), { recursive: true, force: true })
    const teams = await service.listTeams()
    expect(teams).toEqual([])
  })

  it('should list teams from config files', async () => {
    await writeTeamConfig('alpha', makeTeamConfig({ name: 'alpha' }))
    await writeTeamConfig('beta', makeTeamConfig({ name: 'beta', description: 'Beta team' }))

    const teams = await service.listTeams()
    expect(teams).toHaveLength(2)

    const names = teams.map((t) => t.name).sort()
    expect(names).toEqual(['alpha', 'beta'])
  })

  it('should compute memberCount and activeMemberCount', async () => {
    await writeTeamConfig('gamma', makeTeamConfig({ name: 'gamma' }))

    const teams = await service.listTeams()
    expect(teams).toHaveLength(1)
    expect(teams[0]!.memberCount).toBe(2)
    expect(teams[0]!.activeMemberCount).toBe(1) // only lead is active
  })

  it('should skip malformed team directories', async () => {
    // Create a team dir with invalid JSON
    const badDir = path.join(tmpDir, 'teams', 'bad-team')
    await fs.mkdir(badDir, { recursive: true })
    await fs.writeFile(path.join(badDir, 'config.json'), 'not json', 'utf-8')

    // Also create a valid team
    await writeTeamConfig('good-team', makeTeamConfig({ name: 'good-team' }))

    const teams = await service.listTeams()
    expect(teams).toHaveLength(1)
    expect(teams[0]!.name).toBe('good-team')
  })

  // --------------------------------------------------------------------------
  // getTeam
  // --------------------------------------------------------------------------

  it('should return team detail with members', async () => {
    await writeTeamConfig(
      'detail-team',
      makeTeamConfig({
        name: 'detail-team',
        leadSessionId: 'lead-session-xyz',
      }),
    )

    const detail = await service.getTeam('detail-team')
    expect(detail.name).toBe('detail-team')
    expect(detail.leadAgentId).toBe('agent-lead')
    expect(detail.leadSessionId).toBe('lead-session-xyz')
    expect(detail.incarnationId).toBe(teamIncarnationId({
      name: 'detail-team',
      createdAt: 1700000000000,
      leadSessionId: 'lead-session-xyz',
    }))
    expect(detail.members).toHaveLength(2)
    expect(detail.members[0]!.agentId).toBe('agent-lead')
    expect(detail.members[1]!.agentId).toBe('agent-worker')
  })

  it('keeps a member idle while it still owns an in-progress task', async () => {
    // A teammate marks a task started and then finishes its turn, and an
    // umbrella task stays open across every turn underneath it. Deriving
    // activity from task state is what made every member look busy for a whole
    // run, so the roster's own turn marker has to win.
    await writeTeamConfig('activity-team', makeTeamConfig({
      name: 'activity-team',
      leadSessionId: 'lead-session-activity',
      members: [{
        agentId: 'backend-dev@activity-team',
        name: 'backend-dev',
        agentType: 'backend-dev',
        joinedAt: 1700000000000,
        cwd: '/tmp/project',
        isActive: false,
      }],
    }))
    await writeTeamTask('activity-team', {
      id: '1',
      subject: 'Umbrella task',
      description: '',
      status: 'in_progress',
      owner: 'backend-dev',
      blocks: [],
      blockedBy: [],
    })

    const snapshot = await service.getWorkbench('activity-team')
    const member = snapshot.team.members.find(m => m.name === 'backend-dev')!
    expect(member.activity).toBe('idle')
    expect(snapshot.tasks.find(task => task.id === '1')!.status).toBe('in_progress')
  })

  it('falls back to transcript writes when a backend records no turn markers', async () => {
    await writeTeamConfig('probe-team', makeTeamConfig({
      name: 'probe-team',
      leadSessionId: 'lead-session-probe',
      members: [
        {
          agentId: 'fresh@probe-team',
          name: 'fresh',
          agentType: 'fresh',
          joinedAt: 1700000000000,
          cwd: '/tmp/project',
        },
        {
          agentId: 'stale@probe-team',
          name: 'stale',
          agentType: 'stale',
          joinedAt: 1700000000000,
          cwd: '/tmp/project',
        },
        {
          agentId: 'silent@probe-team',
          name: 'silent',
          agentType: 'silent',
          joinedAt: 1700000000000,
          cwd: '/tmp/project',
        },
      ],
    }))

    for (const name of ['fresh', 'stale']) {
      const filePath = await writeSubagentTranscriptFile(
        '-tmp-project',
        'lead-session-probe',
        `agent-${name}.jsonl`,
        [{
          type: 'assistant',
          agentName: name,
          uuid: `${name}-entry`,
          message: { role: 'assistant', content: 'work' },
          timestamp: '2026-01-01T00:00:01.000Z',
        }],
      )
      const writtenAt = name === 'fresh' ? new Date() : new Date(Date.now() - 60_000)
      await fs.utimes(filePath, writtenAt, writtenAt)
    }

    const detail = await service.getTeam('probe-team')
    const activityByName = new Map(detail.members.map(m => [m.name, m.activity]))
    expect(activityByName.get('fresh')).toBe('active')
    expect(activityByName.get('stale')).toBe('idle')
    expect(activityByName.get('silent')).toBe('unknown')
  })

  it('should discover missing in-process members from subagent transcripts', async () => {
    await writeTeamConfig(
      'subagent-team',
      makeTeamConfig({
        name: 'subagent-team',
        leadSessionId: 'lead-session-subagents',
        members: [
          {
            agentId: 'agent-lead',
            name: 'Lead Agent',
            agentType: 'lead',
            joinedAt: 1700000000000,
            tmuxPaneId: '%0',
            cwd: '/tmp/project',
            sessionId: 'session-lead-001',
            isActive: true,
          },
        ],
      }),
    )

    await writeSubagentTranscriptFile(
      '-tmp-project',
      'lead-session-subagents',
      'agent-1.jsonl',
      [
        {
          agentName: 'security-reviewer',
          agentId: 'security-reviewer@subagent-team',
          timestamp: '2026-01-01T00:00:00.000Z',
        },
      ],
    )

    const detail = await service.getTeam('subagent-team')
    expect(detail.members.some((member) => member.name === 'security-reviewer')).toBe(true)
  })

  it('replays a cumulative snapshot chain once instead of per fragment', async () => {
    await writeTeamConfig('cumulative-team', makeTeamConfig({
      name: 'cumulative-team',
      leadSessionId: 'lead-session-cumulative',
      members: [{
        agentId: 'backend-dev@cumulative-team',
        name: 'backend-dev',
        agentType: 'backend-dev',
        joinedAt: 1700000000000,
        cwd: '/tmp/project',
        isActive: false,
      }],
    }))

    // Every turn rewrites the whole transcript, so each fragment repeats all of
    // its predecessor's entries and appends the new ones. The rewrite restamps
    // the session and turn an entry was written into -- fragment id, slug, cwd
    // and promptId -- so the shared history is never byte-identical.
    const entry = (fragment: string, index: number) => ({
      type: 'assistant',
      agentName: 'backend-dev',
      agentId: fragment,
      slug: `slug-${fragment}`,
      cwd: `/tmp/project/${fragment}`,
      promptId: `prompt-${fragment}`,
      uuid: `turn-${index}`,
      message: { role: 'assistant', content: `step ${index}` },
      timestamp: `2026-01-01T00:00:0${index}.000Z`,
    })
    for (const [index, length] of [2, 4, 6].entries()) {
      const fragment = `snapshot-${index}`
      const filePath = await writeSubagentTranscriptFile(
        '-tmp-project',
        'lead-session-cumulative',
        `agent-${fragment}.jsonl`,
        Array.from({ length }, (_unused, position) => entry(fragment, position)),
      )
      await fs.utimes(filePath, new Date(1_000 * (index + 1)), new Date(1_000 * (index + 1)))
    }

    const page = await service.getMemberTranscriptPage(
      'cumulative-team',
      'backend-dev@cumulative-team',
    )

    const ids = page.messages.map(message => message.id)
    expect(ids).toEqual([
      'snapshot-2/turn-0',
      'snapshot-2/turn-1',
      'snapshot-2/turn-2',
      'snapshot-2/turn-3',
      'snapshot-2/turn-4',
      'snapshot-2/turn-5',
    ])
    expect(new Set(ids).size).toBe(ids.length)
    expect(page.ownerAgentIds).toEqual(['snapshot-2'])
  })

  it('keeps a superseded fragment tool call paired inside the surviving fragment', async () => {
    await writeTeamConfig('cumulative-pairing-team', makeTeamConfig({
      name: 'cumulative-pairing-team',
      leadSessionId: 'lead-session-cumulative-pairing',
      members: [{
        agentId: 'backend-dev@cumulative-pairing-team',
        name: 'backend-dev',
        agentType: 'backend-dev',
        joinedAt: 1700000000000,
        cwd: '/tmp/project',
        isActive: false,
      }],
    }))

    // The call lands in the earlier snapshot and its result only arrives in the
    // rewrite, so a per-fragment scope would split the pair across two owners.
    const toolUse = {
      type: 'assistant',
      agentName: 'backend-dev',
      uuid: 'tool-call',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'Bash:0', name: 'Bash', input: { command: 'ls' } }],
      },
      timestamp: '2026-01-01T00:00:01.000Z',
    }
    const toolResult = {
      type: 'user',
      agentName: 'backend-dev',
      uuid: 'tool-result',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'Bash:0', content: 'ok' }],
      },
      timestamp: '2026-01-01T00:00:02.000Z',
    }
    const truncated = await writeSubagentTranscriptFile(
      '-tmp-project',
      'lead-session-cumulative-pairing',
      'agent-partial.jsonl',
      [toolUse],
    )
    const complete = await writeSubagentTranscriptFile(
      '-tmp-project',
      'lead-session-cumulative-pairing',
      'agent-complete.jsonl',
      [toolUse, toolResult],
    )
    await fs.utimes(truncated, new Date(1_000), new Date(1_000))
    await fs.utimes(complete, new Date(2_000), new Date(2_000))

    const page = await service.getMemberTranscriptPage(
      'cumulative-pairing-team',
      'backend-dev@cumulative-pairing-team',
    )

    const blocks = page.messages.flatMap(message => (
      Array.isArray(message.content)
        ? message.content.filter((block): block is Record<string, unknown> => (
            !!block && typeof block === 'object'
          ))
        : []
    ))
    expect(blocks.find(block => block.type === 'tool_use')?.id).toBe('complete/Bash:0')
    expect(blocks.find(block => block.type === 'tool_result')?.tool_use_id).toBe('complete/Bash:0')
  })

  it('marks where a member started and finished each task in its transcript', async () => {
    await writeTeamConfig('anchor-team', makeTeamConfig({
      name: 'anchor-team',
      leadSessionId: 'lead-session-anchor',
      members: [{
        agentId: 'backend-dev@anchor-team',
        name: 'backend-dev',
        agentType: 'backend-dev',
        joinedAt: 1700000000000,
        cwd: '/tmp/project',
        isActive: false,
      }],
    }))
    const taskUpdate = (uuid: string, taskId: string, status: string, second: number) => ({
      type: 'assistant',
      agentName: 'backend-dev',
      uuid,
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: `TaskUpdate:${uuid}`,
          name: 'TaskUpdate',
          input: { taskId, status },
        }],
      },
      timestamp: `2026-01-01T00:00:0${second}.000Z`,
    })
    await writeSubagentTranscriptFile(
      '-tmp-project',
      'lead-session-anchor',
      'agent-anchors.jsonl',
      [
        taskUpdate('start-11', '11', 'in_progress', 1),
        {
          type: 'assistant',
          agentName: 'backend-dev',
          uuid: 'prose',
          message: { role: 'assistant', content: 'Working' },
          timestamp: '2026-01-01T00:00:02.000Z',
        },
        taskUpdate('done-11', '11', 'completed', 3),
        taskUpdate('start-10', '10', 'in_progress', 4),
      ],
    )

    const page = await service.getMemberTranscriptPage(
      'anchor-team',
      'backend-dev@anchor-team',
    )

    expect(page.taskAnchors.map(anchor => [anchor.taskId, anchor.status])).toEqual([
      ['11', 'in_progress'],
      ['11', 'completed'],
      ['10', 'in_progress'],
    ])
    // Each anchor points at a real message so the conversation can be split by task.
    const messageIds = new Set(page.messages.map(message => message.id))
    expect(page.taskAnchors.every(anchor => messageIds.has(anchor.messageId))).toBe(true)
  })

  it('exposes task anchors on the full-page transcript read as well as the incremental one', async () => {
    await writeTeamConfig('anchor-route-team', makeTeamConfig({
      name: 'anchor-route-team',
      leadSessionId: 'lead-session-anchor-route',
      members: [{
        agentId: 'backend-dev@anchor-route-team',
        name: 'backend-dev',
        agentType: 'backend-dev',
        joinedAt: 1700000000000,
        cwd: '/tmp/project',
        isActive: false,
      }],
    }))
    await writeSubagentTranscriptFile(
      '-tmp-project',
      'lead-session-anchor-route',
      'agent-route.jsonl',
      [{
        type: 'assistant',
        agentName: 'backend-dev',
        uuid: 'start-3',
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'TaskUpdate:0',
            name: 'TaskUpdate',
            input: { taskId: '3', status: 'in_progress' },
          }],
        },
        timestamp: '2026-01-01T00:00:01.000Z',
      }],
    )

    // The full-page read hand-picks response fields, so a new one has to be
    // added there too or the desktop silently loses it on first load.
    const full = await service.getMemberTranscriptPage(
      'anchor-route-team',
      'backend-dev@anchor-route-team',
    )
    const incremental = await service.getMemberTranscriptPage(
      'anchor-route-team',
      'backend-dev@anchor-route-team',
      { afterOrdinal: -1 },
    )
    expect(full.taskAnchors).toEqual(incremental.taskAnchors)
    expect(full.taskAnchors).toHaveLength(1)
  })

  it('aggregates every resumed transcript fragment into one member conversation', async () => {
    await writeTeamConfig('resumed-team', makeTeamConfig({
      name: 'resumed-team',
      leadSessionId: 'lead-session-resumed',
      members: [{
        agentId: 'security-reviewer@resumed-team',
        name: 'security-reviewer',
        agentType: 'security-reviewer',
        joinedAt: 1700000000000,
        cwd: '/tmp/project',
        isActive: false,
      }],
    }))
    const firstPath = await writeSubagentTranscriptFile(
      '-tmp-project',
      'lead-session-resumed',
      'agent-a.jsonl',
      [{
        type: 'assistant',
        agentName: 'security-reviewer',
        uuid: 'first-fragment',
        message: { role: 'assistant', content: 'first review' },
        timestamp: '2026-01-01T00:00:01.000Z',
      }],
    )
    const secondPath = await writeSubagentTranscriptFile(
      '-tmp-project',
      'lead-session-resumed',
      'agent-b.jsonl',
      [{
        type: 'assistant',
        agentName: 'security-reviewer',
        uuid: 'second-fragment',
        message: { role: 'assistant', content: 'second review' },
        timestamp: '2026-01-01T00:00:02.000Z',
      }],
    )
    await fs.utimes(firstPath, new Date(1_000), new Date(1_000))
    await fs.utimes(secondPath, new Date(2_000), new Date(2_000))

    const initial = await service.getMemberTranscriptPage(
      'resumed-team',
      'security-reviewer@resumed-team',
    )

    expect(initial.ownerAgentIds).toEqual(['a', 'b'])
    expect(initial.messages.map(message => message.id)).toEqual([
      'a/first-fragment',
      'b/second-fragment',
    ])

    await fs.appendFile(secondPath, `${JSON.stringify({
      type: 'assistant',
      agentName: 'security-reviewer',
      uuid: 'continued-fragment',
      message: { role: 'assistant', content: 'continued review' },
      timestamp: '2026-01-01T00:00:03.000Z',
    })}\n`)
    const continued = await service.getMemberTranscriptPage(
      'resumed-team',
      'security-reviewer@resumed-team',
      {
        signature: initial.signature,
        cursor: initial.cursor,
        afterOrdinal: initial.afterOrdinal,
      },
    )

    expect(continued.reset).toBeUndefined()
    expect(continued.ownerAgentIds).toEqual(['a', 'b'])
    expect(continued.messages.map(message => message.id)).toEqual(['b/continued-fragment'])
  })

  it('scopes reused tool and task identities to each resumed physical fragment', async () => {
    await writeTeamConfig('scoped-fragment-team', makeTeamConfig({
      name: 'scoped-fragment-team',
      leadSessionId: 'lead-session-scoped-fragments',
      members: [{
        agentId: 'security-reviewer@scoped-fragment-team',
        name: 'security-reviewer',
        agentType: 'security-reviewer',
        joinedAt: 1700000000000,
        cwd: '/tmp/project',
        isActive: false,
      }],
    }))

    const fragmentEntries = (fragment: string, timestampPrefix: string) => [
      {
        type: 'assistant',
        agentName: 'security-reviewer',
        uuid: 'shared-tools-message',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'Agent:0',
              name: 'Agent',
              input: { description: `${fragment} nested agent` },
            },
            {
              type: 'tool_use',
              id: 'Bash:0',
              name: 'Bash',
              input: { command: `echo ${fragment}`, run_in_background: true },
            },
            {
              type: 'tool_use',
              id: 'TodoWrite:0',
              name: 'TodoWrite',
              input: { todos: [{ content: `${fragment} todo`, status: 'pending' }] },
            },
          ],
        },
        timestamp: `${timestampPrefix}1.000Z`,
      },
      {
        type: 'user',
        agentName: 'security-reviewer',
        uuid: 'shared-agent-result',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'Agent:0',
            content: `agentId: nested-${fragment}`,
          }],
        },
        timestamp: `${timestampPrefix}2.000Z`,
      },
      {
        type: 'user',
        agentName: 'security-reviewer',
        uuid: 'shared-bash-result',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'Bash:0',
            content: 'Command running in background with ID: task-0',
          }],
        },
        toolUseResult: { backgroundTaskId: 'task-0' },
        timestamp: `${timestampPrefix}3.000Z`,
      },
      {
        type: 'user',
        agentName: 'security-reviewer',
        uuid: 'shared-todo-result',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'TodoWrite:0', content: 'ok' }],
        },
        timestamp: `${timestampPrefix}4.000Z`,
      },
      {
        type: 'cc-haha-task-notification',
        isMeta: true,
        taskNotification: {
          taskId: 'task-0',
          toolUseId: 'Bash:0',
          status: 'completed',
          timestamp: `${timestampPrefix}5.000Z`,
        },
        timestamp: `${timestampPrefix}5.000Z`,
      },
    ]

    const firstPath = await writeSubagentTranscriptFile(
      '-tmp-project',
      'lead-session-scoped-fragments',
      'agent-fragment-a.jsonl',
      fragmentEntries('fragment-a', '2026-01-01T00:00:0'),
    )
    const secondPath = await writeSubagentTranscriptFile(
      '-tmp-project',
      'lead-session-scoped-fragments',
      'agent-fragment-b.jsonl',
      fragmentEntries('fragment-b', '2026-01-01T00:01:0'),
    )
    await fs.utimes(firstPath, new Date(1_000), new Date(1_000))
    await fs.utimes(secondPath, new Date(2_000), new Date(2_000))

    const initial = await service.getMemberTranscriptPage(
      'scoped-fragment-team',
      'security-reviewer@scoped-fragment-team',
    )

    expect(initial.ownerAgentIds).toEqual(['fragment-a', 'fragment-b'])
    expect(new Set(initial.messages.map(message => message.id)).size).toBe(8)
    const toolUses = initial.messages.flatMap(message => (
      Array.isArray(message.content)
        ? message.content.filter((block): block is Record<string, unknown> => (
            !!block && typeof block === 'object' && block.type === 'tool_use'
          ))
        : []
    ))
    expect(toolUses.map(block => block.id)).toEqual([
      'fragment-a/Agent:0',
      'fragment-a/Bash:0',
      'fragment-a/TodoWrite:0',
      'fragment-b/Agent:0',
      'fragment-b/Bash:0',
      'fragment-b/TodoWrite:0',
    ])
    expect(toolUses.map(block => block.original_tool_use_id)).toEqual([
      'Agent:0',
      'Bash:0',
      'TodoWrite:0',
      'Agent:0',
      'Bash:0',
      'TodoWrite:0',
    ])
    const toolResults = initial.messages.flatMap(message => (
      Array.isArray(message.content)
        ? message.content.filter((block): block is Record<string, unknown> => (
            !!block && typeof block === 'object' && block.type === 'tool_result'
          ))
        : []
    ))
    expect(toolResults.map(block => block.tool_use_id)).toEqual([
      'fragment-a/Agent:0',
      'fragment-a/Bash:0',
      'fragment-a/TodoWrite:0',
      'fragment-b/Agent:0',
      'fragment-b/Bash:0',
      'fragment-b/TodoWrite:0',
    ])
    expect(toolResults.map(block => block.original_tool_use_id)).toEqual([
      'Agent:0',
      'Bash:0',
      'TodoWrite:0',
      'Agent:0',
      'Bash:0',
      'TodoWrite:0',
    ])
    expect(initial.messages.find(message => message.id === 'fragment-a/shared-bash-result')?.toolUseResult)
      .toEqual({ backgroundTaskId: 'fragment-a/task-0' })
    expect(initial.messages.find(message => message.id === 'fragment-b/shared-bash-result')?.toolUseResult)
      .toEqual({ backgroundTaskId: 'fragment-b/task-0' })
    expect(initial.taskNotifications).toEqual([
      expect.objectContaining({
        taskId: 'fragment-a/task-0',
        toolUseId: 'fragment-a/Bash:0',
      }),
      expect.objectContaining({
        taskId: 'fragment-b/task-0',
        toolUseId: 'fragment-b/Bash:0',
      }),
    ])

    await fs.appendFile(secondPath, `${JSON.stringify({
      type: 'assistant',
      agentName: 'security-reviewer',
      uuid: 'continued-message',
      message: { role: 'assistant', content: 'continued' },
      timestamp: '2026-01-01T00:01:06.000Z',
    })}\n`)
    const continued = await service.getMemberTranscriptPage(
      'scoped-fragment-team',
      'security-reviewer@scoped-fragment-team',
      {
        signature: initial.signature,
        cursor: initial.cursor,
        afterOrdinal: initial.afterOrdinal,
      },
    )
    expect(continued.reset).toBeUndefined()
    expect(continued.ownerAgentIds).toEqual(['fragment-a', 'fragment-b'])
    expect(continued.messages.map(message => message.id)).toEqual([
      'fragment-b/continued-message',
    ])

    const reset = await service.getMemberTranscriptPage(
      'scoped-fragment-team',
      'security-reviewer@scoped-fragment-team',
      {
        signature: continued.signature,
        cursor: 'malformed',
        afterOrdinal: continued.afterOrdinal,
      },
    )
    expect(reset.reset).toBe(true)
    expect(reset.ownerAgentIds).toEqual(['fragment-a', 'fragment-b'])
    expect(reset.messages.some(message => message.id === 'fragment-a/shared-tools-message')).toBe(true)
    expect(reset.messages.some(message => message.id === 'fragment-b/shared-tools-message')).toBe(true)
  })

  it('carries structured tool results through the member transcript', async () => {
    await writeTeamConfig('tool-result-team', makeTeamConfig({
      name: 'tool-result-team',
      leadSessionId: 'lead-session-tool-result',
      members: [{
        agentId: 'security-reviewer@tool-result-team',
        name: 'security-reviewer',
        agentType: 'security-reviewer',
        joinedAt: 1700000000000,
        cwd: '/tmp/project',
        isActive: false,
      }],
    }))
    await writeSubagentTranscriptFile(
      '-tmp-project',
      'lead-session-tool-result',
      'agent-tools.jsonl',
      [{
        type: 'tool_result',
        agentName: 'security-reviewer',
        uuid: 'tool-result-message',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'ok' }],
        },
        // The desktop transcript renders structured results from this field;
        // dropping it degraded every member tool call to plain text.
        toolUseResult: { questions: [{ question: 'Ship?' }], answers: { Ship: 'yes' } },
        timestamp: '2026-01-01T00:00:01.000Z',
      }],
    )

    const page = await service.getMemberTranscriptPage(
      'tool-result-team',
      'security-reviewer@tool-result-team',
    )

    expect(page.messages).toHaveLength(1)
    expect(page.ownerAgentIds).toEqual(['tools'])
    expect(page.messages[0]!.id).toBe('tools/tool-result-message')
    expect(page.messages[0]!.toolUseResult).toEqual({
      questions: [{ question: 'Ship?' }],
      answers: { Ship: 'yes' },
    })
  })

  it('does not identify a teammate transcript from another member prompt mention', async () => {
    await writeTeamConfig('identity-team', makeTeamConfig({
      name: 'identity-team',
      leadSessionId: 'lead-session-identity',
      members: [{
        agentId: 'security-reviewer@identity-team',
        name: 'security-reviewer',
        agentType: 'security-reviewer',
        joinedAt: 1700000000000,
        cwd: '/tmp/project',
        isActive: false,
      }],
    }))
    await writeSubagentTranscriptFile(
      '-tmp-project',
      'lead-session-identity',
      'agent-security.jsonl',
      [{
        type: 'assistant',
        agentName: 'security-reviewer',
        uuid: 'security-message',
        message: { role: 'assistant', content: 'security review complete' },
        timestamp: '2026-01-01T00:00:01.000Z',
      }],
    )
    await writeSubagentTranscriptFile(
      '-tmp-project',
      'lead-session-identity',
      'agent-docs.jsonl',
      [{
        type: 'assistant',
        agentName: 'docs-coordinator',
        uuid: 'docs-message',
        message: {
          role: 'assistant',
          content: 'Summarize findings from "security-reviewer" and **security-reviewer**.',
        },
        timestamp: '2026-01-01T00:00:02.000Z',
      }],
    )

    const page = await service.getMemberTranscriptPage(
      'identity-team',
      'security-reviewer@identity-team',
    )

    expect(page.ownerAgentIds).toEqual(['security'])
    expect(page.messages.map((message) => message.id)).toEqual([
      'security/security-message',
    ])
  })

  it('should derive running status for active member', async () => {
    await writeTeamConfig('status-team', makeTeamConfig({ name: 'status-team' }))

    const detail = await service.getTeam('status-team')
    const lead = detail.members.find((m) => m.agentId === 'agent-lead')!
    expect(lead.status).toBe('running')
  })

  it('should derive idle status for inactive member', async () => {
    await writeTeamConfig('status-team', makeTeamConfig({ name: 'status-team' }))

    const detail = await service.getTeam('status-team')
    const worker = detail.members.find((m) => m.agentId === 'agent-worker')!
    expect(worker.status).toBe('idle')
  })

  it('joins team, task DAG, and mailbox history without collapsing legitimate repeats', async () => {
    await writeTeamConfig('workbench-team', makeTeamConfig({
      name: 'workbench-team',
      leadSessionId: 'lead-session-workbench',
      members: [
        ...(makeTeamConfig().members as Array<Record<string, unknown>>),
        {
          agentId: 'reviewer@workbench-team',
          name: 'reviewer',
          agentType: 'reviewer',
          joinedAt: 1700000002000,
          tmuxPaneId: '%2',
          cwd: '/tmp/project',
          isActive: true,
        },
      ],
    }))
    await writeTeamTask('workbench-team', {
      id: '1',
      subject: 'Build server contract',
      description: 'Join the CLI data sources',
      owner: 'Worker Agent',
      status: 'completed',
      blocks: ['2'],
      blockedBy: [],
    })
    await writeTeamTask('workbench-team', {
      id: '2',
      subject: 'Verify the desktop',
      description: 'Exercise the complete workbench',
      owner: 'reviewer',
      status: 'in_progress',
      blocks: [],
      blockedBy: ['1'],
    })
    const repeated = {
      from: 'Lead Agent',
      text: 'Please review the dependency join',
      timestamp: '2026-08-08T00:00:00.000Z',
    }
    await writeTeamInbox('workbench-team', 'Worker Agent', [
      { ...repeated, id: 'broadcast-1' },
      { ...repeated, id: 'direct-repeat-a' },
      {
        from: 'Bash',
        text: 'Tool activity must not become a teammate',
        timestamp: '2026-08-08T00:00:02.000Z',
      },
      {
        from: 'Lead Agent',
        text: 'Legacy broadcast remains readable',
        timestamp: '2026-08-08T00:00:03.000Z',
      },
    ])
    await writeTeamInbox('workbench-team', 'reviewer', [
      { ...repeated, id: 'broadcast-1', timestamp: '2026-08-08T00:00:00.042Z' },
      { ...repeated, id: 'direct-repeat-b', timestamp: '2026-08-08T00:00:00.043Z' },
      {
        from: 'Lead Agent',
        text: JSON.stringify({ type: 'task_assignment', taskId: '2', subject: 'Verify the desktop' }),
        timestamp: '2026-08-08T00:00:01.000Z',
      },
      {
        from: 'Lead Agent',
        text: 'Legacy broadcast remains readable',
        timestamp: '2026-08-08T00:00:03.021Z',
      },
    ])

    const snapshot = await service.getWorkbench('workbench-team')

    expect(snapshot.team.leadSessionId).toBe('lead-session-workbench')
    expect(snapshot.team.members.map((member) => member.name)).toEqual([
      'Lead Agent',
      'Worker Agent',
      'reviewer',
    ])
    expect(snapshot.tasks.map((task) => ({ id: task.id, blockedBy: task.blockedBy }))).toEqual([
      { id: '1', blockedBy: [] },
      { id: '2', blockedBy: ['1'] },
    ])
    expect(snapshot.messages).toHaveLength(6)
    expect(snapshot.messages[0]).toMatchObject({
      kind: 'broadcast',
      recipients: ['Worker Agent', 'reviewer'],
    })
    expect(snapshot.messages[1]).toMatchObject({
      kind: 'direct',
      recipients: ['Worker Agent'],
    })
    expect(snapshot.messages[2]).toMatchObject({
      kind: 'direct',
      recipients: ['reviewer'],
    })
    expect(snapshot.messages[3]).toMatchObject({
      kind: 'system',
      protocolType: 'task_assignment',
      taskId: '2',
      text: 'Verify the desktop',
    })
    expect(snapshot.messages[4]).toMatchObject({
      kind: 'direct',
      from: 'Bash',
      recipients: ['Worker Agent'],
    })
    expect(snapshot.messages[5]).toMatchObject({
      kind: 'broadcast',
      text: 'Legacy broadcast remains readable',
      recipients: ['Worker Agent', 'reviewer'],
    })

    const unchanged = await service.getWorkbench('workbench-team')
    expect(unchanged.version).toBe(snapshot.version)
  })

  it('reopens an archived workbench by lead session after CLI team cleanup', async () => {
    await writeTeamConfig('archived-team', makeTeamConfig({
      name: 'archived-team',
      leadSessionId: 'archived-lead-session',
    }))
    await writeTeamTask('archived-team', {
      id: '1',
      subject: 'Persist the final DAG',
      description: 'Survive deletion of the transient CLI directories',
      owner: 'Worker Agent',
      status: 'completed',
      blocks: [],
      blockedBy: [],
    })

    const live = await service.getWorkbench('archived-team')
    await fs.rm(path.join(tmpDir, 'teams', 'archived-team'), { recursive: true, force: true })
    await fs.rm(path.join(tmpDir, 'tasks', 'archived-team'), { recursive: true, force: true })

    const reopened = await service.getWorkbenchForSession('archived-lead-session')

    expect(reopened).toMatchObject({
      sessionId: 'archived-lead-session',
      teamName: 'archived-team',
      source: 'archive',
    })
    expect(reopened?.snapshots.at(-1)).toEqual(live)
  })

  it('reconciles the final task tail from the matching Team incarnation before deletion', async () => {
    const teamName = 'delete-before-next-poll'
    const leadSessionId = 'delete-before-next-poll-lead'
    const createdAt = Date.now() - 1_000
    let transcript: MessageEntry[] = []
    service = new TeamService({
      sessionReader: {
        getSessionMessages: async () => transcript,
      },
    })
    await writeTeamConfig(teamName, makeTeamConfig({
      name: teamName,
      leadSessionId,
      createdAt,
    }))
    for (const task of [{
      id: '1',
      subject: 'Finish after the last watcher poll',
    }, {
      id: '2',
      subject: 'Observe the final TaskList',
    }]) {
      await writeTeamTask(teamName, {
        ...task,
        description: task.subject,
        status: 'pending',
        blocks: [],
        blockedBy: [],
      })
    }

    const stale = await service.getWorkbench(teamName)
    const archivedAt = Date.parse(stale.generatedAt)
    const timestamp = (value: number) => new Date(value).toISOString()
    transcript = [
      transcriptToolUse('matching-team-create', 'TeamCreate', {
        team_name: 'requested-delete-before-next-poll',
      }, timestamp(createdAt - 1)),
      transcriptToolResult('matching-team-create', {
        team_name: teamName,
        lead_agent_id: `team-lead@${teamName}`,
      }, timestamp(createdAt + 1)),
      transcriptToolUse('final-task-list', 'TaskList', {}, timestamp(archivedAt + 10)),
      transcriptToolResult('final-task-list', {
        tasks: [{
          id: '1',
          subject: 'Finish after the last watcher poll',
          owner: 'Worker Agent',
          status: 'pending',
        }, {
          id: '2',
          subject: 'Observe the final TaskList',
          owner: 'Observer Agent',
          status: 'completed',
        }],
      }, timestamp(archivedAt + 11)),
      transcriptToolUse('late-task-create', 'TaskCreate', {
        subject: 'Created after the final watcher poll',
        description: 'Must survive immediate Team deletion',
      }, timestamp(archivedAt + 12)),
      transcriptToolResult('late-task-create', {
        success: true,
        task: {
          id: '3',
          subject: 'Created after the final watcher poll',
          description: 'Must survive immediate Team deletion',
        },
      }, timestamp(archivedAt + 13)),
      transcriptToolUse('final-task-update', 'TaskUpdate', {
        taskId: '1',
        owner: 'Worker Agent',
        status: 'completed',
      }, timestamp(archivedAt + 20)),
      transcriptToolResult('final-task-update', {
        success: true,
        taskId: '1',
        updatedFields: ['owner', 'status'],
      }, timestamp(archivedAt + 21)),
      transcriptToolUse('matching-team-delete', 'TeamDelete', {}, timestamp(archivedAt + 25)),
      transcriptToolResult('matching-team-delete', {
        success: true,
        team_name: teamName,
      }, timestamp(archivedAt + 26)),
      // A later same-name Team in the same lead session is a different
      // incarnation and must not overwrite the tombstone being repaired.
      transcriptToolUse('next-team-create', 'TeamCreate', {
        team_name: teamName,
      }, timestamp(archivedAt + 30)),
      transcriptToolResult('next-team-create', {
        team_name: teamName,
        lead_agent_id: `team-lead@${teamName}`,
      }, timestamp(archivedAt + 31)),
      transcriptToolUse('next-team-task-list', 'TaskList', {}, timestamp(archivedAt + 40)),
      transcriptToolResult('next-team-task-list', {
        tasks: [{
          id: '1',
          subject: 'Wrong incarnation',
          owner: 'Wrong Agent',
          status: 'pending',
        }],
      }, timestamp(archivedAt + 41)),
    ]

    // The task files reach their terminal state, but TeamDelete removes both
    // directories before TeamWatcher performs another joined workbench read.
    await writeTeamTask(teamName, {
      id: '1',
      subject: 'Finish after the last watcher poll',
      description: 'Finish after the last watcher poll',
      owner: 'Worker Agent',
      status: 'completed',
      blocks: [],
      blockedBy: [],
    })
    await writeTeamTask(teamName, {
      id: '2',
      subject: 'Observe the final TaskList',
      description: 'Observe the final TaskList',
      owner: 'Observer Agent',
      status: 'completed',
      blocks: [],
      blockedBy: [],
    })
    await fs.rm(path.join(tmpDir, 'teams', teamName), { recursive: true, force: true })
    await fs.rm(path.join(tmpDir, 'tasks', teamName), { recursive: true, force: true })

    await service.markWorkbenchArchiveDeleted(
      teamName,
      leadSessionId,
      stale.team.incarnationId,
    )
    const reopened = await service.getWorkbenchForSession(leadSessionId, {
      incarnationId: stale.team.incarnationId,
    })

    expect(reopened?.source).toBe('archive')
    expect(reopened?.snapshots.at(-1)?.deletedAt).toBeDefined()
    expect(reopened?.snapshots.at(-1)?.version).toContain(':tasks:')
    expect(reopened?.snapshots.at(-1)?.tasks.map(task => ({
      id: task.id,
      subject: task.subject,
      owner: task.owner,
      status: task.status,
    }))).toEqual([{
      id: '1',
      subject: 'Finish after the last watcher poll',
      owner: 'Worker Agent',
      status: 'completed',
    }, {
      id: '2',
      subject: 'Observe the final TaskList',
      owner: 'Observer Agent',
      status: 'completed',
    }, {
      id: '3',
      subject: 'Created after the final watcher poll',
      owner: undefined,
      status: 'pending',
    }])
  })

  it('uses the TeamDelete terminal task frame when cleanup follows the last watcher poll', async () => {
    const teamName = 'terminal-delete-frame'
    const leadSessionId = 'terminal-delete-frame-lead'
    const createdAt = Date.now() - 1_000
    let transcript: MessageEntry[] = []
    service = new TeamService({
      sessionReader: {
        getSessionMessages: async () => transcript,
      },
    })
    await writeTeamConfig(teamName, makeTeamConfig({
      name: teamName,
      leadSessionId,
      createdAt,
    }))
    await writeTeamTask(teamName, {
      id: '1',
      subject: 'Finish before deleting the Team',
      description: 'The watcher still sees this task as pending',
      status: 'pending',
      blocks: [],
      blockedBy: [],
    })

    const stale = await service.getWorkbench(teamName)
    const boundary = Date.parse(stale.generatedAt)
    const timestamp = (value: number) => new Date(value).toISOString()
    transcript = [
      transcriptToolUse('terminal-create', 'TeamCreate', {
        team_name: teamName,
      }, timestamp(createdAt - 1)),
      transcriptToolResult('terminal-create', {
        success: true,
        team_name: teamName,
        lead_agent_id: `team-lead@${teamName}`,
      }, timestamp(createdAt + 1)),
      transcriptToolUse('terminal-delete', 'TeamDelete', {}, timestamp(boundary + 9)),
      transcriptToolResult('terminal-delete', {
        success: true,
        team_name: teamName,
        // The wall clock may collide with the previous snapshot; the locked
        // revision is the authoritative causal order.
        taskListSnapshotAt: timestamp(boundary),
        taskListSnapshotRevision: (stale.taskListRevision ?? 0) + 1,
        finalTasks: [{
          id: '1',
          subject: 'Finish before deleting the Team',
          description: 'The terminal frame owns the final state',
          owner: 'Worker Agent',
          status: 'completed',
          blocks: ['2'],
          blockedBy: [],
        }, {
          id: '2',
          subject: 'Preserve the terminal forward edge',
          description: 'TeamDelete carries the complete edge shape',
          status: 'completed',
          blocks: [],
          blockedBy: [],
        }],
      }, timestamp(boundary + 11)),
    ]

    await fs.rm(path.join(tmpDir, 'teams', teamName), { recursive: true, force: true })
    await fs.rm(path.join(tmpDir, 'tasks', teamName), { recursive: true, force: true })
    await service.markWorkbenchArchiveDeleted(
      teamName,
      leadSessionId,
      stale.team.incarnationId,
    )

    const reopened = await service.getWorkbenchForSession(leadSessionId, {
      incarnationId: stale.team.incarnationId,
    })
    expect(reopened?.snapshots.at(-1)).toMatchObject({
      deletedAt: expect.any(String),
      tasks: [{
        id: '1',
        subject: 'Finish before deleting the Team',
        description: 'The terminal frame owns the final state',
        owner: 'Worker Agent',
        status: 'completed',
        blocks: ['2'],
      }, {
        id: '2',
        subject: 'Preserve the terminal forward edge',
        description: 'TeamDelete carries the complete edge shape',
        status: 'completed',
        blockedBy: ['1'],
      }],
    })
  })

  it('consumes an equal-revision TeamDelete frame as the terminal boundary', async () => {
    const teamName = 'equal-revision-terminal-frame'
    const leadSessionId = 'equal-revision-terminal-lead'
    const createdAt = Date.now() - 1_000
    let transcript: MessageEntry[] = []
    service = new TeamService({
      sessionReader: { getSessionMessages: async () => transcript },
    })
    await writeTeamConfig(teamName, makeTeamConfig({
      name: teamName,
      leadSessionId,
      createdAt,
    }))
    await writeTeamTask(teamName, {
      id: '1',
      subject: 'No mutation during cleanup',
      description: 'The terminal frame still closes the lifecycle',
      status: 'completed',
      blocks: [],
      blockedBy: [],
    })
    const snapshot = await service.getWorkbench(teamName)
    const boundary = Date.parse(snapshot.generatedAt)
    const timestamp = (value: number) => new Date(value).toISOString()
    transcript = [
      transcriptToolUse('equal-revision-create', 'TeamCreate', {
        team_name: teamName,
      }, timestamp(createdAt - 1)),
      transcriptToolResult('equal-revision-create', {
        success: true,
        team_name: teamName,
        lead_agent_id: `team-lead@${teamName}`,
      }, timestamp(createdAt + 1)),
      transcriptToolUse('equal-revision-delete', 'TeamDelete', {}, timestamp(boundary + 1)),
      transcriptToolResult('equal-revision-delete', {
        success: true,
        team_name: teamName,
        taskListSnapshotAt: snapshot.generatedAt,
        taskListSnapshotRevision: snapshot.taskListRevision,
        finalTasks: snapshot.tasks,
      }, timestamp(boundary + 2)),
    ]

    await fs.rm(path.join(tmpDir, 'teams', teamName), { recursive: true, force: true })
    await fs.rm(path.join(tmpDir, 'tasks', teamName), { recursive: true, force: true })
    await service.markWorkbenchArchiveDeleted(
      teamName,
      leadSessionId,
      snapshot.team.incarnationId,
    )

    const reopened = await service.getWorkbenchForSession(leadSessionId)
    expect(reopened?.snapshots.at(-1)).toMatchObject({
      deletedAt: expect.any(String),
      terminalTaskFrameId: 'equal-revision-delete',
      taskListRevision: snapshot.taskListRevision,
      tasks: [expect.objectContaining({ id: '1', status: 'completed' })],
    })
  })

  it('enriches an existing tombstone when the terminal TeamDelete frame arrives late', async () => {
    const transcripts = new Map<string, MessageEntry[]>()
    service = new TeamService({
      sessionReader: {
        getSessionMessages: async (sessionId) => transcripts.get(sessionId) ?? [],
      },
    })

    for (const refreshMode of ['remark', 'reopen'] as const) {
      const teamName = `late-terminal-${refreshMode}`
      const leadSessionId = `${teamName}-lead`
      const createdAt = Date.now() - 1_000
      await writeTeamConfig(teamName, makeTeamConfig({
        name: teamName,
        leadSessionId,
        createdAt,
      }))
      await writeTeamTask(teamName, {
        id: '1',
        subject: 'Complete before transcript flush',
        description: 'The first tombstone is stale',
        status: 'pending',
        blocks: [],
        blockedBy: [],
      })
      const stale = await service.getWorkbench(teamName)
      const boundary = Date.parse(stale.generatedAt)
      const timestamp = (value: number) => new Date(value).toISOString()
      const createMessages = [
        transcriptToolUse(`${teamName}-create`, 'TeamCreate', {
          team_name: teamName,
        }, timestamp(createdAt - 1)),
        transcriptToolResult(`${teamName}-create`, {
          success: true,
          team_name: teamName,
          lead_agent_id: `team-lead@${teamName}`,
        }, timestamp(createdAt + 1)),
      ]
      transcripts.set(leadSessionId, createMessages)
      await service.markWorkbenchArchiveDeleted(
        teamName,
        leadSessionId,
        stale.team.incarnationId,
      )
      await fs.rm(path.join(tmpDir, 'teams', teamName), { recursive: true, force: true })
      await fs.rm(path.join(tmpDir, 'tasks', teamName), { recursive: true, force: true })
      const before = await service.getWorkbenchForSession(leadSessionId, {
        incarnationId: stale.team.incarnationId,
      })
      const beforeLatest = before!.snapshots.at(-1)!
      expect(beforeLatest.tasks[0]?.status).toBe('pending')

      transcripts.set(leadSessionId, [
        ...createMessages,
        transcriptToolUse(`${teamName}-delete`, 'TeamDelete', {}, timestamp(boundary + 1)),
        transcriptToolResult(`${teamName}-delete`, {
          success: true,
          team_name: teamName,
          taskListSnapshotAt: timestamp(boundary),
          taskListSnapshotRevision: (stale.taskListRevision ?? 0) + 1,
          finalTasks: [{
            id: '1',
            subject: 'Complete before transcript flush',
            description: 'The terminal frame is authoritative',
            owner: 'Worker Agent',
            status: 'completed',
            blocks: [],
            blockedBy: [],
          }],
        }, timestamp(boundary + 2)),
      ])
      if (refreshMode === 'remark') {
        await service.markWorkbenchArchiveDeleted(
          teamName,
          leadSessionId,
          stale.team.incarnationId,
        )
      }
      const enriched = await service.getWorkbenchForSession(leadSessionId, {
        incarnationId: stale.team.incarnationId,
      })
      const enrichedLatest = enriched!.snapshots.at(-1)!
      expect(enrichedLatest).toMatchObject({
        deletedAt: beforeLatest.deletedAt,
        terminalTaskFrameId: `${teamName}-delete`,
        taskListRevision: (stale.taskListRevision ?? 0) + 1,
        tasks: [{ id: '1', owner: 'Worker Agent', status: 'completed' }],
      })
      expect(enriched?.snapshots).toHaveLength(before?.snapshots.length ?? 0)

      const repeated = await service.getWorkbenchForSession(leadSessionId, {
        incarnationId: stale.team.incarnationId,
      })
      expect(repeated?.snapshots).toHaveLength(enriched?.snapshots.length ?? 0)
      expect(repeated?.snapshots.at(-1)).toEqual(enrichedLatest)
    }
  })

  it('captures the archive replay watermark after the locked task read', async () => {
    const teamName = 'workbench-watermark'
    await writeTeamConfig(teamName, makeTeamConfig({ name: teamName }))
    await writeTeamTask(teamName, {
      id: '1',
      subject: 'Race the watcher',
      description: 'A transcript update may land while this read is blocked',
      status: 'pending',
      blocks: [],
      blockedBy: [],
    })
    const listLockPath = path.join(tmpDir, 'tasks', teamName, '.lock')
    await fs.writeFile(listLockPath, '', { flag: 'a' })
    let releaseBarrier: (() => Promise<void>) | undefined = await lockfile.lock(listLockPath)
    try {
      const pendingSnapshot = service.getWorkbench(teamName)
      await new Promise<void>(resolve => setTimeout(resolve, 10))
      const lockReleasedAt = Date.now()
      await releaseBarrier()
      releaseBarrier = undefined
      const snapshot = await pendingSnapshot

      expect(Date.parse(snapshot.generatedAt)).toBeGreaterThanOrEqual(lockReleasedAt)
      expect(snapshot.tasks).toEqual([
        expect.objectContaining({ id: '1', subject: 'Race the watcher' }),
      ])
    } finally {
      await releaseBarrier?.()
    }
  })

  it('serializes a joined watcher snapshot before whole-Team directory cleanup', async () => {
    const teamName = 'workbench-cleanup-race'
    await writeTeamConfig(teamName, makeTeamConfig({ name: teamName }))
    await writeTeamTask(teamName, {
      id: '1',
      subject: 'Keep the final DAG intact',
      description: 'Cleanup must wait until the joined watcher read is archived',
      owner: 'Worker Agent',
      status: 'completed',
      blocks: [],
      blockedBy: [],
    })

    const serviceInternals = service as unknown as {
      readWorkbenchMessages(name: string): Promise<unknown[]>
    }
    const originalReadMessages = serviceInternals.readWorkbenchMessages.bind(service)
    let enteredMessages!: () => void
    let releaseMessages!: () => void
    const messagesEntered = new Promise<void>(resolve => {
      enteredMessages = resolve
    })
    const messagesBarrier = new Promise<void>(resolve => {
      releaseMessages = resolve
    })
    serviceInternals.readWorkbenchMessages = async (name) => {
      enteredMessages()
      await messagesBarrier
      return originalReadMessages(name)
    }

    try {
      const snapshotPromise = service.getWorkbench(teamName)
      await messagesEntered
      let cleanupSettled = false
      const cleanupPromise = cleanupTeamDirectories(teamName).finally(() => {
        cleanupSettled = true
      })
      await new Promise<void>(resolve => setTimeout(resolve, 10))

      expect(cleanupSettled).toBe(false)
      expect(await fs.stat(path.join(tmpDir, 'teams', teamName))).toBeDefined()
      expect(await fs.stat(path.join(tmpDir, 'tasks', teamName))).toBeDefined()

      releaseMessages()
      const snapshot = await snapshotPromise
      expect(snapshot.tasks).toEqual([
        expect.objectContaining({ id: '1', status: 'completed' }),
      ])
      const terminalTasks = await cleanupPromise
      expect(terminalTasks.tasks).toEqual([
        expect.objectContaining({ id: '1', status: 'completed' }),
      ])
      expect(Number.isFinite(Date.parse(terminalTasks.capturedAt))).toBe(true)
      await expect(fs.stat(path.join(tmpDir, 'teams', teamName))).rejects.toThrow()
      await expect(fs.stat(path.join(tmpDir, 'tasks', teamName))).rejects.toThrow()
    } finally {
      serviceInternals.readWorkbenchMessages = originalReadMessages
      releaseMessages()
    }
  })

  it('persists a terminal lifecycle receipt and rejects stale same-name cleanup and writes', async () => {
    const directoryName = 'my-lifecycle-team'
    const canonicalName = 'My Lifecycle Team'
    const leadSessionId = 'lifecycle-receipt-lead'
    const firstIdentity = {
      teamName: canonicalName,
      createdAt: Date.now() - 2_000,
      leadSessionId,
    }
    const firstLifecycle = await beginTaskListLifecycle(
      directoryName,
      firstIdentity,
    )
    await writeTeamConfig(directoryName, makeTeamConfig({
      name: canonicalName,
      createdAt: firstIdentity.createdAt,
      leadSessionId,
    }))
    await resetTaskList(directoryName)
    const created = await createTaskWithCommit(directoryName, {
      subject: 'Persist the graceful-shutdown terminal state',
      description: 'No TeamDelete transcript is required',
      status: 'pending',
      blocks: [],
      blockedBy: [],
    })
    const live = await service.getWorkbench(directoryName)
    await updateTask(directoryName, created.taskId, {
      owner: 'Worker Agent',
      status: 'completed',
    })

    const receipt = await cleanupTeamDirectories(
      canonicalName,
      firstLifecycle,
    )
    expect(receipt).toMatchObject({
      generation: firstLifecycle.generation,
      identity: firstIdentity,
      revision: (live.taskListRevision ?? 0) + 1,
      tasks: [{
        id: created.taskId,
        owner: 'Worker Agent',
        status: 'completed',
      }],
    })
    await service.markWorkbenchArchiveDeleted(
      canonicalName,
      leadSessionId,
      live.team.incarnationId,
    )
    const reopened = await service.getWorkbenchForSession(leadSessionId, {
      incarnationId: live.team.incarnationId,
    })
    expect(reopened?.snapshots.at(-1)).toMatchObject({
      deletedAt: expect.any(String),
      terminalTaskFrameId: receipt.frameId,
      taskListRevision: receipt.revision,
      tasks: [{
        id: created.taskId,
        owner: 'Worker Agent',
        status: 'completed',
      }],
    })

    await expect(
      fs.stat(path.join(tmpDir, 'tasks', directoryName)),
    ).rejects.toThrow()
    expect(await readTaskListSnapshot(directoryName)).toMatchObject({
      revision: receipt.revision,
      tasks: [{ id: created.taskId, status: 'completed' }],
    })
    await expect(
      fs.stat(path.join(tmpDir, 'tasks', directoryName)),
    ).rejects.toThrow()
    await expect(createTaskWithCommit(directoryName, {
      subject: 'Queued after deletion',
      description: 'A deleted Team task directory must stay deleted',
      status: 'pending',
      blocks: [],
      blockedBy: [],
    })).rejects.toThrow('deleted Team lifecycle')
    await expect(
      fs.stat(path.join(tmpDir, 'tasks', directoryName)),
    ).rejects.toThrow()

    const secondIdentity = {
      ...firstIdentity,
      createdAt: firstIdentity.createdAt + 1_000,
    }
    const secondLifecycle = await beginTaskListLifecycle(
      directoryName,
      secondIdentity,
    )
    await writeTeamConfig(directoryName, makeTeamConfig({
      name: canonicalName,
      createdAt: secondIdentity.createdAt,
      leadSessionId,
    }))
    await resetTaskList(directoryName)
    const secondTask = await createTaskWithCommit(directoryName, {
      subject: 'Belongs only to generation two',
      description: 'A late generation-one writer must not enter this list',
      status: 'pending',
      blocks: [],
      blockedBy: [],
    })

    await expect(
      cleanupTeamDirectories(canonicalName, firstLifecycle),
    ).rejects.toThrow(/changed/)
    expect(await readTaskListSnapshot(directoryName)).toMatchObject({
      revision: 1,
      tasks: [{
        id: secondTask.taskId,
        subject: 'Belongs only to generation two',
      }],
    })
    expect(secondLifecycle.generation).toBe(firstLifecycle.generation + 1)
  })

  it('keeps Team lifecycle cleanup canonical under a standalone task-list override', async () => {
    const directoryName = 'my-override-team'
    const canonicalName = 'My Override Team'
    const leadSessionId = 'override-team-lead'
    const identity = {
      teamName: canonicalName,
      createdAt: Date.now(),
      leadSessionId,
    }
    const previousOverride = process.env.CLAUDE_CODE_TASK_LIST_ID
    process.env.CLAUDE_CODE_TASK_LIST_ID = 'unrelated-explicit-list'
    try {
      const lifecycle = await beginTaskListLifecycle(directoryName, identity)
      await writeTeamConfig(directoryName, makeTeamConfig({
        name: canonicalName,
        createdAt: identity.createdAt,
        leadSessionId,
      }))
      await resetTaskList(directoryName)
      const teamTask = await createTaskWithCommit(directoryName, {
        subject: 'Canonical Team task',
        description: 'Must be archived and deleted with this Team',
        status: 'completed',
        blocks: [],
        blockedBy: [],
      })
      await resetTaskList('unrelated-explicit-list')
      const unrelatedTask = await createTaskWithCommit('unrelated-explicit-list', {
        subject: 'Standalone task-list task',
        description: 'Must survive Team cleanup',
        status: 'pending',
        blocks: [],
        blockedBy: [],
      })

      const live = await service.getWorkbench(directoryName)
      expect(live.tasks.map(task => task.id)).toEqual([teamTask.taskId])
      const receipt = await cleanupTeamDirectories(canonicalName, lifecycle)
      expect(receipt.tasks.map(task => task.subject)).toEqual([
        'Canonical Team task',
      ])
      expect(await readTaskListSnapshot('unrelated-explicit-list')).toMatchObject({
        tasks: [{
          id: unrelatedTask.taskId,
          subject: 'Standalone task-list task',
        }],
      })
      await expect(
        fs.stat(path.join(tmpDir, 'tasks', 'unrelated-explicit-list')),
      ).resolves.toBeDefined()

      await service.markWorkbenchArchiveDeleted(
        canonicalName,
        leadSessionId,
        live.team.incarnationId,
      )
      const reopened = await service.getWorkbenchForSession(leadSessionId, {
        incarnationId: live.team.incarnationId,
      })
      expect(reopened?.snapshots.at(-1)).toMatchObject({
        deletedAt: expect.any(String),
        terminalTaskFrameId: receipt.frameId,
        tasks: [{ subject: 'Canonical Team task' }],
      })
    } finally {
      if (previousOverride === undefined) {
        delete process.env.CLAUDE_CODE_TASK_LIST_ID
      } else {
        process.env.CLAUDE_CODE_TASK_LIST_ID = previousOverride
      }
    }
  })

  it('retries runtime and physical cleanup from an already durable terminal receipt', async () => {
    const directoryName = 'retry-terminal-cleanup'
    const canonicalName = 'Retry Terminal Cleanup'
    const worktreePath = path.join(tmpDir, 'runtime-worktrees', 'retry-worker')
    const identity = {
      teamName: canonicalName,
      createdAt: Date.now(),
      leadSessionId: 'retry-terminal-lead',
    }
    const lifecycle = await beginTaskListLifecycle(directoryName, identity)
    const config = makeTeamConfig({
      name: canonicalName,
      createdAt: identity.createdAt,
      leadSessionId: identity.leadSessionId,
    })
    await fs.mkdir(worktreePath, { recursive: true })
    await writeTeamConfig(directoryName, {
      ...config,
      members: config.members.map(member => (
        member.agentId === 'agent-worker'
          ? { ...member, worktreePath }
          : member
      )),
    })
    await resetTaskList(directoryName)
    await createTaskWithCommit(directoryName, {
      subject: 'Terminal task survives the first cleanup attempt',
      description: 'The receipt exists before physical deletion is retried',
      status: 'completed',
      blocks: [],
      blockedBy: [],
    })
    const terminal = await completeTaskListLifecycle(
      directoryName,
      await readTaskListSnapshot(directoryName),
      lifecycle,
    )

    expect(await fs.stat(path.join(tmpDir, 'teams', directoryName))).toBeDefined()
    expect(await fs.stat(path.join(tmpDir, 'tasks', directoryName))).toBeDefined()
    expect(await fs.stat(worktreePath)).toBeDefined()
    const retried = await cleanupTeamDirectories(canonicalName, lifecycle)
    expect(retried.frameId).toBe(terminal.frameId)
    await expect(fs.stat(worktreePath)).rejects.toThrow()
    await expect(
      fs.stat(path.join(tmpDir, 'teams', directoryName)),
    ).rejects.toThrow()
    await expect(
      fs.stat(path.join(tmpDir, 'tasks', directoryName)),
    ).rejects.toThrow()
  })

  it('repairs an unobserved graceful terminal receipt after same-name recreation', async () => {
    const directoryName = 'graceful-reopen-team'
    const canonicalName = 'Graceful Reopen Team'
    const leadSessionId = 'graceful-reopen-lead'
    const firstIdentity = {
      teamName: canonicalName,
      createdAt: Date.now() - 1_000,
      leadSessionId,
    }
    const firstLifecycle = await beginTaskListLifecycle(
      directoryName,
      firstIdentity,
    )
    await writeTeamConfig(directoryName, makeTeamConfig({
      name: canonicalName,
      createdAt: firstIdentity.createdAt,
      leadSessionId,
    }))
    await resetTaskList(directoryName)
    const task = await createTaskWithCommit(directoryName, {
      subject: 'Finish before graceful shutdown',
      description: 'The watcher archived this before the final update',
      status: 'pending',
      blocks: [],
      blockedBy: [],
    })
    const live = await service.getWorkbench(directoryName)
    await updateTask(directoryName, task.taskId, {
      owner: 'Worker Agent',
      status: 'completed',
    })
    const terminal = await cleanupTeamDirectories(
      canonicalName,
      firstLifecycle,
    )

    // Recreate the same canonical name before the old lead archive is opened.
    // The current lifecycle is active again, but its retained terminal history
    // must still repair the exact older incarnation.
    const secondIdentity = {
      ...firstIdentity,
      createdAt: firstIdentity.createdAt + 2_000,
    }
    await beginTaskListLifecycle(directoryName, secondIdentity)
    await writeTeamConfig(directoryName, makeTeamConfig({
      name: canonicalName,
      createdAt: secondIdentity.createdAt,
      leadSessionId,
    }))
    await resetTaskList(directoryName)

    service = new TeamService()
    const reopened = await service.getWorkbenchForSession(leadSessionId, {
      incarnationId: live.team.incarnationId,
    })
    expect(reopened?.snapshots.at(-1)).toMatchObject({
      deletedAt: expect.any(String),
      terminalTaskFrameId: terminal.frameId,
      taskListRevision: terminal.revision,
      tasks: [{
        id: task.taskId,
        owner: 'Worker Agent',
        status: 'completed',
      }],
    })
  })

  it('cleans registered session Teams without dropping a recreated lifecycle', async () => {
    const teamName = 'session-cleanup-lifecycle'
    const firstIdentity = {
      teamName,
      createdAt: Date.now() - 1_000,
      leadSessionId: 'session-cleanup-lead',
    }
    const firstLifecycle = await beginTaskListLifecycle(teamName, firstIdentity)
    await writeTeamConfig(teamName, makeTeamConfig({
      name: teamName,
      createdAt: firstIdentity.createdAt,
      leadSessionId: firstIdentity.leadSessionId,
    }))
    await resetTaskList(teamName)
    registerTeamForSessionCleanup(teamName, firstLifecycle)

    const cleanupResource = new AsyncResource('session-team-cleanup')
    let cleanupPromise!: Promise<void>
    let cleanupSettled = false
    let secondLifecycle: Awaited<ReturnType<typeof beginTaskListLifecycle>> | undefined
    try {
      await withTaskListLifecycleLock(teamName, async () => {
        cleanupPromise = cleanupResource.runInAsyncScope(() => (
          cleanupSessionTeams()
        ))
        void cleanupPromise.finally(() => {
          cleanupSettled = true
        })
        await new Promise<void>(resolve => setTimeout(resolve, 10))
        expect(cleanupSettled).toBe(false)

        await cleanupTeamDirectories(teamName, firstLifecycle)
        const secondIdentity = {
          ...firstIdentity,
          createdAt: firstIdentity.createdAt + 2_000,
        }
        secondLifecycle = await beginTaskListLifecycle(teamName, secondIdentity)
        await writeTeamConfig(teamName, makeTeamConfig({
          name: teamName,
          createdAt: secondIdentity.createdAt,
          leadSessionId: secondIdentity.leadSessionId,
        }))
        await resetTaskList(teamName)
        registerTeamForSessionCleanup(teamName, secondLifecycle)
      })
      await cleanupPromise

      expect(getSessionCreatedTeams().get(teamName)).toEqual(secondLifecycle)
      unregisterTeamForSessionCleanup(teamName, firstLifecycle)
      expect(getSessionCreatedTeams().get(teamName)).toEqual(secondLifecycle)
      expect(await fs.stat(path.join(tmpDir, 'teams', teamName))).toBeDefined()
      expect(await fs.stat(path.join(tmpDir, 'tasks', teamName))).toBeDefined()
    } finally {
      getSessionCreatedTeams().delete(teamName)
    }
  })

  it('compare-deletes a fulfilled session cleanup without unregistering its replacement', async () => {
    const firstName = 'fulfilled-session-cleanup-a'
    const barrierName = 'fulfilled-session-cleanup-b'
    const leadSessionId = 'fulfilled-session-cleanup-lead'
    const firstIdentity = {
      teamName: firstName,
      createdAt: Date.now() - 2_000,
      leadSessionId,
    }
    const barrierIdentity = {
      teamName: barrierName,
      createdAt: Date.now() - 1_000,
      leadSessionId,
    }
    const firstLifecycle = await beginTaskListLifecycle(firstName, firstIdentity)
    const barrierLifecycle = await beginTaskListLifecycle(
      barrierName,
      barrierIdentity,
    )
    await writeTeamConfig(firstName, makeTeamConfig({
      name: firstName,
      createdAt: firstIdentity.createdAt,
      leadSessionId,
    }))
    await writeTeamConfig(barrierName, makeTeamConfig({
      name: barrierName,
      createdAt: barrierIdentity.createdAt,
      leadSessionId,
    }))
    await resetTaskList(firstName)
    await resetTaskList(barrierName)
    registerTeamForSessionCleanup(firstName, firstLifecycle)
    registerTeamForSessionCleanup(barrierName, barrierLifecycle)

    const cleanupResource = new AsyncResource('fulfilled-session-cleanup')
    let cleanupPromise!: Promise<void>
    let replacement: Awaited<ReturnType<typeof beginTaskListLifecycle>> | undefined
    try {
      await withTaskListLifecycleLock(barrierName, async () => {
        cleanupPromise = cleanupResource.runInAsyncScope(() => (
          cleanupSessionTeams()
        ))

        let firstDeleted = false
        for (let attempt = 0; attempt < 100; attempt++) {
          firstDeleted = (await readTaskListLifecycleState(firstName)).deleted
          if (firstDeleted) break
          await new Promise<void>(resolve => setTimeout(resolve, 5))
        }
        expect(firstDeleted).toBe(true)

        const replacementIdentity = {
          ...firstIdentity,
          createdAt: firstIdentity.createdAt + 4_000,
        }
        replacement = await beginTaskListLifecycle(
          firstName,
          replacementIdentity,
        )
        await writeTeamConfig(firstName, makeTeamConfig({
          name: firstName,
          createdAt: replacementIdentity.createdAt,
          leadSessionId,
        }))
        await resetTaskList(firstName)
        registerTeamForSessionCleanup(firstName, replacement)
      })
      await cleanupPromise

      expect(getSessionCreatedTeams().get(firstName)).toEqual(replacement)
      expect(getSessionCreatedTeams().has(barrierName)).toBe(false)
      expect(await fs.stat(path.join(tmpDir, 'teams', firstName))).toBeDefined()
      expect(await fs.stat(path.join(tmpDir, 'tasks', firstName))).toBeDefined()
    } finally {
      getSessionCreatedTeams().delete(firstName)
      getSessionCreatedTeams().delete(barrierName)
    }
  })

  it('rejects a real TaskCreate queued across cleanup and same-name recreation', async () => {
    const teamName = 'queued-lifecycle-writer'
    const leadSessionId = 'queued-lifecycle-writer-lead'
    const firstIdentity = {
      teamName,
      createdAt: Date.now() - 2_000,
      leadSessionId,
    }
    const firstLifecycle = await beginTaskListLifecycle(teamName, firstIdentity)
    await writeTeamConfig(teamName, makeTeamConfig({
      name: teamName,
      createdAt: firstIdentity.createdAt,
      leadSessionId,
    }))
    await resetTaskList(teamName)

    const writerResource = new AsyncResource('queued-task-writer')
    let queuedWriter!: Promise<unknown>
    let writerSettled = false
    let secondTaskId = ''
    try {
      await withTaskListLifecycleLock(teamName, async () => {
        queuedWriter = writerResource.runInAsyncScope(() => (
          createTaskWithCommit(teamName, {
            subject: 'Old generation queued writer',
            description: 'Must not enter the recreated Team',
            status: 'pending',
            blocks: [],
            blockedBy: [],
          })
        ))
        void queuedWriter.finally(() => {
          writerSettled = true
        }).catch(() => {})
        await new Promise<void>(resolve => setTimeout(resolve, 10))
        expect(writerSettled).toBe(false)

        await cleanupTeamDirectories(teamName, firstLifecycle)
        const secondIdentity = {
          ...firstIdentity,
          createdAt: firstIdentity.createdAt + 1_000,
        }
        await beginTaskListLifecycle(teamName, secondIdentity)
        await writeTeamConfig(teamName, makeTeamConfig({
          name: teamName,
          createdAt: secondIdentity.createdAt,
          leadSessionId,
        }))
        await resetTaskList(teamName)
        secondTaskId = (await createTaskWithCommit(teamName, {
          subject: 'Only generation-two task',
          description: 'The old queued writer must leave this list untouched',
          status: 'pending',
          blocks: [],
          blockedBy: [],
        })).taskId
      })

      await expect(queuedWriter).rejects.toThrow(
        'lifecycle changed while waiting for the lock',
      )
      expect(await readTaskListSnapshot(teamName)).toMatchObject({
        revision: 1,
        tasks: [{
          id: secondTaskId,
          subject: 'Only generation-two task',
        }],
      })

      // The positive direction stays live: a writer that starts in generation
      // two commits normally and advances only that generation's revision.
      await createTaskWithCommit(teamName, {
        subject: 'Active generation-two writer',
        description: 'Must still be accepted',
        status: 'pending',
        blocks: [],
        blockedBy: [],
      })
      const activeSnapshot = await readTaskListSnapshot(teamName)
      expect(activeSnapshot.tasks).toHaveLength(2)
      expect(activeSnapshot).toMatchObject({
        revision: 2,
        tasks: expect.arrayContaining([
          expect.objectContaining({ id: '1', subject: 'Only generation-two task' }),
          expect.objectContaining({ id: '2', subject: 'Active generation-two writer' }),
        ]),
      })
    } finally {
      writerResource.emitDestroy()
      await queuedWriter?.catch(() => {})
    }
  })

  it('does not let an older concurrent workbench write replace a newer archive frame', async () => {
    const teamName = 'archive-arrival-order'
    const leadSessionId = 'archive-arrival-order-lead'
    await writeTeamConfig(teamName, makeTeamConfig({ name: teamName, leadSessionId }))
    await writeTeamTask(teamName, {
      id: '1',
      subject: 'Keep the newest archive state',
      description: 'An older request may finish after a newer request',
      status: 'pending',
      blocks: [],
      blockedBy: [],
    })

    const base = await service.getWorkbench(teamName)
    const baseAt = Date.parse(base.generatedAt)
    const older: TeamWorkbenchSnapshot = {
      ...base,
      version: 'arrival-order-older',
      generatedAt: new Date(baseAt + 10).toISOString(),
      taskListRevision: (base.taskListRevision ?? 0) + 1,
      tasks: base.tasks.map(task => ({ ...task, status: 'pending' })),
    }
    const newer: TeamWorkbenchSnapshot = {
      ...base,
      version: 'arrival-order-newer',
      generatedAt: new Date(baseAt + 10).toISOString(),
      taskListRevision: (base.taskListRevision ?? 0) + 2,
      tasks: base.tasks.map(task => ({ ...task, status: 'completed' })),
    }

    await service.archiveWorkbenchSnapshot(newer)
    await service.archiveWorkbenchSnapshot(older)
    await fs.rm(path.join(tmpDir, 'teams', teamName), { recursive: true, force: true })
    await fs.rm(path.join(tmpDir, 'tasks', teamName), { recursive: true, force: true })

    const reopened = await service.getWorkbenchForSession(leadSessionId, {
      incarnationId: base.team.incarnationId,
    })
    expect(reopened?.snapshots.at(-1)).toMatchObject({
      version: 'arrival-order-newer',
      generatedAt: newer.generatedAt,
      tasks: [{ id: '1', status: 'completed' }],
    })
  })

  it('tombstones the newest archive frame and rejects late live resurrection', async () => {
    const teamName = 'archive-tombstone-race'
    const leadSessionId = 'archive-tombstone-race-lead'
    await writeTeamConfig(teamName, makeTeamConfig({ name: teamName, leadSessionId }))
    await writeTeamTask(teamName, {
      id: '1',
      subject: 'Preserve the final state through deletion',
      description: 'The tombstone must re-read the archive under its write lock',
      status: 'pending',
      blocks: [],
      blockedBy: [],
    })
    const base = await service.getWorkbench(teamName)

    let readerEntered!: () => void
    let releaseReader!: () => void
    const entered = new Promise<void>(resolve => {
      readerEntered = resolve
    })
    const readerBarrier = new Promise<void>(resolve => {
      releaseReader = resolve
    })
    service = new TeamService({
      sessionReader: {
        getSessionMessages: async () => {
          readerEntered()
          await readerBarrier
          return []
        },
      },
    })

    const tombstonePromise = service.markWorkbenchArchiveDeleted(
      teamName,
      leadSessionId,
      base.team.incarnationId,
    )
    await entered
    await new Promise<void>(resolve => setTimeout(resolve, 2))
    const newest: TeamWorkbenchSnapshot = {
      ...base,
      version: 'tombstone-race-newest',
      generatedAt: new Date().toISOString(),
      tasks: base.tasks.map(task => ({ ...task, status: 'completed' })),
    }
    await service.archiveWorkbenchSnapshot(newest)
    releaseReader()
    await tombstonePromise

    const lateLive: TeamWorkbenchSnapshot = {
      ...base,
      version: 'tombstone-race-late-live',
      generatedAt: new Date(Date.now() + 1_000).toISOString(),
      tasks: base.tasks.map(task => ({ ...task, status: 'pending' })),
    }
    await service.archiveWorkbenchSnapshot(lateLive)
    await fs.rm(path.join(tmpDir, 'teams', teamName), { recursive: true, force: true })
    await fs.rm(path.join(tmpDir, 'tasks', teamName), { recursive: true, force: true })

    const reopened = await service.getWorkbenchForSession(leadSessionId, {
      incarnationId: base.team.incarnationId,
    })
    expect(reopened?.snapshots.at(-1)).toMatchObject({
      deletedAt: expect.any(String),
      tasks: [{ id: '1', status: 'completed' }],
    })
    expect(reopened?.snapshots.at(-1)?.version).not.toBe('tombstone-race-late-live')
  })

  it('does not let an older TaskList result roll a newer disk snapshot backward', async () => {
    const teamName = 'stale-task-list-tail'
    const leadSessionId = 'stale-task-list-lead'
    const createdAt = Date.now() - 1_000
    let transcript: MessageEntry[] = []
    service = new TeamService({
      sessionReader: { getSessionMessages: async () => transcript },
    })
    await writeTeamConfig(teamName, makeTeamConfig({
      name: teamName,
      leadSessionId,
      createdAt,
    }))
    await writeTeamTask(teamName, {
      id: '1',
      subject: 'Keep the newer terminal state',
      description: 'The disk snapshot already includes teammate completion',
      owner: 'worker',
      status: 'completed',
      blocks: [],
      blockedBy: [],
    })

    const firstSnapshot = await service.getWorkbench(teamName)
    await new Promise<void>(resolve => setTimeout(resolve, 10))
    const snapshot = await service.getWorkbench(teamName)
    expect(snapshot.version).toBe(firstSnapshot.version)
    expect(Date.parse(snapshot.generatedAt)).toBeGreaterThan(
      Date.parse(firstSnapshot.generatedAt),
    )
    const boundary = Date.parse(snapshot.generatedAt)
    const previousBoundary = Date.parse(firstSnapshot.generatedAt)
    const timestamp = (value: number) => new Date(value).toISOString()
    transcript = [
      transcriptToolUse('stale-list-team-create', 'TeamCreate', {
        team_name: teamName,
      }, timestamp(createdAt - 1)),
      transcriptToolResult('stale-list-team-create', {
        success: true,
        team_name: teamName,
        lead_agent_id: `team-lead@${teamName}`,
      }, timestamp(createdAt + 1)),
      // This read started before the locked disk snapshot, but its result was
      // streamed afterward. It cannot overwrite the completed disk state.
      transcriptToolUse('stale-list', 'TaskList', {}, timestamp(previousBoundary + 1)),
      transcriptToolResult('stale-list', {
        tasks: [{
          id: '1',
          subject: 'Keep the newer terminal state',
          owner: 'worker',
          status: 'pending',
        }],
      }, timestamp(boundary + 5)),
    ]

    await fs.rm(path.join(tmpDir, 'teams', teamName), { recursive: true, force: true })
    await fs.rm(path.join(tmpDir, 'tasks', teamName), { recursive: true, force: true })
    await service.markWorkbenchArchiveDeleted(
      teamName,
      leadSessionId,
      snapshot.team.incarnationId,
    )

    const reopened = await service.getWorkbenchForSession(leadSessionId)
    expect(reopened?.snapshots.at(-1)?.tasks).toEqual([
      expect.objectContaining({
        id: '1',
        owner: 'worker',
        status: 'completed',
      }),
    ])
  })

  it('lets a causally newer full TaskList clear an archived stale owner', async () => {
    const teamName = 'ownerless-task-list-tail'
    const leadSessionId = 'ownerless-task-list-lead'
    const createdAt = Date.now() - 1_000
    let transcript: MessageEntry[] = []
    service = new TeamService({
      sessionReader: { getSessionMessages: async () => transcript },
    })
    await writeTeamConfig(teamName, makeTeamConfig({
      name: teamName,
      leadSessionId,
      createdAt,
    }))
    await writeTeamTask(teamName, {
      id: '1',
      subject: 'Return to the unclaimed pool',
      description: 'The final full list intentionally omits owner',
      owner: 'exited-worker',
      status: 'in_progress',
      blocks: [],
      blockedBy: [],
    })

    const snapshot = await service.getWorkbench(teamName)
    const boundary = Date.parse(snapshot.generatedAt)
    const timestamp = (value: number) => new Date(value).toISOString()
    transcript = [
      transcriptToolUse('ownerless-team-create', 'TeamCreate', {
        team_name: teamName,
      }, timestamp(createdAt - 1)),
      transcriptToolResult('ownerless-team-create', {
        success: true,
        team_name: teamName,
        lead_agent_id: `team-lead@${teamName}`,
      }, timestamp(createdAt + 1)),
      transcriptToolUse('ownerless-list', 'TaskList', {}, timestamp(boundary + 5)),
      transcriptToolResult('ownerless-list', {
        tasks: [{
          id: '1',
          subject: 'Return to the unclaimed pool',
          status: 'pending',
        }],
      }, timestamp(boundary + 6)),
    ]

    await fs.rm(path.join(tmpDir, 'teams', teamName), { recursive: true, force: true })
    await fs.rm(path.join(tmpDir, 'tasks', teamName), { recursive: true, force: true })
    await service.markWorkbenchArchiveDeleted(
      teamName,
      leadSessionId,
      snapshot.team.incarnationId,
    )

    const reopened = await service.getWorkbenchForSession(leadSessionId)
    expect(reopened?.snapshots.at(-1)?.tasks).toEqual([
      expect.objectContaining({ id: '1', status: 'pending' }),
    ])
    expect(reopened?.snapshots.at(-1)?.tasks[0]?.owner).toBeUndefined()
  })

  it('rebuilds archived dependency edges from a legacy blockedBy-only TaskList', async () => {
    const teamName = 'legacy-task-list-edges'
    const leadSessionId = 'legacy-task-list-edges-lead'
    const createdAt = Date.now() - 1_000
    let transcript: MessageEntry[] = []
    service = new TeamService({
      sessionReader: { getSessionMessages: async () => transcript },
    })
    await writeTeamConfig(teamName, makeTeamConfig({
      name: teamName,
      leadSessionId,
      createdAt,
    }))
    await writeTeamTask(teamName, {
      id: '1',
      subject: 'Release the dependent task',
      description: 'The archived forward edge is stale',
      status: 'pending',
      blocks: ['2'],
      blockedBy: [],
    })
    await writeTeamTask(teamName, {
      id: '2',
      subject: 'Continue after the blocker finishes',
      description: 'The legacy TaskList has the authoritative reverse edge',
      status: 'pending',
      blocks: [],
      blockedBy: ['1'],
    })

    const snapshot = await service.getWorkbench(teamName)
    expect(snapshot.tasks).toEqual([
      expect.objectContaining({ id: '1', blocks: ['2'] }),
      expect.objectContaining({ id: '2', blockedBy: ['1'] }),
    ])
    const boundary = Date.parse(snapshot.generatedAt)
    const timestamp = (value: number) => new Date(value).toISOString()
    transcript = [
      transcriptToolUse('legacy-edges-team-create', 'TeamCreate', {
        team_name: teamName,
      }, timestamp(createdAt - 1)),
      transcriptToolResult('legacy-edges-team-create', {
        success: true,
        team_name: teamName,
        lead_agent_id: `team-lead@${teamName}`,
      }, timestamp(createdAt + 1)),
      // Legacy TaskList results have no causal marker and serialize only the
      // reverse dependency side. Both timestamps are after the disk boundary,
      // so this successful full list is the authoritative transition.
      transcriptToolUse('legacy-edges-list', 'TaskList', {}, timestamp(boundary + 5)),
      transcriptToolResult('legacy-edges-list', {
        success: true,
        tasks: [{
          id: '1',
          subject: 'Release the dependent task',
          status: 'completed',
          blockedBy: [],
        }, {
          id: '2',
          subject: 'Continue after the blocker finishes',
          status: 'pending',
          blockedBy: [],
        }],
      }, timestamp(boundary + 6)),
    ]

    await fs.rm(path.join(tmpDir, 'teams', teamName), { recursive: true, force: true })
    await fs.rm(path.join(tmpDir, 'tasks', teamName), { recursive: true, force: true })
    await service.markWorkbenchArchiveDeleted(
      teamName,
      leadSessionId,
      snapshot.team.incarnationId,
    )

    const reopened = await service.getWorkbenchForSession(leadSessionId, {
      incarnationId: snapshot.team.incarnationId,
    })
    expect(reopened?.snapshots.at(-1)?.tasks.map(task => ({
      id: task.id,
      blocks: task.blocks,
      blockedBy: task.blockedBy,
    }))).toEqual([{
      id: '1',
      blocks: [],
      blockedBy: [],
    }, {
      id: '2',
      blocks: [],
      blockedBy: [],
    }])
  })

  it('orders transcript tail repair by locked task-list causality', async () => {
    const teamName = 'causal-task-tail'
    const leadSessionId = 'causal-task-tail-lead'
    const createdAt = Date.now() - 1_000
    let transcript: MessageEntry[] = []
    service = new TeamService({
      sessionReader: { getSessionMessages: async () => transcript },
    })
    await writeTeamConfig(teamName, makeTeamConfig({
      name: teamName,
      leadSessionId,
      createdAt,
    }))
    await writeTeamTask(teamName, {
      id: '1',
      subject: 'Apply the actual commit order',
      description: 'Tool-use order is not task-list commit order',
      status: 'pending',
      blocks: [],
      blockedBy: [],
    })

    const snapshot = await service.getWorkbench(teamName)
    const boundary = Date.parse(snapshot.generatedAt)
    const timestamp = (value: number) => new Date(value).toISOString()
    transcript = [
      transcriptToolUse('causal-team-create', 'TeamCreate', {
        team_name: teamName,
      }, timestamp(createdAt - 1)),
      transcriptToolResult('causal-team-create', {
        success: true,
        team_name: teamName,
        lead_agent_id: `team-lead@${teamName}`,
      }, timestamp(createdAt + 1)),
      // The mutation was invoked first but committed after the intervening
      // full-list read. Replay must use the lock markers, not tool-use order.
      transcriptToolUse('late-completion', 'TaskUpdate', {
        taskId: '1',
        status: 'completed',
      }, timestamp(boundary + 1)),
      transcriptToolUse('earlier-list-read', 'TaskList', {}, timestamp(boundary + 2)),
      transcriptToolResult('earlier-list-read', {
        success: true,
        taskListSnapshotAt: timestamp(boundary),
        taskListSnapshotRevision: (snapshot.taskListRevision ?? 0) + 1,
        tasks: [{
          id: '1',
          subject: 'Apply the actual commit order',
          status: 'pending',
        }],
      }, timestamp(boundary + 8)),
      transcriptToolResult('late-completion', {
        success: true,
        taskListMutationAt: timestamp(boundary),
        taskListMutationRevision: (snapshot.taskListRevision ?? 0) + 2,
      }, timestamp(boundary + 11)),
    ]

    await fs.rm(path.join(tmpDir, 'teams', teamName), { recursive: true, force: true })
    await fs.rm(path.join(tmpDir, 'tasks', teamName), { recursive: true, force: true })
    await service.markWorkbenchArchiveDeleted(
      teamName,
      leadSessionId,
      snapshot.team.incarnationId,
    )

    const reopened = await service.getWorkbenchForSession(leadSessionId)
    expect(reopened?.snapshots.at(-1)?.tasks).toEqual([
      expect.objectContaining({ id: '1', status: 'completed' }),
    ])
    expect(reopened?.snapshots.at(-1)?.taskListRevision).toBe(
      (snapshot.taskListRevision ?? 0) + 2,
    )
  })

  it('keeps a locked snapshot over an ambiguous cross-boundary TaskUpdate', async () => {
    const teamName = 'ambiguous-task-update-tail'
    const leadSessionId = 'ambiguous-task-update-lead'
    const createdAt = Date.now() - 1_000
    let transcript: MessageEntry[] = []
    service = new TeamService({
      sessionReader: { getSessionMessages: async () => transcript },
    })
    await writeTeamConfig(teamName, makeTeamConfig({
      name: teamName,
      leadSessionId,
      createdAt,
    }))
    await writeTeamTask(teamName, {
      id: '1',
      subject: 'Do not regress the locked terminal state',
      description: 'A legacy result timestamp is not its commit timestamp',
      owner: 'worker',
      status: 'completed',
      blocks: [],
      blockedBy: [],
    })

    const snapshot = await service.getWorkbench(teamName)
    const boundary = Date.parse(snapshot.generatedAt)
    const timestamp = (value: number) => new Date(value).toISOString()
    transcript = [
      transcriptToolUse('ambiguous-team-create', 'TeamCreate', {
        team_name: teamName,
      }, timestamp(createdAt - 1)),
      transcriptToolResult('ambiguous-team-create', {
        success: true,
        team_name: teamName,
        lead_agent_id: `team-lead@${teamName}`,
      }, timestamp(createdAt + 1)),
      transcriptToolUse('ambiguous-update', 'TaskUpdate', {
        taskId: '1',
        status: 'in_progress',
      }, timestamp(boundary - 5)),
      transcriptToolResult('ambiguous-update', {
        success: true,
      }, timestamp(boundary + 5)),
    ]

    await fs.rm(path.join(tmpDir, 'teams', teamName), { recursive: true, force: true })
    await fs.rm(path.join(tmpDir, 'tasks', teamName), { recursive: true, force: true })
    await service.markWorkbenchArchiveDeleted(
      teamName,
      leadSessionId,
      snapshot.team.incarnationId,
    )

    const reopened = await service.getWorkbenchForSession(leadSessionId)
    expect(reopened?.snapshots.at(-1)?.tasks).toEqual([
      expect.objectContaining({ id: '1', status: 'completed' }),
    ])
  })

  it('uses a causally newer empty TaskList to remove archived ghost tasks', async () => {
    const teamName = 'empty-task-list-tail'
    const leadSessionId = 'empty-task-list-lead'
    const createdAt = Date.now() - 1_000
    let transcript: MessageEntry[] = []
    service = new TeamService({
      sessionReader: { getSessionMessages: async () => transcript },
    })
    await writeTeamConfig(teamName, makeTeamConfig({
      name: teamName,
      leadSessionId,
      createdAt,
    }))
    await writeTeamTask(teamName, {
      id: '1',
      subject: 'Disappear from the terminal full list',
      description: 'The mutation result may be missing in a legacy transcript',
      status: 'pending',
      blocks: [],
      blockedBy: [],
    })

    const snapshot = await service.getWorkbench(teamName)
    const boundary = Date.parse(snapshot.generatedAt)
    const timestamp = (value: number) => new Date(value).toISOString()
    transcript = [
      transcriptToolUse('empty-list-team-create', 'TeamCreate', {
        team_name: teamName,
      }, timestamp(createdAt - 1)),
      transcriptToolResult('empty-list-team-create', {
        success: true,
        team_name: teamName,
        lead_agent_id: `team-lead@${teamName}`,
      }, timestamp(createdAt + 1)),
      transcriptToolUse('empty-list', 'TaskList', {}, timestamp(boundary + 1)),
      transcriptToolResult('empty-list', {
        success: true,
        taskListSnapshotAt: timestamp(boundary + 2),
        tasks: [],
      }, timestamp(boundary + 3)),
    ]

    await fs.rm(path.join(tmpDir, 'teams', teamName), { recursive: true, force: true })
    await fs.rm(path.join(tmpDir, 'tasks', teamName), { recursive: true, force: true })
    await service.markWorkbenchArchiveDeleted(
      teamName,
      leadSessionId,
      snapshot.team.incarnationId,
    )

    const reopened = await service.getWorkbenchForSession(leadSessionId)
    expect(reopened?.snapshots.at(-1)?.tasks).toEqual([])
  })

  it('carries exited members through roster removal so completed owners and transcripts stay attributable', async () => {
    const leadSessionId = 'shrinking-roster-lead'
    const initialConfig = makeTeamConfig({
      name: 'shrinking-roster',
      leadSessionId,
      members: [
        ...(makeTeamConfig().members as Array<Record<string, unknown>>),
        {
          agentId: 'agent-observer',
          name: 'Observer Agent',
          agentType: 'observer',
          joinedAt: 1700000002000,
          cwd: '/tmp/project',
          isActive: false,
        },
      ],
    })
    await writeTeamConfig('shrinking-roster', initialConfig)
    await writeTeamTask('shrinking-roster', {
      id: '1',
      subject: 'Finish the owned task',
      description: 'Keep the attribution after shutdown removes the teammate',
      owner: 'Worker Agent',
      status: 'completed',
      blocks: [],
      blockedBy: [],
    })
    await writeTranscriptFile('-tmp-project', 'session-worker-001', [{
      type: 'assistant',
      uuid: 'worker-before-roster-removal',
      teamName: 'shrinking-roster',
      agentName: 'Worker Agent',
      message: { role: 'assistant', content: 'Finished before shutdown' },
      timestamp: '2024-01-01T00:00:00.000Z',
    }])

    const beforeRemoval = await service.getWorkbench('shrinking-roster')
    expect(beforeRemoval.team.members.map(member => member.name)).toEqual([
      'Lead Agent',
      'Worker Agent',
      'Observer Agent',
    ])

    await writeTeamConfig('shrinking-roster', {
      ...initialConfig,
      members: [
        (initialConfig.members as Array<Record<string, unknown>>)[0],
        (initialConfig.members as Array<Record<string, unknown>>)[2],
      ],
    })
    const afterRemoval = await service.getWorkbench('shrinking-roster')
    expect(afterRemoval.team.members.map(member => member.name)).toEqual([
      'Lead Agent',
      'Observer Agent',
    ])

    // The mutable team directory still exists during shutdown, but the member
    // has already left its live roster. Transcript lookup must fall back to the
    // archive in this intermediate state rather than waiting for TeamDelete.
    const liveShrinkingTranscript = await service.getMemberTranscriptPage(
      'shrinking-roster',
      'agent-worker',
      {
        leadSessionId,
        incarnationId: beforeRemoval.team.incarnationId,
      },
    )
    expect(liveShrinkingTranscript.messages.map(message => message.id)).toEqual([
      'worker-before-roster-removal',
    ])

    await service.markWorkbenchArchiveDeleted(
      'shrinking-roster',
      leadSessionId,
      beforeRemoval.team.incarnationId,
    )
    const archivePath = path.join(
      tmpDir,
      'cc-haha',
      'agent-teams',
      `${crypto.createHash('sha256').update(leadSessionId).digest('hex')}.json`,
    )
    const archive = JSON.parse(await fs.readFile(archivePath, 'utf8')) as {
      teams: Array<{ snapshots: TeamWorkbenchSnapshot[] }>
    }
    expect(archive.teams[0]?.snapshots.at(-1)?.team.members.map(member => member.name)).toContain(
      'Worker Agent',
    )

    // Recreate the pre-fix persisted transition: early snapshots know the
    // worker, but shutdown removes it from every later roster while its task
    // keeps the durable owner string.
    archive.teams[0]!.snapshots = archive.teams[0]!.snapshots.map((snapshot, index) => (
      index === 0
        ? snapshot
        : {
            ...snapshot,
            team: {
              ...snapshot.team,
              memberCount: snapshot.team.memberCount - 1,
              members: snapshot.team.members.filter(member => member.name !== 'Worker Agent'),
            },
          }
    ))
    const orphanedVersion = archive.teams[0]!.snapshots.at(-1)!.version
    await fs.writeFile(archivePath, JSON.stringify(archive), 'utf8')
    await fs.rm(path.join(tmpDir, 'teams', 'shrinking-roster'), { recursive: true, force: true })
    await fs.rm(path.join(tmpDir, 'tasks', 'shrinking-roster'), { recursive: true, force: true })

    const timeline = await service.getWorkbenchForSession(leadSessionId)
    const completed = timeline?.snapshots.at(-1)
    expect(completed?.team.members.map(member => ({
      name: member.name,
      status: member.status,
    }))).toEqual([
      { name: 'Lead Agent', status: 'completed' },
      { name: 'Worker Agent', status: 'completed' },
      { name: 'Observer Agent', status: 'completed' },
    ])
    expect(completed?.team.memberCount).toBe(3)
    expect(completed?.version).not.toBe(orphanedVersion)
    expect(completed?.tasks[0]).toMatchObject({
      status: 'completed',
      owner: 'Worker Agent',
    })

    const transcript = await service.getMemberTranscriptPage(
      'shrinking-roster',
      'agent-worker',
      {
        leadSessionId,
        incarnationId: beforeRemoval.team.incarnationId,
      },
    )
    expect(transcript.messages.map(message => message.id)).toEqual([
      'worker-before-roster-removal',
    ])

    const reopenedAgain = await service.getWorkbenchForSession(leadSessionId)
    expect(reopenedAgain?.snapshots.at(-1)).toEqual(completed)
  })

  it('keeps same-name incarnations separate when an old delete arrives late', async () => {
    const oldConfig = makeTeamConfig({
      name: 'recreated-team',
      createdAt: 1700000000000,
      leadSessionId: 'shared-lead-session',
    })
    await writeTeamConfig('recreated-team', oldConfig)
    const oldSnapshot = await service.getWorkbench('recreated-team')

    const newConfig = makeTeamConfig({
      name: 'recreated-team',
      createdAt: 1800000000000,
      leadSessionId: 'shared-lead-session',
    })
    await writeTeamConfig('recreated-team', newConfig)
    const newSnapshot = await service.getWorkbench('recreated-team')

    await service.markWorkbenchArchiveDeleted(
      'recreated-team',
      'shared-lead-session',
      oldSnapshot.team.incarnationId,
    )

    const live = await service.getWorkbenchForSession('shared-lead-session')
    expect(live).toMatchObject({
      source: 'live',
      incarnationId: newSnapshot.team.incarnationId,
    })
    expect(live?.snapshots.every((snapshot) => (
      snapshot.team.incarnationId === newSnapshot.team.incarnationId && !snapshot.deletedAt
    ))).toBe(true)

    const oldActivity = await service.getWorkbenchForSession('shared-lead-session', {
      teamName: 'recreated-team',
      at: 1700000001000,
    })
    const newActivity = await service.getWorkbenchForSession('shared-lead-session', {
      teamName: 'recreated-team',
      at: 1800000001000,
    })
    expect(oldActivity).toMatchObject({
      source: 'archive',
      incarnationId: oldSnapshot.team.incarnationId,
    })
    expect(oldActivity?.snapshots.at(-1)?.deletedAt).toBeDefined()
    expect(newActivity).toMatchObject({
      source: 'live',
      incarnationId: newSnapshot.team.incarnationId,
    })

    await fs.rm(path.join(tmpDir, 'teams', 'recreated-team'), { recursive: true, force: true })
    const archived = await service.getWorkbenchForSession('shared-lead-session')
    expect(archived).toMatchObject({
      source: 'archive',
      incarnationId: newSnapshot.team.incarnationId,
    })
  })

  it('splits a legacy archive entry that merged same-name incarnations', async () => {
    const sessionId = 'legacy-merged-lead'
    await writeTeamConfig('legacy-merged-team', makeTeamConfig({
      name: 'legacy-merged-team',
      createdAt: 1700000000000,
      leadSessionId: sessionId,
    }))
    const oldSnapshot = await service.getWorkbench('legacy-merged-team')
    await writeTeamConfig('legacy-merged-team', makeTeamConfig({
      name: 'legacy-merged-team',
      createdAt: 1800000000000,
      leadSessionId: sessionId,
    }))
    const newSnapshot = await service.getWorkbench('legacy-merged-team')
    const withoutIncarnation = (snapshot: typeof oldSnapshot) => {
      const { incarnationId: _incarnationId, ...legacyTeam } = snapshot.team
      return { ...snapshot, team: legacyTeam }
    }
    const archivePath = path.join(
      tmpDir,
      'cc-haha',
      'agent-teams',
      `${crypto.createHash('sha256').update(sessionId).digest('hex')}.json`,
    )
    await fs.writeFile(archivePath, JSON.stringify({
      schemaVersion: 1,
      sessionId,
      updatedAt: newSnapshot.generatedAt,
      teams: [{
        teamName: 'legacy-merged-team',
        updatedAt: newSnapshot.generatedAt,
        snapshots: [
          withoutIncarnation(oldSnapshot),
          withoutIncarnation(newSnapshot),
        ],
      }],
    }))
    await fs.rm(path.join(tmpDir, 'teams', 'legacy-merged-team'), {
      recursive: true,
      force: true,
    })

    const migrated = await service.getWorkbenchForSession(sessionId)

    expect(migrated?.incarnationId).toBe(newSnapshot.team.incarnationId)
    expect(migrated?.snapshots.map((snapshot) => snapshot.version)).toEqual([
      newSnapshot.version,
    ])
  })

  it('does not merge same-name teammate transcripts across incarnations', async () => {
    const oldCreatedAt = Date.parse('2026-08-01T00:00:00.000Z')
    const newCreatedAt = Date.parse('2026-08-05T00:00:00.000Z')
    const member = {
      agentId: 'reviewer@reused-name',
      name: 'reviewer',
      agentType: 'reviewer',
      joinedAt: oldCreatedAt,
      cwd: '/tmp/project',
      isActive: false,
    }
    const oldConfig = makeTeamConfig({
      name: 'reused-name',
      createdAt: oldCreatedAt,
      leadSessionId: 'shared-transcript-lead',
      members: [member],
    })
    await writeTeamConfig('reused-name', oldConfig)
    await writeTranscriptFile('-tmp-project', 'old-reviewer-session', [{
      type: 'assistant',
      uuid: 'old-incarnation-message',
      teamName: 'reused-name',
      agentName: 'reviewer',
      message: { role: 'assistant', content: 'old incarnation' },
      timestamp: '2026-08-02T00:00:00.000Z',
    }])
    const oldSnapshot = await service.getWorkbench('reused-name')
    await service.markWorkbenchArchiveDeleted(
      'reused-name',
      'shared-transcript-lead',
      oldSnapshot.team.incarnationId,
    )

    const newConfig = {
      ...oldConfig,
      createdAt: newCreatedAt,
      members: [{ ...member, joinedAt: newCreatedAt }],
    }
    await writeTeamConfig('reused-name', newConfig)
    await writeTranscriptFile('-tmp-project', 'new-reviewer-session', [{
      type: 'assistant',
      uuid: 'new-incarnation-message',
      teamName: 'reused-name',
      agentName: 'reviewer',
      message: { role: 'assistant', content: 'new incarnation' },
      timestamp: '2026-08-06T00:00:00.000Z',
    }])
    const newSnapshot = await service.getWorkbench('reused-name')

    const current = await service.getMemberTranscriptPage(
      'reused-name',
      'reviewer@reused-name',
      {
        leadSessionId: 'shared-transcript-lead',
        incarnationId: newSnapshot.team.incarnationId,
      },
    )
    expect(current.messages.map((message) => message.id)).toEqual([
      'new-incarnation-message',
    ])

    const archived = await service.getMemberTranscriptPage(
      'reused-name',
      'reviewer@reused-name',
      {
        leadSessionId: 'shared-transcript-lead',
        incarnationId: teamIncarnationId(oldConfig as ReturnType<typeof makeTeamConfig>),
      },
    )
    expect(archived.messages.map((message) => message.id)).toEqual([
      'old-incarnation-message',
    ])
  })

  it('opens an archived out-of-process teammate execution transcript with tool calls', async () => {
    await writeTeamConfig('archived-execution-team', makeTeamConfig({
      name: 'archived-execution-team',
      leadSessionId: 'archived-execution-lead',
      members: [{
        agentId: 'reviewer@archived-execution-team',
        name: 'reviewer',
        agentType: 'security-reviewer',
        joinedAt: 1700000001000,
        cwd: '/tmp/project',
        isActive: false,
      }],
    }))
    await writeTranscriptFile('-tmp-project', 'reviewer-root-session', [
      {
        type: 'assistant',
        uuid: 'reviewer-tool-call',
        teamName: 'archived-execution-team',
        agentName: 'reviewer',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'bun test' } }],
        },
        timestamp: '2026-08-08T00:00:01.000Z',
      },
      {
        type: 'user',
        uuid: 'reviewer-tool-result',
        teamName: 'archived-execution-team',
        agentName: 'reviewer',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: '16 tests passed' }],
        },
        timestamp: '2026-08-08T00:00:02.000Z',
      },
    ])

    await service.getWorkbench('archived-execution-team')
    await fs.rm(path.join(tmpDir, 'teams', 'archived-execution-team'), { recursive: true, force: true })

    const page = await service.getMemberTranscriptPage(
      'archived-execution-team',
      'reviewer@archived-execution-team',
      { leadSessionId: 'archived-execution-lead' },
    )

    expect(page.messages.map((message) => message.id)).toEqual([
      'reviewer-tool-call',
      'reviewer-tool-result',
    ])
    expect(page.messages[0]?.content).toEqual([
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'bun test' } },
    ])
  })

  it('reconstructs a completed multi-member DAG from an old session transcript', () => {
    const messages: MessageEntry[] = [
      transcriptToolUse('team-create', 'TeamCreate', {
        team_name: 'legacy-team',
        description: 'A durable legacy workbench',
        agent_type: 'team-lead',
      }, '2026-08-08T00:00:00.000Z'),
      transcriptToolResult('team-create', {
        team_name: 'legacy-team',
        lead_agent_id: 'team-lead@legacy-team',
      }, '2026-08-08T00:00:00.100Z'),
      transcriptToolUse('spawn-reviewer', 'Agent', {
        team_name: 'legacy-team',
        name: 'reviewer',
        subagent_type: 'security-reviewer',
      }, '2026-08-08T00:00:01.000Z'),
      transcriptToolResult('spawn-reviewer', {
        agent_id: 'reviewer@legacy-team',
        agent_type: 'security-reviewer',
        model: 'deepseek-v4-flash',
        color: 'blue',
      }, '2026-08-08T00:00:01.100Z'),
      transcriptToolUse('task-one', 'TaskCreate', {
        subject: 'Audit the server',
        description: 'Trace the contract',
      }, '2026-08-08T00:00:02.000Z'),
      transcriptToolResult('task-one', {
        task: { id: '1', subject: 'Audit the server' },
      }, '2026-08-08T00:00:02.100Z'),
      transcriptToolUse('task-two', 'TaskCreate', {
        subject: 'Verify the desktop',
        description: 'Exercise archive reopen',
      }, '2026-08-08T00:00:03.000Z'),
      transcriptToolResult('task-two', {
        task: { id: '2', subject: 'Verify the desktop' },
      }, '2026-08-08T00:00:03.100Z'),
      transcriptToolUse('task-link', 'TaskUpdate', {
        taskId: '1',
        owner: 'reviewer',
        addBlocks: ['2'],
      }, '2026-08-08T00:00:04.000Z'),
      transcriptToolUse('task-list', 'TaskList', {}, '2026-08-08T00:00:05.000Z'),
      transcriptToolResult('task-list', {
        tasks: [
          { id: '1', subject: 'Audit the server', owner: 'reviewer', status: 'completed' },
          { id: '2', subject: 'Verify the desktop', owner: 'team-lead', status: 'completed' },
        ],
      }, '2026-08-08T00:00:05.100Z'),
      transcriptToolUse('broadcast', 'SendMessage', {
        to: '*',
        type: 'broadcast',
        content: 'Ship the archive',
      }, '2026-08-08T00:00:06.000Z'),
    ]

    const snapshots = projectTeamWorkbenchesFromTranscript('legacy-session', messages)

    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]).toMatchObject({
      deletedAt: '2026-08-08T00:00:06.000Z',
      team: {
        name: 'legacy-team',
        leadSessionId: 'legacy-session',
        memberCount: 2,
      },
      tasks: [
        { id: '1', status: 'completed', blocks: ['2'] },
        { id: '2', status: 'completed', blockedBy: ['1'] },
      ],
      messages: [{ id: 'broadcast', kind: 'broadcast', text: 'Ship the archive' }],
    })
  })

  it('projects successful and failed task updates by tool-use identity instead of result text', () => {
    const messages: MessageEntry[] = [
      transcriptToolUse('team-create', 'TeamCreate', {
        team_name: 'result-identity-team',
      }, '2026-08-08T00:00:00.000Z'),
      transcriptToolResult('team-create', {
        team_name: 'result-identity-team',
        lead_agent_id: 'team-lead@result-identity-team',
      }, '2026-08-08T00:00:00.100Z'),
      transcriptToolUse('task-a', 'TaskCreate', {
        subject: 'Review shared surface',
      }, '2026-08-08T00:00:01.000Z'),
      transcriptToolResult('task-a', {
        task: { id: 'A', subject: 'Review shared surface' },
      }, '2026-08-08T00:00:01.100Z'),
      transcriptToolUse('task-b', 'TaskCreate', {
        subject: 'Review shared surface',
      }, '2026-08-08T00:00:02.000Z'),
      transcriptToolResult('task-b', {
        task: { id: 'B', subject: 'Review shared surface' },
      }, '2026-08-08T00:00:02.100Z'),
      transcriptToolUse('failed-update-a', 'TaskUpdate', {
        taskId: 'A',
        status: 'completed',
      }, '2026-08-08T00:00:03.000Z'),
      transcriptToolResult(
        'failed-update-a',
        {},
        '2026-08-08T00:00:03.100Z',
        true,
      ),
      transcriptToolResult(
        'failed-update-a',
        {},
        '2026-08-08T00:00:03.200Z',
      ),
      transcriptToolUse('successful-update-b', 'TaskUpdate', {
        taskId: 'B',
        status: 'completed',
      }, '2026-08-08T00:00:04.000Z'),
      transcriptToolResult(
        'successful-update-b',
        {},
        '2026-08-08T00:00:04.100Z',
      ),
      transcriptToolUse('failed-bash', 'Bash', {
        command: 'false',
      }, '2026-08-08T00:00:05.000Z'),
      transcriptToolResult(
        'failed-bash',
        {},
        '2026-08-08T00:00:05.100Z',
        true,
      ),
    ]

    const [snapshot] = projectTeamWorkbenchesFromTranscript('legacy-session', messages)

    expect(snapshot?.tasks).toEqual([
      expect.objectContaining({ id: 'A', subject: 'Review shared surface', status: 'pending' }),
      expect.objectContaining({ id: 'B', subject: 'Review shared surface', status: 'completed' }),
    ])
    expect(snapshot?.generatedAt).toBe('2026-08-08T00:00:05.000Z')
  })

  it('keeps legacy dependency edges when TaskList fails or has no result', () => {
    const messages: MessageEntry[] = [
      transcriptToolUse('edge-team-create', 'TeamCreate', {
        team_name: 'legacy-edge-failure-team',
      }, '2026-08-08T00:05:00.000Z'),
      transcriptToolResult('edge-team-create', {
        success: true,
        team_name: 'legacy-edge-failure-team',
        lead_agent_id: 'team-lead@legacy-edge-failure-team',
      }, '2026-08-08T00:05:00.100Z'),
      transcriptToolUse('edge-task-one', 'TaskCreate', {
        subject: 'Keep the forward edge',
      }, '2026-08-08T00:05:01.000Z'),
      transcriptToolResult('edge-task-one', {
        success: true,
        task: { id: '1', subject: 'Keep the forward edge' },
      }, '2026-08-08T00:05:01.100Z'),
      transcriptToolUse('edge-task-two', 'TaskCreate', {
        subject: 'Keep the reverse edge',
      }, '2026-08-08T00:05:02.000Z'),
      transcriptToolResult('edge-task-two', {
        success: true,
        task: { id: '2', subject: 'Keep the reverse edge' },
      }, '2026-08-08T00:05:02.100Z'),
      transcriptToolUse('add-edge', 'TaskUpdate', {
        taskId: '1',
        addBlocks: ['2'],
      }, '2026-08-08T00:05:03.000Z'),
      transcriptToolResult('add-edge', {
        success: true,
      }, '2026-08-08T00:05:03.100Z'),
      transcriptToolUse('failed-edge-list', 'TaskList', {}, '2026-08-08T00:05:04.000Z'),
      transcriptToolResult('failed-edge-list', {
        success: false,
        tasks: [{
          id: '1',
          subject: 'Keep the forward edge',
          status: 'pending',
          blockedBy: [],
        }, {
          id: '2',
          subject: 'Keep the reverse edge',
          status: 'pending',
          blockedBy: [],
        }],
      }, '2026-08-08T00:05:04.100Z'),
      transcriptToolUse('missing-edge-list', 'TaskList', {}, '2026-08-08T00:05:05.000Z'),
    ]

    const [snapshot] = projectTeamWorkbenchesFromTranscript('legacy-session', messages)

    expect(snapshot?.tasks).toEqual([
      expect.objectContaining({ id: '1', blocks: ['2'], blockedBy: [] }),
      expect.objectContaining({ id: '2', blocks: [], blockedBy: ['1'] }),
    ])
  })

  it('treats legacy TaskList ownership and successful task deletion as authoritative', () => {
    const messages: MessageEntry[] = [
      transcriptToolUse('team-create', 'TeamCreate', {
        team_name: 'legacy-task-terminal-team',
      }, '2026-08-08T00:10:00.000Z'),
      transcriptToolResult('team-create', {
        success: true,
        team_name: 'legacy-task-terminal-team',
        lead_agent_id: 'team-lead@legacy-task-terminal-team',
      }, '2026-08-08T00:10:00.100Z'),
      transcriptToolUse('ownerless-task', 'TaskCreate', {
        subject: 'Clear a stale owner',
      }, '2026-08-08T00:10:01.000Z'),
      transcriptToolResult('ownerless-task', {
        success: true,
        task: { id: '1', subject: 'Clear a stale owner' },
      }, '2026-08-08T00:10:01.100Z'),
      transcriptToolUse('assign-owner', 'TaskUpdate', {
        taskId: '1',
        owner: 'exited-worker',
        status: 'in_progress',
      }, '2026-08-08T00:10:02.000Z'),
      transcriptToolResult('assign-owner', {
        success: true,
      }, '2026-08-08T00:10:02.100Z'),
      transcriptToolUse('full-ownerless-list', 'TaskList', {}, '2026-08-08T00:10:03.000Z'),
      transcriptToolResult('full-ownerless-list', {
        success: true,
        tasks: [{ id: '1', subject: 'Clear a stale owner', status: 'pending' }],
      }, '2026-08-08T00:10:03.100Z'),
      transcriptToolUse('deleted-task', 'TaskCreate', {
        subject: 'Disappear after successful deletion',
      }, '2026-08-08T00:10:04.000Z'),
      transcriptToolResult('deleted-task', {
        success: true,
        task: { id: '2', subject: 'Disappear after successful deletion' },
      }, '2026-08-08T00:10:04.100Z'),
      transcriptToolUse('delete-task', 'TaskUpdate', {
        taskId: '2',
        status: 'deleted',
      }, '2026-08-08T00:10:05.000Z'),
      transcriptToolResult('delete-task', {
        success: true,
      }, '2026-08-08T00:10:05.100Z'),
      transcriptToolUse('kept-task', 'TaskCreate', {
        subject: 'Remain after failed deletion',
      }, '2026-08-08T00:10:06.000Z'),
      transcriptToolResult('kept-task', {
        success: true,
        task: { id: '3', subject: 'Remain after failed deletion' },
      }, '2026-08-08T00:10:06.100Z'),
      transcriptToolUse('failed-delete-task', 'TaskUpdate', {
        taskId: '3',
        status: 'deleted',
      }, '2026-08-08T00:10:07.000Z'),
      transcriptToolResult('failed-delete-task', {
        success: false,
      }, '2026-08-08T00:10:07.100Z'),
    ]

    const [snapshot] = projectTeamWorkbenchesFromTranscript('legacy-session', messages)

    expect(snapshot?.tasks.map(task => ({
      id: task.id,
      owner: task.owner,
      status: task.status,
    }))).toEqual([{
      id: '1',
      owner: undefined,
      status: 'pending',
    }, {
      id: '3',
      owner: undefined,
      status: 'pending',
    }])
  })

  it('uses final Team identities and ignores structured failures when rebuilding old histories', () => {
    const messages: MessageEntry[] = [
      transcriptToolUse('team-create', 'TeamCreate', {
        team_name: 'requested-history-team',
      }, '2026-08-08T01:00:00.000Z'),
      transcriptToolResult('team-create', {
        success: true,
        team_name: 'requested-history-team-2',
        lead_agent_id: 'team-lead@requested-history-team-2',
      }, '2026-08-08T01:00:00.100Z'),
      // AgentTool resolves a named Agent against the active Team even when the
      // model omits team_name. An ordinary unnamed Agent remains a SubAgent.
      transcriptToolUse('spawn-reviewer', 'Agent', {
        name: 'reviewer',
        description: 'Review the rebuilt history',
      }, '2026-08-08T01:00:01.000Z'),
      transcriptToolResult('spawn-reviewer', {
        success: true,
        agent_id: 'reviewer@requested-history-team-2',
      }, '2026-08-08T01:00:01.100Z'),
      transcriptToolUse('direct-agent', 'Agent', {
        description: 'Remain a direct SubAgent',
      }, '2026-08-08T01:00:01.200Z'),
      transcriptToolResult('direct-agent', {
        success: true,
        agent_id: 'direct-agent-id',
      }, '2026-08-08T01:00:01.300Z'),
      transcriptToolUse('task-create', 'TaskCreate', {
        subject: 'Keep the active Team after a failed delete',
      }, '2026-08-08T01:00:02.000Z'),
      transcriptToolResult('task-create', {
        success: true,
        task: { id: '1', subject: 'Keep the active Team after a failed delete' },
      }, '2026-08-08T01:00:02.100Z'),
      transcriptToolUse('failed-task-update', 'TaskUpdate', {
        taskId: '1',
        owner: 'wrong-owner',
        status: 'completed',
      }, '2026-08-08T01:00:03.000Z'),
      transcriptToolResult('failed-task-update', {
        success: false,
      }, '2026-08-08T01:00:03.100Z'),
      transcriptToolUse('failed-team-delete', 'TeamDelete', {}, '2026-08-08T01:00:04.000Z'),
      transcriptToolResult('failed-team-delete', {
        success: false,
        team_name: 'requested-history-team-2',
      }, '2026-08-08T01:00:04.100Z'),
      transcriptToolUse('successful-task-update', 'TaskUpdate', {
        taskId: '1',
        owner: 'reviewer',
        status: 'completed',
      }, '2026-08-08T01:00:05.000Z'),
      transcriptToolResult('successful-task-update', {
        success: true,
      }, '2026-08-08T01:00:05.100Z'),
    ]

    const [snapshot] = projectTeamWorkbenchesFromTranscript('legacy-session', messages)

    expect(snapshot?.team.name).toBe('requested-history-team-2')
    expect(snapshot?.team.members.map(member => member.name)).toEqual([
      'team-lead',
      'reviewer',
    ])
    expect(snapshot?.tasks).toEqual([
      expect.objectContaining({ id: '1', owner: 'reviewer', status: 'completed' }),
    ])
  })

  it('preserves every same-name Team incarnation in a legacy transcript', () => {
    const createTeam = (id: string, timestamp: string): MessageEntry[] => [
      transcriptToolUse(`${id}-create`, 'TeamCreate', {
        team_name: 'reused-history-team',
      }, timestamp),
      transcriptToolResult(`${id}-create`, {
        success: true,
        team_name: 'reused-history-team',
        lead_agent_id: 'team-lead@reused-history-team',
      }, new Date(Date.parse(timestamp) + 1).toISOString()),
      transcriptToolUse(`${id}-task`, 'TaskCreate', {
        subject: `${id} task`,
      }, new Date(Date.parse(timestamp) + 2).toISOString()),
      transcriptToolResult(`${id}-task`, {
        success: true,
        task: { id: '1', subject: `${id} task` },
      }, new Date(Date.parse(timestamp) + 3).toISOString()),
    ]
    const messages: MessageEntry[] = [
      ...createTeam('first', '2026-08-08T02:00:00.000Z'),
      transcriptToolUse('first-delete', 'TeamDelete', {}, '2026-08-08T02:00:01.000Z'),
      transcriptToolResult('first-delete', {
        success: true,
        team_name: 'reused-history-team',
      }, '2026-08-08T02:00:01.001Z'),
      ...createTeam('second', '2026-08-08T02:00:02.000Z'),
    ]

    const snapshots = projectTeamWorkbenchesFromTranscript('legacy-session', messages)

    expect(snapshots).toHaveLength(2)
    expect(snapshots.map(snapshot => snapshot.tasks[0]?.subject)).toEqual([
      'first task',
      'second task',
    ])
    expect(new Set(snapshots.map(snapshot => snapshot.team.incarnationId)).size).toBe(2)
  })

  it('should derive running status when isActive is undefined', async () => {
    const config = makeTeamConfig({ name: 'undef-team' })
    // Remove isActive from the first member to simulate undefined
    delete (config.members[0] as Record<string, unknown>).isActive
    await writeTeamConfig('undef-team', config)

    const detail = await service.getTeam('undef-team')
    const lead = detail.members.find((m) => m.agentId === 'agent-lead')!
    expect(lead.status).toBe('running')
  })

  it('should throw 404 for non-existent team', async () => {
    expect(service.getTeam('nonexistent')).rejects.toThrow('Team not found')
  })

  // --------------------------------------------------------------------------
  // getMemberTranscript
  // --------------------------------------------------------------------------

  it('uses the session index locator and bounded entry ranges for a configured session', async () => {
    await writeTeamConfig('indexed-team', makeTeamConfig({ name: 'indexed-team' }))
    const transcriptEntries = [{
      type: 'user',
      uuid: 'u1',
      message: { role: 'user', content: 'Indexed' },
      timestamp: '2026-01-01T00:01:00.000Z',
    }, {
      type: 'cc-haha-task-notification',
      isMeta: true,
      taskNotification: {
        taskId: 'indexed-task',
        toolUseId: 'indexed-bash',
        status: 'killed',
        summary: 'Indexed command killed',
      },
      timestamp: '2026-01-01T00:02:00.000Z',
    }]
    const filePath = await writeTranscriptFile(
      '-tmp-project',
      'session-lead-001',
      transcriptEntries,
    )
    const lineLengths = transcriptEntries.map(entry => (
      Buffer.byteLength(`${JSON.stringify(entry)}\n`)
    ))
    const stat = await fs.stat(filePath)
    const fingerprint = serializeSourceFingerprint({
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      fileIdentity: null,
      firstWindowHash: 'a'.repeat(64),
      lastWindowHash: 'b'.repeat(64),
      boundaryWindowHash: 'c'.repeat(64),
      indexedBytes: stat.size,
      parserVersion: 3,
    })
    const gateway: LocalIndexGateway = {
      async start() {},
      async stop() {},
      getMode: () => 'on',
      getPublicStatus: () => ({ mode: 'on', state: 'ready', discovered: 1, indexed: 1, degradedSources: 0, databaseBytes: 1, walBytes: 0, lastUpdatedAt: 'now', lastErrorCode: null }),
      isSessionScopeReady: () => true,
      listSessions: () => ({ sessions: [], total: 0 }),
      findSessionFiles: () => [],
      getSessionEntryLocators: () => ({
        source: { path: filePath, size: stat.size, mtimeMs: stat.mtimeMs, fileIdentity: null, fingerprint, indexedBytes: stat.size, parserVersion: 3, state: 'ready', lastErrorCode: null, updatedAtMs: 1 },
        entries: [
          { ordinal: 0, jsonlLine: 1, byteStart: 0, byteLength: lineLengths[0]!, entryType: 'user', messageId: 'u1', role: 'user', timestamp: '2026-01-01T00:01:00.000Z', parentToolUseId: null },
          { ordinal: 1, jsonlLine: 2, byteStart: lineLengths[0]!, byteLength: lineLengths[1]!, entryType: 'cc-haha-task-notification', messageId: null, role: null, timestamp: '2026-01-01T00:02:00.000Z', parentToolUseId: null },
        ],
      }),
      async rebuild() { return this.getPublicStatus() },
    }
    let selectedBytes = 0
    const indexedService = new TeamService({
      sessionLocator: { findSessionFile: async () => ({ filePath, projectDir: '-tmp-project' }) },
      localIndexGateway: gateway,
      targetedEntryReader: async (options) => {
        selectedBytes = options.page.entries.reduce((sum, entry) => sum + entry.byteLength, 0)
        return {
          entries: transcriptEntries,
          bytesRead: selectedBytes,
          rangesRead: 1,
        }
      },
    })

    const page = await indexedService.getMemberTranscriptPage('indexed-team', 'agent-lead')

    expect(page.messages.map(message => message.id)).toEqual(['u1'])
    expect(page.taskNotifications).toEqual([{
      taskId: 'indexed-task',
      toolUseId: 'indexed-bash',
      status: 'stopped',
      summary: 'Indexed command killed',
      timestamp: '2026-01-01T00:02:00.000Z',
    }])
    expect(page.afterOrdinal).toBe(1)
    expect(selectedBytes).toBe(stat.size)
  })

  it('rejects an indexed page changed during an empty targeted read and resets from canonical data', async () => {
    await writeTeamConfig(
      'indexed-read-race-team',
      makeTeamConfig({ name: 'indexed-read-race-team' }),
    )
    const transcriptPath = path.join(
      tmpDir,
      'projects',
      '-tmp-project',
      'session-lead-001.jsonl',
    )
    await fs.mkdir(path.dirname(transcriptPath), { recursive: true })
    const line = (uuid: string, content: string) => `${JSON.stringify({
      type: 'user',
      uuid,
      message: { role: 'user', content },
      timestamp: '2026-01-01T00:01:00.000Z',
    })}\n`
    const originalLines = [
      line('first', 'f'.repeat(70_000)),
      line('middle', 'OLD-MIDDLE'),
      line('last', 'l'.repeat(70_000)),
    ]
    const replacementMiddle = line('middle', 'NEW-MIDDLE')
    expect(Buffer.byteLength(replacementMiddle)).toBe(
      Buffer.byteLength(originalLines[1]!),
    )
    await fs.writeFile(transcriptPath, originalLines.join(''))
    const initialStat = await fs.stat(transcriptPath)
    const fingerprint = await captureSourceFingerprint({
      path: transcriptPath,
      indexedBytes: initialStat.size,
      parserVersion: 3,
    })
    let byteStart = 0
    const messageIds = ['first', 'middle', 'last']
    const locators = originalLines.map((raw, index) => {
      const byteLength = Buffer.byteLength(raw)
      const locator = {
        ordinal: index,
        jsonlLine: index + 1,
        byteStart,
        byteLength,
        entryType: 'user',
        messageId: messageIds[index]!,
        role: 'user',
        timestamp: '2026-01-01T00:01:00.000Z',
        parentToolUseId: null,
      }
      byteStart += byteLength
      return locator
    })
    const locatorPage: SessionEntryLocatorPage = {
      source: {
        path: transcriptPath,
        size: fingerprint.size,
        mtimeMs: fingerprint.mtimeMs,
        fileIdentity: fingerprint.fileIdentity,
        fingerprint: serializeSourceFingerprint(fingerprint),
        indexedBytes: fingerprint.indexedBytes,
        parserVersion: fingerprint.parserVersion,
        state: 'ready',
        lastErrorCode: null,
        updatedAtMs: 1,
      },
      entries: locators,
    }
    const gateway: LocalIndexGateway = {
      async start() {},
      async stop() {},
      getMode: () => 'on',
      getPublicStatus: () => ({ mode: 'on', state: 'ready', discovered: 1, indexed: 1, degradedSources: 0, databaseBytes: 1, walBytes: 0, lastUpdatedAt: 'now', lastErrorCode: null }),
      isSessionScopeReady: () => true,
      listSessions: () => ({ sessions: [], total: 0 }),
      findSessionFiles: () => [],
      getSessionEntryLocators: () => locatorPage,
      async rebuild() { return this.getPublicStatus() },
    }
    let rewriteOnRead = false
    let ctimeBeforeRewrite = 0
    let ctimeAfterRewrite = 0
    const indexedService = new TeamService({
      sessionLocator: {
        findSessionFile: async () => ({
          filePath: transcriptPath,
          projectDir: '-tmp-project',
        }),
      },
      localIndexGateway: gateway,
      targetedEntryReader: async (options) => {
        if (rewriteOnRead) {
          rewriteOnRead = false
          ctimeBeforeRewrite = (await fs.stat(transcriptPath)).ctimeMs
          await new Promise(resolve => setTimeout(resolve, 8))
          await fs.writeFile(
            transcriptPath,
            originalLines[0]! + replacementMiddle + originalLines[2]!,
          )
          await fs.utimes(
            transcriptPath,
            fingerprint.mtimeMs / 1000,
            fingerprint.mtimeMs / 1000,
          )
          ctimeAfterRewrite = (await fs.stat(transcriptPath)).ctimeMs
        }
        return readSessionEntriesByLocator(options)
      },
    })
    const initial = await indexedService.getMemberTranscriptPage(
      'indexed-read-race-team',
      'agent-lead',
    )
    const unchanged = await indexedService.getMemberTranscriptPage(
      'indexed-read-race-team',
      'agent-lead',
      {
        signature: initial.signature,
        cursor: initial.cursor,
        afterOrdinal: initial.afterOrdinal,
      },
    )
    expect(unchanged.reset).toBeUndefined()
    expect(unchanged.messages).toEqual([])
    rewriteOnRead = true

    const raced = await indexedService.getMemberTranscriptPage(
      'indexed-read-race-team',
      'agent-lead',
      {
        signature: unchanged.signature,
        cursor: unchanged.cursor,
        afterOrdinal: unchanged.afterOrdinal,
      },
    )

    expect(ctimeAfterRewrite).not.toBe(ctimeBeforeRewrite)
    expect(raced.reset).toBe(true)
    expect(raced.messages.map(message => message.id)).toEqual([
      'first',
      'middle',
      'last',
    ])
    expect(raced.messages[1]?.content).toBe('NEW-MIDDLE')
  })

  it('keeps a stable indexed append incremental after post-read snapshot verification', async () => {
    await writeTeamConfig(
      'indexed-append-team',
      makeTeamConfig({ name: 'indexed-append-team' }),
    )
    const transcriptPath = path.join(
      tmpDir,
      'projects',
      '-tmp-project',
      'session-lead-001.jsonl',
    )
    await fs.mkdir(path.dirname(transcriptPath), { recursive: true })
    const records = [{
      type: 'user',
      uuid: 'u1',
      message: { role: 'user', content: 'First' },
      timestamp: '2026-01-01T00:01:00.000Z',
    }]
    const rawLines = records.map(record => `${JSON.stringify(record)}\n`)
    await fs.writeFile(transcriptPath, rawLines.join(''))
    const makeLocatorPage = async (): Promise<SessionEntryLocatorPage> => {
      const snapshot = await fs.stat(transcriptPath)
      const fingerprint = await captureSourceFingerprint({
        path: transcriptPath,
        indexedBytes: snapshot.size,
        parserVersion: 3,
      })
      let byteStart = 0
      const entries = records.map((record, index) => {
        const byteLength = Buffer.byteLength(rawLines[index]!)
        const locator = {
          ordinal: index,
          jsonlLine: index + 1,
          byteStart,
          byteLength,
          entryType: record.type,
          messageId: record.uuid,
          role: record.message.role,
          timestamp: record.timestamp,
          parentToolUseId: null,
        }
        byteStart += byteLength
        return locator
      })
      return {
        source: {
          path: transcriptPath,
          size: fingerprint.size,
          mtimeMs: fingerprint.mtimeMs,
          fileIdentity: fingerprint.fileIdentity,
          fingerprint: serializeSourceFingerprint(fingerprint),
          indexedBytes: fingerprint.indexedBytes,
          parserVersion: fingerprint.parserVersion,
          state: 'ready',
          lastErrorCode: null,
          updatedAtMs: 1,
        },
        entries,
      }
    }
    let locatorPage = await makeLocatorPage()
    const gateway: LocalIndexGateway = {
      async start() {},
      async stop() {},
      getMode: () => 'on',
      getPublicStatus: () => ({ mode: 'on', state: 'ready', discovered: 1, indexed: 1, degradedSources: 0, databaseBytes: 1, walBytes: 0, lastUpdatedAt: 'now', lastErrorCode: null }),
      isSessionScopeReady: () => true,
      listSessions: () => ({ sessions: [], total: 0 }),
      findSessionFiles: () => [],
      getSessionEntryLocators: () => locatorPage,
      async rebuild() { return this.getPublicStatus() },
    }
    const indexedService = new TeamService({
      sessionLocator: {
        findSessionFile: async () => ({
          filePath: transcriptPath,
          projectDir: '-tmp-project',
        }),
      },
      localIndexGateway: gateway,
      targetedEntryReader: readSessionEntriesByLocator,
    })
    const initial = await indexedService.getMemberTranscriptPage(
      'indexed-append-team',
      'agent-lead',
    )
    const appendedRecord = {
      type: 'assistant',
      uuid: 'a1',
      message: { role: 'assistant', content: 'Second' },
      timestamp: '2026-01-01T00:02:00.000Z',
    }
    records.push(appendedRecord as typeof records[number])
    const appendedLine = `${JSON.stringify(appendedRecord)}\n`
    rawLines.push(appendedLine)
    await fs.appendFile(transcriptPath, appendedLine)
    locatorPage = await makeLocatorPage()

    const appended = await indexedService.getMemberTranscriptPage(
      'indexed-append-team',
      'agent-lead',
      {
        signature: initial.signature,
        cursor: initial.cursor,
        afterOrdinal: initial.afterOrdinal,
      },
    )

    expect(appended.reset).toBeUndefined()
    expect(appended.messages.map(message => message.id)).toEqual(['a1'])
    expect(appended.afterOrdinal).toBe(1)
  })

  it('falls back to the canonical parser for a pending indexed tail', async () => {
    await writeTeamConfig('pending-team', makeTeamConfig({ name: 'pending-team' }))
    const first = `${JSON.stringify({
      type: 'user',
      uuid: 'u1',
      message: { role: 'user', content: 'Complete' },
      timestamp: '2026-01-01T00:01:00.000Z',
    })}\n`
    const finalWithoutNewline = JSON.stringify({
      type: 'assistant',
      uuid: 'a1',
      message: { role: 'assistant', content: 'Valid pending tail' },
      timestamp: '2026-01-01T00:02:00.000Z',
    })
    const filePath = path.join(
      tmpDir,
      'projects',
      '-tmp-project',
      'session-lead-001.jsonl',
    )
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, first + finalWithoutNewline)
    const stat = await fs.stat(filePath)
    const fingerprint = serializeSourceFingerprint({
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      fileIdentity: null,
      firstWindowHash: 'a'.repeat(64),
      lastWindowHash: 'b'.repeat(64),
      boundaryWindowHash: 'c'.repeat(64),
      indexedBytes: Buffer.byteLength(first),
      parserVersion: 3,
    })
    const gateway: LocalIndexGateway = {
      async start() {},
      async stop() {},
      getMode: () => 'on',
      getPublicStatus: () => ({ mode: 'on', state: 'ready', discovered: 1, indexed: 1, degradedSources: 0, databaseBytes: 1, walBytes: 0, lastUpdatedAt: 'now', lastErrorCode: null }),
      isSessionScopeReady: () => true,
      listSessions: () => ({ sessions: [], total: 0 }),
      findSessionFiles: () => [],
      getSessionEntryLocators: () => ({
        source: {
          path: filePath,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          fileIdentity: null,
          fingerprint,
          indexedBytes: Buffer.byteLength(first),
          parserVersion: 3,
          state: 'pending',
          lastErrorCode: null,
          updatedAtMs: 1,
        },
        entries: [{
          ordinal: 0,
          jsonlLine: 1,
          byteStart: 0,
          byteLength: Buffer.byteLength(first),
          entryType: 'user',
          messageId: 'u1',
          role: 'user',
          timestamp: '2026-01-01T00:01:00.000Z',
          parentToolUseId: null,
        }],
      }),
      async rebuild() { return this.getPublicStatus() },
    }
    let targetedReads = 0
    const pendingService = new TeamService({
      sessionLocator: { findSessionFile: async () => ({ filePath, projectDir: '-tmp-project' }) },
      localIndexGateway: gateway,
      targetedEntryReader: async () => {
        targetedReads += 1
        return {
          entries: [JSON.parse(first) as Record<string, unknown>],
          bytesRead: Buffer.byteLength(first),
          rangesRead: 1,
        }
      },
    })

    const messages = await pendingService.getMemberTranscript('pending-team', 'agent-lead')

    expect(messages.map(message => message.id)).toEqual(['u1', 'a1'])
    expect(targetedReads).toBe(0)
  })

  it('resets malformed cursors even when the transcript signature is unchanged', async () => {
    await writeTeamConfig('malformed-cursor-team', makeTeamConfig({ name: 'malformed-cursor-team' }))
    await writeTranscriptFile('-tmp-project', 'session-lead-001', [{
      type: 'user',
      uuid: 'u1',
      message: { role: 'user', content: 'First' },
      timestamp: '2026-01-01T00:01:00.000Z',
    }])
    const canonicalService = new TeamService({
      localIndexGateway: disabledIndexGateway(),
    })
    const initial = await canonicalService.getMemberTranscriptPage(
      'malformed-cursor-team',
      'agent-lead',
    )

    const reset = await canonicalService.getMemberTranscriptPage(
      'malformed-cursor-team',
      'agent-lead',
      {
        signature: initial.signature,
        cursor: 'not-a-valid-cursor',
        afterOrdinal: initial.afterOrdinal,
      },
    )

    expect(reset.reset).toBe(true)
    expect(reset.messages.map(message => message.id)).toEqual(['u1'])
  })

  it('continues through a partial append and resets after truncation', async () => {
    await writeTeamConfig('cursor-boundary-team', makeTeamConfig({ name: 'cursor-boundary-team' }))
    const transcriptPath = await writeTranscriptFile('-tmp-project', 'session-lead-001', [{
      type: 'user',
      uuid: 'u1',
      message: { role: 'user', content: 'First' },
      timestamp: '2026-01-01T00:01:00.000Z',
    }])
    const canonicalService = new TeamService({
      localIndexGateway: disabledIndexGateway(),
    })
    const initial = await canonicalService.getMemberTranscriptPage(
      'cursor-boundary-team',
      'agent-lead',
    )

    await fs.appendFile(transcriptPath, '{"type":"assistant"')
    const partial = await canonicalService.getMemberTranscriptPage(
      'cursor-boundary-team',
      'agent-lead',
      {
        signature: initial.signature,
        cursor: initial.cursor,
        afterOrdinal: initial.afterOrdinal,
      },
    )
    expect(partial.messages).toEqual([])
    expect(partial.reset).toBeUndefined()

    await fs.appendFile(
      transcriptPath,
      ',"uuid":"a1","message":{"role":"assistant","content":"Second"},"timestamp":"2026-01-01T00:02:00.000Z"}\n',
    )
    const completed = await canonicalService.getMemberTranscriptPage(
      'cursor-boundary-team',
      'agent-lead',
      {
        signature: partial.signature,
        cursor: partial.cursor,
        afterOrdinal: partial.afterOrdinal,
      },
    )
    expect(completed.messages.map(message => message.id)).toEqual(['a1'])
    expect(completed.reset).toBeUndefined()

    await fs.writeFile(transcriptPath, `${JSON.stringify({
      type: 'user',
      uuid: 'replacement',
      message: { role: 'user', content: 'Replacement' },
      timestamp: '2026-01-01T00:03:00.000Z',
    })}\n`)
    const truncated = await canonicalService.getMemberTranscriptPage(
      'cursor-boundary-team',
      'agent-lead',
      {
        signature: completed.signature,
        cursor: completed.cursor,
        afterOrdinal: completed.afterOrdinal,
      },
    )
    expect(truncated.reset).toBe(true)
    expect(truncated.messages.map(message => message.id)).toEqual(['replacement'])
  })

  it('resets a same-size rewrite outside the bounded cursor windows', async () => {
    await writeTeamConfig('large-rewrite-team', makeTeamConfig({ name: 'large-rewrite-team' }))
    const transcriptPath = path.join(
      tmpDir,
      'projects',
      '-tmp-project',
      'session-lead-001.jsonl',
    )
    await fs.mkdir(path.dirname(transcriptPath), { recursive: true })
    const line = (uuid: string, content: string) => `${JSON.stringify({
      type: 'user',
      uuid,
      message: { role: 'user', content },
      timestamp: '2026-01-01T00:01:00.000Z',
    })}\n`
    const before = line('first', 'f'.repeat(70_000)) +
      line('middle-old', 'OLD-MIDDLE') +
      line('last', 'l'.repeat(70_000))
    const after = line('first', 'f'.repeat(70_000)) +
      line('middle-new', 'NEW-MIDDLE') +
      line('last', 'l'.repeat(70_000))
    expect(Buffer.byteLength(after)).toBe(Buffer.byteLength(before))
    await fs.writeFile(transcriptPath, before)
    const canonicalService = new TeamService({
      localIndexGateway: disabledIndexGateway(),
    })
    const initial = await canonicalService.getMemberTranscriptPage(
      'large-rewrite-team',
      'agent-lead',
    )

    await fs.writeFile(transcriptPath, after)
    const rewritten = await canonicalService.getMemberTranscriptPage(
      'large-rewrite-team',
      'agent-lead',
      {
        signature: initial.signature,
        cursor: initial.cursor,
        afterOrdinal: initial.afterOrdinal,
      },
    )

    expect(rewritten.reset).toBe(true)
    expect(rewritten.messages.map(message => message.id)).toEqual([
      'first',
      'middle-new',
      'last',
    ])
  })

  it('safely resets a legacy v1 transcript cursor', async () => {
    await writeTeamConfig('legacy-cursor-team', makeTeamConfig({ name: 'legacy-cursor-team' }))
    await writeTranscriptFile('-tmp-project', 'session-lead-001', [{
      type: 'user',
      uuid: 'u1',
      message: { role: 'user', content: 'First' },
      timestamp: '2026-01-01T00:01:00.000Z',
    }])
    const canonicalService = new TeamService({
      localIndexGateway: disabledIndexGateway(),
    })
    const initial = await canonicalService.getMemberTranscriptPage(
      'legacy-cursor-team',
      'agent-lead',
    )
    const legacyPayload = JSON.parse(
      Buffer.from(initial.cursor, 'base64url').toString('utf8'),
    ) as Record<string, unknown>
    legacyPayload.version = 1
    delete legacyPayload.ctimeMs
    const legacyCursor = Buffer.from(JSON.stringify(legacyPayload)).toString('base64url')

    const reset = await canonicalService.getMemberTranscriptPage(
      'legacy-cursor-team',
      'agent-lead',
      {
        signature: initial.signature,
        cursor: legacyCursor,
        afterOrdinal: initial.afterOrdinal,
      },
    )

    expect(reset.reset).toBe(true)
    expect(reset.messages.map(message => message.id)).toEqual(['u1'])
  })

  it('should return transcript messages for a member', async () => {
    await writeTeamConfig('transcript-team', makeTeamConfig({ name: 'transcript-team' }))

    // Write a mock transcript JSONL for the lead session
    await writeTranscriptFile('-tmp-project', 'session-lead-001', [
      {
        type: 'file-history-snapshot',
        messageId: 'snap-1',
        snapshot: {},
      },
      {
        type: 'user',
        uuid: 'msg-user-1',
        message: { role: 'user', content: 'Hello team' },
        timestamp: '2026-01-01T00:01:00.000Z',
      },
      {
        type: 'assistant',
        uuid: 'msg-asst-1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hi! Ready to help.' }],
        },
        timestamp: '2026-01-01T00:02:00.000Z',
      },
    ])

    const messages = await service.getMemberTranscript(
      'transcript-team',
      'agent-lead',
    )
    expect(messages).toHaveLength(2)
    expect(messages[0]!.type).toBe('user')
    expect(messages[0]!.id).toBe('msg-user-1')
    expect(messages[0]!.content).toBe('Hello team')
    expect(messages[1]!.type).toBe('assistant')
    expect(messages[1]!.content).toEqual([{ type: 'text', text: 'Hi! Ready to help.' }])
  })

  it('should return empty array when member has no sessionId', async () => {
    const config = makeTeamConfig({ name: 'no-session-team' })
    delete (config.members[0] as Record<string, unknown>).sessionId
    await writeTeamConfig('no-session-team', config)

    const messages = await service.getMemberTranscript(
      'no-session-team',
      'agent-lead',
    )
    expect(messages).toEqual([])
  })

  it('should return empty array when transcript file not found', async () => {
    await writeTeamConfig('no-file-team', makeTeamConfig({ name: 'no-file-team' }))

    // Don't write any transcript file
    const messages = await service.getMemberTranscript(
      'no-file-team',
      'agent-lead',
    )
    expect(messages).toEqual([])
    const page = await service.getMemberTranscriptPage('no-file-team', 'agent-lead')
    expect(page.ownerAgentIds).toEqual([])
  })

  it('should throw 404 for unknown member', async () => {
    await writeTeamConfig('member-team', makeTeamConfig({ name: 'member-team' }))

    expect(
      service.getMemberTranscript('member-team', 'nonexistent-agent'),
    ).rejects.toThrow('Team member not found')
  })

  it('should skip meta entries in transcript', async () => {
    await writeTeamConfig('meta-team', makeTeamConfig({ name: 'meta-team' }))

    await writeTranscriptFile('-tmp-project', 'session-lead-001', [
      {
        type: 'user',
        uuid: 'msg-meta',
        message: { role: 'user', content: 'internal meta' },
        isMeta: true,
        timestamp: '2026-01-01T00:00:30.000Z',
      },
      {
        type: 'user',
        uuid: 'msg-real',
        message: { role: 'user', content: 'Real message' },
        timestamp: '2026-01-01T00:01:00.000Z',
      },
    ])

    const messages = await service.getMemberTranscript('meta-team', 'agent-lead')
    expect(messages).toHaveLength(1)
    expect(messages[0]!.id).toBe('msg-real')
  })

  // --------------------------------------------------------------------------
  // sendMemberMessage
  // --------------------------------------------------------------------------

  it('should write member messages into the teammate inbox', async () => {
    await writeTeamConfig('mailbox-team', makeTeamConfig({ name: 'mailbox-team' }))

    await service.sendMemberMessage(
      'mailbox-team',
      'agent-worker',
      'Please review the latest diff',
    )

    const inboxPath = path.join(
      tmpDir,
      'teams',
      'mailbox-team',
      'inboxes',
      'Worker-Agent.json',
    )
    const rawInbox = await fs.readFile(inboxPath, 'utf-8')
    const inbox = JSON.parse(rawInbox) as Array<{
      from: string
      text: string
      read: boolean
    }>

    expect(inbox).toHaveLength(1)
    expect(inbox[0]).toMatchObject({
      from: 'user',
      text: 'Please review the latest diff',
      read: false,
    })
  })

  it('should send messages to inbox-discovered members', async () => {
    await writeTeamConfig('inbox-team', makeTeamConfig({ name: 'inbox-team' }))
    const inboxDir = path.join(tmpDir, 'teams', 'inbox-team', 'inboxes')
    await fs.mkdir(inboxDir, { recursive: true })
    await fs.writeFile(path.join(inboxDir, 'security-reviewer.json'), '[]', 'utf-8')

    await service.sendMemberMessage(
      'inbox-team',
      'security-reviewer@inbox-team',
      'Check the auth changes',
    )

    const rawInbox = await fs.readFile(
      path.join(inboxDir, 'security-reviewer.json'),
      'utf-8',
    )
    const inbox = JSON.parse(rawInbox) as Array<{ text: string }>
    expect(inbox.at(-1)?.text).toBe('Check the auth changes')
  })

  // --------------------------------------------------------------------------
  // deleteTeam
  // --------------------------------------------------------------------------

  it('should delete a team after every teammate has been removed', async () => {
    const leadSessionId = 'deletable-lead-session'
    const config = makeTeamConfig({ name: 'deletable', leadSessionId })
    config.members = config.members.filter(
      member => member.agentId === config.leadAgentId,
    )
    config.members[0]!.isActive = false
    await writeTeamConfig('deletable', config)
    await writeTeamTask('deletable', {
      id: '1',
      subject: 'Archive the API deletion',
      description: 'The task directory and final DAG must move together',
      owner: 'Worker Agent',
      status: 'completed',
      blocks: [],
      blockedBy: [],
    })

    await service.deleteTeam('deletable')

    const teamDir = path.join(tmpDir, 'teams', 'deletable')
    const tasksDir = path.join(tmpDir, 'tasks', 'deletable')
    await expect(fs.access(teamDir)).rejects.toThrow()
    await expect(fs.access(tasksDir)).rejects.toThrow()
    const reopened = await service.getWorkbenchForSession(leadSessionId)
    expect(reopened?.snapshots.at(-1)).toMatchObject({
      deletedAt: expect.any(String),
      terminalTaskFrameId: expect.stringContaining('lifecycle:'),
      tasks: [{
        id: '1',
        subject: 'Archive the API deletion',
        status: 'completed',
      }],
    })
  })

  it('should refuse to delete a team while an idle teammate remains registered', async () => {
    const config = makeTeamConfig({ name: 'active-team' })
    for (const member of config.members) member.isActive = false
    await writeTeamConfig('active-team', config)

    expect(service.deleteTeam('active-team')).rejects.toThrow(
      'teammates remain registered',
    )
  })

  it('should refuse to delete a lead-only team while its lead is active', async () => {
    const config = makeTeamConfig({ name: 'active-lead-team' })
    config.members = config.members.filter(
      member => member.agentId === config.leadAgentId,
    )
    await writeTeamConfig('active-lead-team', config)

    expect(service.deleteTeam('active-lead-team')).rejects.toThrow(
      'lead is active',
    )
  })

  it('should throw 404 when deleting non-existent team', async () => {
    expect(service.deleteTeam('ghost')).rejects.toThrow('Team not found')
  })
})

// ============================================================================
// Teams API integration tests
// ============================================================================

describe('Teams API', () => {
  let baseUrl: string
  let server: ReturnType<typeof Bun.serve> | null = null

  beforeEach(async () => {
    await setupTmpConfigDir()
    service = new TeamService()

    const { handleTeamsApi } = await import('../api/teams.js')

    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',

      async fetch(req) {
        const url = new URL(req.url)
        const segments = url.pathname.split('/').filter(Boolean)

        if (segments[0] === 'api' && segments[1] === 'teams') {
          return handleTeamsApi(req, url, segments)
        }

        return new Response('Not Found', { status: 404 })
      },
    })
    baseUrl = `http://127.0.0.1:${server.port}`
  })

  afterEach(async () => {
    if (server) {
      server.stop(true)
      server = null
    }
    await cleanupTmpDir()
  })

  it('GET /api/teams should return empty list', async () => {
    const res = await fetch(`${baseUrl}/api/teams`)
    expect(res.status).toBe(200)

    const body = (await res.json()) as { teams: unknown[] }
    expect(body.teams).toEqual([])
  })

  it('GET /api/teams should list teams', async () => {
    await writeTeamConfig('api-team', makeTeamConfig({ name: 'api-team' }))

    const res = await fetch(`${baseUrl}/api/teams`)
    expect(res.status).toBe(200)

    const body = (await res.json()) as { teams: Array<{ name: string }> }
    expect(body.teams).toHaveLength(1)
    expect(body.teams[0]!.name).toBe('api-team')
  })

  it('GET /api/teams/:name should return team detail', async () => {
    await writeTeamConfig(
      'detail',
      makeTeamConfig({ name: 'detail', leadSessionId: 'leader-session-id' }),
    )

    const res = await fetch(`${baseUrl}/api/teams/detail`)
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      name: string
      leadAgentId: string
      leadSessionId?: string
      members: Array<{ agentId: string }>
    }
    expect(body.name).toBe('detail')
    expect(body.leadAgentId).toBe('agent-lead')
    expect(body.leadSessionId).toBe('leader-session-id')
    expect(body.members).toHaveLength(2)
  })

  it('GET /api/teams/:name/workbench should return the joined DAG snapshot', async () => {
    await writeTeamConfig(
      'api-workbench',
      makeTeamConfig({ name: 'api-workbench', leadSessionId: 'api-lead-session' }),
    )
    await writeTeamTask('api-workbench', {
      id: '7',
      subject: 'Verify workbench API',
      description: 'Exercise the joined contract',
      status: 'in_progress',
      blocks: [],
      blockedBy: [],
    })

    const res = await fetch(`${baseUrl}/api/teams/api-workbench/workbench`)
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      version: string
      team: { leadSessionId?: string }
      tasks: Array<{ id: string; subject: string }>
      messages: unknown[]
    }
    expect(body.version).toHaveLength(64)
    expect(body.team.leadSessionId).toBe('api-lead-session')
    expect(body.tasks).toEqual([expect.objectContaining({
      id: '7',
      subject: 'Verify workbench API',
    })])
    expect(body.messages).toEqual([])
  })

  it('GET /api/teams/session/:id/workbench should reopen a completed archive', async () => {
    await writeTeamConfig('api-archive', makeTeamConfig({
      name: 'api-archive',
      leadSessionId: 'api-archive-session',
    }))
    const live = await fetch(`${baseUrl}/api/teams/api-archive/workbench`)
    expect(live.status).toBe(200)
    await fs.rm(path.join(tmpDir, 'teams', 'api-archive'), { recursive: true, force: true })

    const response = await fetch(
      `${baseUrl}/api/teams/session/api-archive-session/workbench`,
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      sessionId: string
      teamName: string
      source: string
      snapshots: Array<{ team: { name: string } }>
    }
    expect(body).toMatchObject({
      sessionId: 'api-archive-session',
      teamName: 'api-archive',
      source: 'archive',
    })
    expect(body.snapshots.at(-1)?.team.name).toBe('api-archive')
  })

  it('GET session workbench resolves the Team incarnation active at an Agent launch', async () => {
    const teamName = 'api-recreated-team'
    const sessionId = 'api-recreated-session'
    await writeTeamConfig(teamName, makeTeamConfig({
      name: teamName,
      leadSessionId: sessionId,
      createdAt: 1700000000000,
    }))
    const oldResponse = await fetch(`${baseUrl}/api/teams/${teamName}/workbench`)
    const oldSnapshot = (await oldResponse.json()) as TeamWorkbenchSnapshot
    await writeTeamConfig(teamName, makeTeamConfig({
      name: teamName,
      leadSessionId: sessionId,
      createdAt: 1800000000000,
    }))
    const newResponse = await fetch(`${baseUrl}/api/teams/${teamName}/workbench`)
    const newSnapshot = (await newResponse.json()) as TeamWorkbenchSnapshot
    await service.markWorkbenchArchiveDeleted(
      teamName,
      sessionId,
      oldSnapshot.team.incarnationId,
    )

    const response = await fetch(
      `${baseUrl}/api/teams/session/${sessionId}/workbench?teamName=${teamName}&at=1700000001000`,
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      incarnationId: oldSnapshot.team.incarnationId,
      source: 'archive',
    })
    expect(oldSnapshot.team.incarnationId).not.toBe(newSnapshot.team.incarnationId)
  })

  it('GET archived member transcript should use the lead session archive identity', async () => {
    await writeTeamConfig('api-archive-member', makeTeamConfig({
      name: 'api-archive-member',
      leadSessionId: 'api-archive-member-lead',
      members: [{
        agentId: 'worker@api-archive-member',
        name: 'worker',
        agentType: 'worker',
        joinedAt: 1700000001000,
        cwd: '/tmp/project',
        isActive: false,
      }],
    }))
    await writeTranscriptFile('-tmp-project', 'worker-root-session', [{
      type: 'assistant',
      uuid: 'worker-execution',
      teamName: 'api-archive-member',
      agentName: 'worker',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'src/index.ts' } }] },
      timestamp: '2026-08-08T00:00:00.000Z',
    }])
    expect((await fetch(`${baseUrl}/api/teams/api-archive-member/workbench`)).status).toBe(200)
    await fs.rm(path.join(tmpDir, 'teams', 'api-archive-member'), { recursive: true, force: true })

    const response = await fetch(
      `${baseUrl}/api/teams/api-archive-member/members/worker%40api-archive-member/transcript?incremental=true&leadSessionId=api-archive-member-lead`,
    )
    const body = (await response.json()) as { messages: Array<{ id: string }> }

    expect(response.status).toBe(200)
    expect(body.messages.map((message) => message.id)).toEqual(['worker-execution'])
  })

  it('GET /api/teams/:name should 404 for unknown team', async () => {
    const res = await fetch(`${baseUrl}/api/teams/nonexistent`)
    expect(res.status).toBe(404)
  })

  it('GET /api/teams/:name/members/:id/transcript should return messages', async () => {
    await writeTeamConfig('t-team', makeTeamConfig({ name: 't-team' }))

    await writeTranscriptFile('-tmp-project', 'session-lead-001', [
      {
        type: 'user',
        uuid: 'u1',
        message: { role: 'user', content: 'Hello' },
        timestamp: '2026-01-01T00:01:00.000Z',
      },
    ])

    const res = await fetch(
      `${baseUrl}/api/teams/t-team/members/agent-lead/transcript`,
    )
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      messages: Array<{ id: string; type: string }>
    }
    expect(body.messages).toHaveLength(1)
    expect(body.messages[0]!.type).toBe('user')
  })

  it('returns physical fragment owners on legacy and incremental transcript APIs', async () => {
    await writeTeamConfig('api-fragment-team', makeTeamConfig({
      name: 'api-fragment-team',
      leadSessionId: 'api-fragment-lead',
      members: [{
        agentId: 'worker@api-fragment-team',
        name: 'worker',
        agentType: 'worker',
        joinedAt: 1700000000000,
        cwd: '/tmp/project',
        isActive: false,
      }],
    }))
    await writeSubagentTranscriptFile(
      '-tmp-project',
      'api-fragment-lead',
      'agent-physical-worker.jsonl',
      [{
        type: 'assistant',
        agentName: 'worker',
        uuid: 'worker-message',
        message: { role: 'assistant', content: 'done' },
        timestamp: '2026-01-01T00:00:01.000Z',
      }],
    )

    const legacy = await fetch(
      `${baseUrl}/api/teams/api-fragment-team/members/worker%40api-fragment-team/transcript`,
    )
    const legacyBody = await legacy.json() as {
      messages: Array<{ id: string }>
      ownerAgentIds: string[]
    }
    expect(legacyBody.ownerAgentIds).toEqual(['physical-worker'])
    expect(legacyBody.messages.map(message => message.id)).toEqual([
      'physical-worker/worker-message',
    ])

    const incremental = await fetch(
      `${baseUrl}/api/teams/api-fragment-team/members/worker%40api-fragment-team/transcript?incremental=true`,
    )
    const incrementalBody = await incremental.json() as {
      ownerAgentIds: string[]
    }
    expect(incrementalBody.ownerAgentIds).toEqual(['physical-worker'])
  })

  it('returns task-notification deltas from XML and persisted meta entries', async () => {
    await writeTeamConfig(
      'notification-team',
      makeTeamConfig({ name: 'notification-team' }),
    )
    const transcriptPath = await writeTranscriptFile(
      '-tmp-project',
      'session-lead-001',
      [{
        type: 'user',
        uuid: 'xml-notification',
        message: {
          role: 'user',
          content: '<task-notification>\n<task-id>xml-task</task-id>\n<tool-use-id>xml-bash</tool-use-id>\n<status>completed</status>\n<summary>Build &amp; test completed</summary>\n<result>All green</result>\n<output-file>/tmp/xml.output</output-file>\n</task-notification>',
        },
        timestamp: '2026-01-01T00:01:00.000Z',
      }],
    )

    const initial = await fetch(
      `${baseUrl}/api/teams/notification-team/members/agent-lead/transcript?incremental=true`,
    )
    expect(initial.status).toBe(200)
    const initialBody = await initial.json() as {
      messages: Array<{ id: string }>
      taskNotifications: Array<Record<string, unknown>>
      signature: string
      cursor: string
      afterOrdinal: number
    }
    expect(initialBody.taskNotifications).toEqual([{
      taskId: 'xml-task',
      toolUseId: 'xml-bash',
      status: 'completed',
      summary: 'Build & test completed',
      result: 'All green',
      outputFile: '/tmp/xml.output',
      timestamp: '2026-01-01T00:01:00.000Z',
    }])

    const unchanged = await fetch(
      `${baseUrl}/api/teams/notification-team/members/agent-lead/transcript?incremental=true&signature=${encodeURIComponent(initialBody.signature)}&cursor=${encodeURIComponent(initialBody.cursor)}&afterOrdinal=${initialBody.afterOrdinal}`,
    )
    expect(await unchanged.json()).toMatchObject({
      messages: [],
      taskNotifications: [],
    })

    await fs.appendFile(transcriptPath, `${JSON.stringify({
      type: 'cc-haha-task-notification',
      isMeta: true,
      taskNotification: {
        taskId: 'persisted-task',
        toolUseId: 'persisted-bash',
        status: 'killed',
        summary: 'Process killed',
      },
      timestamp: '2026-01-01T00:02:00.000Z',
    })}\n`)
    const appended = await fetch(
      `${baseUrl}/api/teams/notification-team/members/agent-lead/transcript?incremental=true&signature=${encodeURIComponent(initialBody.signature)}&cursor=${encodeURIComponent(initialBody.cursor)}&afterOrdinal=${initialBody.afterOrdinal}`,
    )
    const appendedBody = await appended.json() as {
      messages: unknown[]
      taskNotifications: unknown[]
      reset?: boolean
    }
    expect(appendedBody.messages).toEqual([])
    expect(appendedBody.taskNotifications).toEqual([{
      taskId: 'persisted-task',
      toolUseId: 'persisted-bash',
      status: 'stopped',
      summary: 'Process killed',
      timestamp: '2026-01-01T00:02:00.000Z',
    }])
    expect(appendedBody.reset).toBeUndefined()

    const full = await fetch(
      `${baseUrl}/api/teams/notification-team/members/agent-lead/transcript`,
    )
    const fullBody = await full.json() as {
      taskNotifications: Array<{ toolUseId: string }>
    }
    expect(fullBody.taskNotifications.map(notification => notification.toolUseId)).toEqual([
      'xml-bash',
      'persisted-bash',
    ])
  })

  it('supports an additive transcript cursor while keeping the legacy full response additive', async () => {
    await writeTeamConfig('delta-team', makeTeamConfig({ name: 'delta-team' }))
    await writeTranscriptFile('-tmp-project', 'session-lead-001', [
      {
        type: 'user',
        uuid: 'u1',
        message: { role: 'user', content: 'First' },
        timestamp: '2026-01-01T00:01:00.000Z',
      },
      {
        type: 'assistant',
        uuid: 'a1',
        message: { role: 'assistant', content: 'Second' },
        timestamp: '2026-01-01T00:02:00.000Z',
      },
    ])

    const initial = await fetch(
      `${baseUrl}/api/teams/delta-team/members/agent-lead/transcript?incremental=true`,
    )
    const initialBody = (await initial.json()) as {
      messages: Array<{ id: string }>
      signature?: string
      cursor?: string
      afterOrdinal?: number
    }
    expect(initialBody.messages.map(message => message.id)).toEqual(['u1', 'a1'])
    expect(initialBody.signature).toBeString()
    expect(initialBody.cursor).toBeString()
    expect(initialBody.afterOrdinal).toBeNumber()

    const unchanged = await fetch(
      `${baseUrl}/api/teams/delta-team/members/agent-lead/transcript?incremental=true&signature=${encodeURIComponent(initialBody.signature!)}&afterOrdinal=${initialBody.afterOrdinal}`,
    )
    const unchangedBody = (await unchanged.json()) as {
      messages: unknown[]
      signature: string
      afterOrdinal: number
    }
    expect(unchangedBody).toMatchObject({
      messages: [],
      signature: initialBody.signature,
      afterOrdinal: initialBody.afterOrdinal,
    })
    expect((unchangedBody as { cursor?: string }).cursor).toBeString()

    await fs.appendFile(
      path.join(tmpDir, 'projects', '-tmp-project', 'session-lead-001.jsonl'),
      `${JSON.stringify({
        type: 'user',
        uuid: 'u2',
        message: { role: 'user', content: 'Third' },
        timestamp: '2026-01-01T00:03:00.000Z',
      })}\n`,
    )
    const appended = await fetch(
      `${baseUrl}/api/teams/delta-team/members/agent-lead/transcript?incremental=true&signature=${encodeURIComponent(initialBody.signature!)}&cursor=${encodeURIComponent(initialBody.cursor!)}&afterOrdinal=${initialBody.afterOrdinal}`,
    )
    const appendedBody = (await appended.json()) as {
      messages: Array<{ id: string }>
      signature: string
      cursor: string
      afterOrdinal: number
      reset?: boolean
    }
    expect(appendedBody.messages.map(message => message.id)).toEqual(['u2'])
    expect(appendedBody.afterOrdinal).toBe(2)
    expect(appendedBody.reset).toBeUndefined()

    const transcriptPath = path.join(
      tmpDir,
      'projects',
      '-tmp-project',
      'session-lead-001.jsonl',
    )
    const beforeRewrite = await fs.stat(transcriptPath)
    const rewritten = [
      { type: 'user', uuid: 'x1', message: { role: 'user', content: 'Furst' }, timestamp: '2026-01-01T00:01:00.000Z' },
      { type: 'assistant', uuid: 'b1', message: { role: 'assistant', content: 'Secand' }, timestamp: '2026-01-01T00:02:00.000Z' },
      { type: 'user', uuid: 'x2', message: { role: 'user', content: 'Thurd' }, timestamp: '2026-01-01T00:03:00.000Z' },
    ].map(entry => JSON.stringify(entry)).join('\n') + '\n'
    await fs.writeFile(transcriptPath, rewritten)
    expect((await fs.stat(transcriptPath)).size).toBe(beforeRewrite.size)
    await fs.utimes(transcriptPath, beforeRewrite.atime, beforeRewrite.mtime)

    const rewrittenResponse = await fetch(
      `${baseUrl}/api/teams/delta-team/members/agent-lead/transcript?incremental=true&signature=${encodeURIComponent(appendedBody.signature)}&cursor=${encodeURIComponent(appendedBody.cursor)}&afterOrdinal=${appendedBody.afterOrdinal}`,
    )
    const rewrittenBody = (await rewrittenResponse.json()) as {
      messages: Array<{ id: string }>
      reset?: boolean
    }
    expect(rewrittenBody.reset).toBe(true)
    expect(rewrittenBody.messages.map(message => message.id)).toEqual(['x1', 'b1', 'x2'])

    const legacy = await fetch(
      `${baseUrl}/api/teams/delta-team/members/agent-lead/transcript`,
    )
    const legacyBody = (await legacy.json()) as {
      messages: Array<{ id: string }>
      ownerAgentIds: string[]
      taskNotifications: unknown[]
      taskAnchors: unknown[]
    }
    // This route hand-picks its fields, so anything the page gains has to be
    // added here on purpose. Growing the set is additive; losing one is not.
    expect(Object.keys(legacyBody).sort()).toEqual([
      'messages',
      'ownerAgentIds',
      'taskAnchors',
      'taskNotifications',
    ])
    expect(legacyBody.ownerAgentIds).toEqual([])
    expect(legacyBody.messages.map(message => message.id)).toEqual(['x1', 'b1', 'x2'])
    expect(legacyBody.taskNotifications).toEqual([])
    expect(legacyBody.taskAnchors).toEqual([])
  })

  it('GET /api/teams/:name/members/:id/transcript should 404 for unknown member', async () => {
    await writeTeamConfig('t2-team', makeTeamConfig({ name: 't2-team' }))

    const res = await fetch(
      `${baseUrl}/api/teams/t2-team/members/unknown-agent/transcript`,
    )
    expect(res.status).toBe(404)
  })

  it('POST /api/teams/:name/members/:id/messages should enqueue a mailbox message', async () => {
    await writeTeamConfig('send-team', makeTeamConfig({ name: 'send-team' }))

    const res = await fetch(
      `${baseUrl}/api/teams/send-team/members/agent-worker/messages`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Please continue with the failing test' }),
      },
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean }
    expect(body.ok).toBe(true)

    const rawInbox = await fs.readFile(
      path.join(tmpDir, 'teams', 'send-team', 'inboxes', 'Worker-Agent.json'),
      'utf-8',
    )
    const inbox = JSON.parse(rawInbox) as Array<{ text: string }>
    expect(inbox.at(-1)?.text).toBe('Please continue with the failing test')
  })

  it('DELETE /api/teams/:name should delete team', async () => {
    const config = makeTeamConfig({ name: 'del-team' })
    config.members = config.members.filter(
      member => member.agentId === config.leadAgentId,
    )
    config.members[0]!.isActive = false
    await writeTeamConfig('del-team', config)

    const res = await fetch(`${baseUrl}/api/teams/del-team`, {
      method: 'DELETE',
    })
    expect(res.status).toBe(200)

    const body = (await res.json()) as { ok: boolean }
    expect(body.ok).toBe(true)

    // Verify it's gone
    const res2 = await fetch(`${baseUrl}/api/teams/del-team`)
    expect(res2.status).toBe(404)
  })

  it('DELETE /api/teams/:name should 409 when an idle teammate remains registered', async () => {
    const config = makeTeamConfig({ name: 'active' })
    for (const member of config.members) member.isActive = false
    await writeTeamConfig('active', config)

    const res = await fetch(`${baseUrl}/api/teams/active`, {
      method: 'DELETE',
    })
    expect(res.status).toBe(409)
  })

  it('DELETE /api/teams/:name should 409 for a lead-only active Team', async () => {
    const config = makeTeamConfig({ name: 'active-lead' })
    config.members = config.members.filter(
      member => member.agentId === config.leadAgentId,
    )
    await writeTeamConfig('active-lead', config)

    const res = await fetch(`${baseUrl}/api/teams/active-lead`, {
      method: 'DELETE',
    })
    expect(res.status).toBe(409)
  })

  it('POST /api/teams should return 405', async () => {
    const res = await fetch(`${baseUrl}/api/teams`, { method: 'POST' })
    expect(res.status).toBe(405)
  })
})
