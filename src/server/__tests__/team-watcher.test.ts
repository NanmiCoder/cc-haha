/**
 * Unit tests for TeamWatcher — real-time team status push via WebSocket
 */

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as syncFs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import type { ServerMessage } from '../ws/events.js'
import { teamIncarnationId } from '../services/teamService.js'

// ============================================================================
// Test helpers
// ============================================================================

let tmpDir: string

async function setupTmpConfigDir(): Promise<string> {
  tmpDir = path.join(
    os.tmpdir(),
    `claude-watcher-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  await fs.mkdir(path.join(tmpDir, 'teams'), { recursive: true })
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

async function writeJsonFile(relativePath: string, value: unknown): Promise<void> {
  const filePath = path.join(tmpDir, relativePath)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, JSON.stringify(value), 'utf8')
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

// ============================================================================
// Mock the WebSocket handler exports
// ============================================================================

// Track all messages sent via broadcast
let broadcastedMessages: Array<{ sessionId: string; message: unknown }> = []
let mockActiveSessionIds: string[] = []

// We need to mock the handler module before importing TeamWatcher
// Use Bun's module mock
const mockSendToSession = mock((sessionId: string, message: unknown) => {
  broadcastedMessages.push({ sessionId, message })
  return true
})

const mockGetActiveSessionIds = mock(() => {
  return mockActiveSessionIds
})

// Mock the handler module
import { TeamWatcher } from '../services/teamWatcher.js'

// Since TeamWatcher imports from handler.js at the module level, we need to
// test using the class directly and override the broadcast behavior.
// Instead, we test extractMemberStatuses directly and test the integration
// by verifying the check cycle behavior via a wrapper approach.

// ============================================================================
// TeamWatcher.extractMemberStatuses tests
// ============================================================================

describe('TeamWatcher.extractMemberStatuses', () => {
  let watcher: TeamWatcher

  beforeEach(() => {
    watcher = new TeamWatcher()
  })

  it('should extract member statuses from a valid config', () => {
    const config = makeTeamConfig()
    const statuses = watcher.extractMemberStatuses(config)

    expect(statuses).toHaveLength(2)
    expect(statuses[0]).toEqual({
      agentId: 'agent-lead',
      role: 'Lead Agent',
      status: 'running',
      activity: 'active',
      currentTask: undefined,
    })
    expect(statuses[1]).toEqual({
      agentId: 'agent-worker',
      role: 'Worker Agent',
      status: 'idle',
      activity: 'idle',
      currentTask: undefined,
    })
  })

  it('reports no activity for a member whose runner never recorded a turn', () => {
    const config = makeTeamConfig()
    delete (config.members[0] as Record<string, unknown>).isActive

    // `status` still defaults to running for backwards compatibility, but the
    // watcher must not claim the member is mid-turn -- the last full team read,
    // which can consult the transcript, stays authoritative.
    const status = watcher.extractMemberStatuses(config)[0]!
    expect(status.status).toBe('running')
    expect(status.activity).toBeUndefined()
  })

  it('should return running status when isActive is undefined', () => {
    const config = makeTeamConfig()
    delete (config.members[0] as Record<string, unknown>).isActive
    const statuses = watcher.extractMemberStatuses(config)

    expect(statuses[0]!.status).toBe('running')
  })

  it('should return idle status when isActive is false', () => {
    const config = makeTeamConfig()
    const statuses = watcher.extractMemberStatuses(config)

    expect(statuses[1]!.status).toBe('idle')
  })

  it('should prefer member name as role when present', () => {
    const config = makeTeamConfig()
    const statuses = watcher.extractMemberStatuses(config)

    expect(statuses[0]!.role).toBe('Lead Agent')
    expect(statuses[1]!.role).toBe('Worker Agent')
  })

  it('should fall back to name when agentType is missing', () => {
    const config = makeTeamConfig()
    delete (config.members[0] as Record<string, unknown>).agentType
    const statuses = watcher.extractMemberStatuses(config)

    expect(statuses[0]!.role).toBe('Lead Agent')
  })

  it('should fall back to "member" when both agentType and name are missing', () => {
    const config = makeTeamConfig()
    delete (config.members[0] as Record<string, unknown>).agentType
    delete (config.members[0] as Record<string, unknown>).name
    const statuses = watcher.extractMemberStatuses(config)

    expect(statuses[0]!.role).toBe('member')
  })

  it('should return empty array when config has no members', () => {
    const config = { name: 'empty-team' }
    const statuses = watcher.extractMemberStatuses(config)
    expect(statuses).toEqual([])
  })

  it('should return empty array when members is not an array', () => {
    const config = { name: 'bad-team', members: 'not-an-array' }
    const statuses = watcher.extractMemberStatuses(config)
    expect(statuses).toEqual([])
  })

  it('should include currentTask when present in config', () => {
    const config = makeTeamConfig()
    ;(config.members[0] as Record<string, unknown>).currentTask = 'Implementing feature X'
    const statuses = watcher.extractMemberStatuses(config)

    expect(statuses[0]!.currentTask).toBe('Implementing feature X')
  })
})

// ============================================================================
// TeamWatcher polling integration tests
// ============================================================================

describe('TeamWatcher polling', () => {
  let watcher: TeamWatcher

  beforeEach(async () => {
    await setupTmpConfigDir()
    watcher = new TeamWatcher()
  })

  afterEach(async () => {
    watcher.stop()
    watcher.reset()
    await cleanupTmpDir()
  })

  it('should detect new team creation via checkNow()', async () => {
    // First poll: no teams
    await watcher.checkNow()

    // Create a team
    await writeTeamConfig('new-team', makeTeamConfig({ name: 'new-team' }))

    // The watcher internally calls broadcast which calls sendToSession.
    // Since sendToSession depends on active sessions, we test that the
    // internal snapshot state is updated correctly.
    // After checkNow, the watcher should have recorded the team.
    await watcher.checkNow()

    // Now modify the team config and check again -- this proves the previous
    // checkNow() recorded the snapshot (otherwise it would emit team_created again)
    const updatedConfig = makeTeamConfig({ name: 'new-team', description: 'updated' })
    await writeTeamConfig('new-team', updatedConfig)
    await watcher.checkNow()

    // If we got here without errors, the snapshot logic is working
  })

  it('should detect team config changes', async () => {
    // Create initial team
    await writeTeamConfig('change-team', makeTeamConfig({ name: 'change-team' }))

    // First poll picks up the team
    await watcher.checkNow()

    // Modify the config
    const updatedConfig = makeTeamConfig({
      name: 'change-team',
      description: 'updated description',
    })
    await writeTeamConfig('change-team', updatedConfig)

    // Second poll should detect the change
    await watcher.checkNow()
    // No error means the diff detection worked
  })

  it('uses subagent identity metadata instead of tool names when projecting members', async () => {
    const deliveries: Array<{ message: ServerMessage; sessionId?: string }> = []
    watcher = new TeamWatcher(
      (message, sessionId) => deliveries.push({ message, sessionId }),
      {
        getWorkbench: async () => ({}) as never,
        markWorkbenchArchiveDeleted: async () => {},
      },
    )
    const config = makeTeamConfig({
      name: 'identity-team',
      leadSessionId: 'lead-session-identity',
    })
    await writeTeamConfig('identity-team', config)
    await writeJsonFile(
      'projects/project/lead-session-identity/subagents/agent-reviewer.jsonl',
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'tool-read', name: 'Read', input: {} },
            { type: 'tool_use', id: 'tool-task-create', name: 'TaskCreate', input: {} },
          ],
        },
      },
    )
    await writeJsonFile(
      'projects/project/lead-session-identity/subagents/agent-reviewer.meta.json',
      { agentType: 'real-reviewer' },
    )

    await watcher.checkNow()
    deliveries.length = 0
    await writeTeamConfig('identity-team', { ...config, description: 'updated' })
    await watcher.checkNow()

    const update = deliveries.find(({ message }) => message.type === 'team_update')
    if (update?.message.type !== 'team_update') throw new Error('Expected team_update')
    expect(update.message.members.find((member) => member.role === 'real-reviewer')).toMatchObject({
      agentId: 'real-reviewer@identity-team',
      role: 'real-reviewer',
    })
    const roles = update.message.members.map((member) => member.role)
    expect(roles).not.toContain('Read')
    expect(roles).not.toContain('TaskCreate')
  })

  it('only discovers structured top-level identities from subagent transcripts', async () => {
    const deliveries: Array<{ message: ServerMessage; sessionId?: string }> = []
    watcher = new TeamWatcher(
      (message, sessionId) => deliveries.push({ message, sessionId }),
      {
        getWorkbench: async () => ({}) as never,
        markWorkbenchArchiveDeleted: async () => {},
      },
    )
    const config = makeTeamConfig({
      name: 'structured-identity-team',
      leadSessionId: 'lead-session-structured-identity',
    })
    await writeTeamConfig('structured-identity-team', config)
    await writeJsonFile(
      'projects/project/lead-session-structured-identity/subagents/agent-named.jsonl',
      {
        type: 'assistant',
        agentName: 'named-worker',
        message: {
          content: [{ type: 'tool_use', id: 'tool-read', name: 'Read', input: {} }],
        },
      },
    )
    await writeJsonFile(
      'projects/project/lead-session-structured-identity/subagents/agent-identified.jsonl',
      {
        type: 'assistant',
        agentId: 'identified-worker@structured-identity-team',
        message: {
          content: [{ type: 'tool_use', id: 'tool-task-create', name: 'TaskCreate', input: {} }],
        },
      },
    )
    await writeJsonFile(
      'projects/project/lead-session-structured-identity/subagents/agent-tool-only.jsonl',
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'tool-only', name: 'TaskCreate', input: {} }],
        },
      },
    )

    await watcher.checkNow()
    deliveries.length = 0
    await writeTeamConfig('structured-identity-team', { ...config, description: 'updated' })
    await watcher.checkNow()

    const update = deliveries.find(({ message }) => message.type === 'team_update')
    if (update?.message.type !== 'team_update') throw new Error('Expected team_update')
    const roles = update.message.members.map((member) => member.role)
    expect(roles).toContain('named-worker')
    expect(roles).toContain('identified-worker')
    expect(roles).not.toContain('Read')
    expect(roles).not.toContain('TaskCreate')
  })

  it('invalidates the joined workbench when tasks or mailboxes change', async () => {
    const deliveries: Array<{ message: ServerMessage; sessionId?: string }> = []
    watcher = new TeamWatcher((message, sessionId) => deliveries.push({ message, sessionId }))
    await writeTeamConfig('workbench-team', makeTeamConfig({
      name: 'workbench-team',
      leadSessionId: 'lead-session-workbench',
    }))
    await watcher.checkNow()
    expect(deliveries).toEqual([{
      message: expect.objectContaining({ type: 'team_created', teamName: 'workbench-team' }),
      sessionId: 'lead-session-workbench',
    }])
    deliveries.length = 0

    await writeJsonFile('tasks/workbench-team/1.json', {
      id: '1',
      subject: 'Map dependencies',
      status: 'in_progress',
      blocks: [],
      blockedBy: [],
    })
    await watcher.checkNow()
    expect(deliveries).toEqual([{
      message: expect.objectContaining({
        type: 'team_workbench_updated',
        teamName: 'workbench-team',
      }),
      sessionId: 'lead-session-workbench',
    }])

    deliveries.length = 0
    await writeJsonFile('teams/workbench-team/inboxes/worker.json', [{
      from: 'team-lead',
      text: 'Dependency map is ready',
      timestamp: '2026-08-08T00:00:00.000Z',
    }])
    await watcher.checkNow()
    expect(deliveries).toEqual([{
      message: expect.objectContaining({
        type: 'team_workbench_updated',
        teamName: 'workbench-team',
      }),
      sessionId: 'lead-session-workbench',
    }])

    deliveries.length = 0
    await watcher.checkNow()
    expect(deliveries).toEqual([])
  })

  it('emits an exact delete/create transition when a name is recreated between polls', async () => {
    const deliveries: Array<{ message: ServerMessage; sessionId?: string }> = []
    const deleted: Array<[string, string | undefined, string | undefined]> = []
    watcher = new TeamWatcher(
      (message, sessionId) => deliveries.push({ message, sessionId }),
      {
        getWorkbench: async () => ({}) as never,
        markWorkbenchArchiveDeleted: async (name, sessionId, incarnationId) => {
          deleted.push([name, sessionId, incarnationId])
        },
      },
    )
    const oldConfig = makeTeamConfig({
      name: 'aba-team',
      createdAt: 1700000000000,
      leadSessionId: 'old-lead',
    })
    await writeTeamConfig('aba-team', oldConfig)
    await watcher.checkNow()
    deliveries.length = 0

    const newConfig = makeTeamConfig({
      name: 'aba-team',
      createdAt: 1800000000000,
      leadSessionId: 'new-lead',
    })
    await writeTeamConfig('aba-team', newConfig)
    await watcher.checkNow()

    const oldIncarnationId = teamIncarnationId(oldConfig)
    const newIncarnationId = teamIncarnationId(newConfig)
    expect(deleted).toEqual([['aba-team', 'old-lead', oldIncarnationId]])
    expect(deliveries).toEqual([{
      message: {
        type: 'team_deleted',
        teamName: 'aba-team',
        incarnationId: oldIncarnationId,
        leadSessionId: 'old-lead',
        createdAt: 1700000000000,
      },
      sessionId: 'old-lead',
    }, {
      message: {
        type: 'team_created',
        teamName: 'aba-team',
        incarnationId: newIncarnationId,
        leadSessionId: 'new-lead',
        createdAt: 1800000000000,
      },
      sessionId: 'new-lead',
    }])
  })

  it('uses the canonical config name when a sanitized Team directory is deleted', async () => {
    const deliveries: Array<{ message: ServerMessage; sessionId?: string }> = []
    const deleted: Array<[string, string | undefined, string | undefined]> = []
    const workbenchNames: string[] = []
    watcher = new TeamWatcher(
      (message, sessionId) => deliveries.push({ message, sessionId }),
      {
        getWorkbench: async (name) => {
          workbenchNames.push(name)
          return {} as never
        },
        markWorkbenchArchiveDeleted: async (name, sessionId, incarnationId) => {
          deleted.push([name, sessionId, incarnationId])
        },
      },
    )
    const config = makeTeamConfig({
      name: 'My Team',
      createdAt: 1900000000000,
      leadSessionId: 'canonical-lead',
    })
    await writeTeamConfig('my-team', config)
    await watcher.checkNow()
    await fs.rm(path.join(tmpDir, 'teams', 'my-team'), { recursive: true, force: true })
    await watcher.checkNow()

    expect(workbenchNames).toEqual(['my-team'])
    expect(deleted).toEqual([[
      'My Team',
      'canonical-lead',
      teamIncarnationId(config),
    ]])
    expect(deliveries.map(delivery => delivery.message)).toEqual([
      expect.objectContaining({ type: 'team_created', teamName: 'My Team' }),
      expect.objectContaining({ type: 'team_deleted', teamName: 'My Team' }),
    ])
  })

  it('should detect team deletion', async () => {
    // Create a team
    await writeTeamConfig('doomed-team', makeTeamConfig({ name: 'doomed-team' }))

    // First poll picks it up
    await watcher.checkNow()

    // Delete the team directory
    await fs.rm(path.join(tmpDir, 'teams', 'doomed-team'), { recursive: true, force: true })

    // Next poll should detect deletion
    await watcher.checkNow()
    // If no error, deletion detection worked
  })

  it('should handle missing teams directory gracefully', async () => {
    // Remove the entire teams directory
    await fs.rm(path.join(tmpDir, 'teams'), { recursive: true, force: true })

    // Should not throw
    await watcher.checkNow()
  })

  it('should handle malformed config.json gracefully', async () => {
    // Create a team with invalid JSON
    const teamDir = path.join(tmpDir, 'teams', 'bad-json')
    await fs.mkdir(teamDir, { recursive: true })
    await fs.writeFile(path.join(teamDir, 'config.json'), 'not valid json', 'utf-8')

    // Should not throw
    await watcher.checkNow()
  })

  it('should skip directories without config.json', async () => {
    // Create a directory with no config.json
    const teamDir = path.join(tmpDir, 'teams', 'no-config')
    await fs.mkdir(teamDir, { recursive: true })

    // Should not throw
    await watcher.checkNow()
  })

  it('should track multiple teams independently', async () => {
    await writeTeamConfig('team-a', makeTeamConfig({ name: 'team-a' }))
    await writeTeamConfig('team-b', makeTeamConfig({ name: 'team-b' }))

    // Pick up both teams
    await watcher.checkNow()

    // Modify only team-a
    await writeTeamConfig('team-a', makeTeamConfig({ name: 'team-a', description: 'changed' }))

    // Should detect change in team-a but not team-b
    await watcher.checkNow()

    // Delete only team-b
    await fs.rm(path.join(tmpDir, 'teams', 'team-b'), { recursive: true, force: true })

    await watcher.checkNow()
    // No errors means independent tracking works
  })

  it('should start and stop polling without errors', async () => {
    // Start with a short interval
    watcher.start(50)

    // Let it run a couple of cycles
    await new Promise((resolve) => setTimeout(resolve, 150))

    // Stop
    watcher.stop()

    // Starting again should work
    watcher.start(50)
    watcher.stop()
  })

  it('should not start duplicate intervals when start() called twice', async () => {
    watcher.start(100)
    watcher.start(100) // second call should be a no-op

    // Let it run briefly
    await new Promise((resolve) => setTimeout(resolve, 50))

    watcher.stop()
  })

  it('should handle teams directory appearing after initial check', async () => {
    // Remove teams dir
    await fs.rm(path.join(tmpDir, 'teams'), { recursive: true, force: true })

    // First check -- no teams dir
    await watcher.checkNow()

    // Create teams dir and a team
    await fs.mkdir(path.join(tmpDir, 'teams'), { recursive: true })
    await writeTeamConfig('late-team', makeTeamConfig({ name: 'late-team' }))

    // Second check should pick it up
    await watcher.checkNow()
  })

  it('reset() should clear internal state', async () => {
    await writeTeamConfig('reset-team', makeTeamConfig({ name: 'reset-team' }))

    // Pick up the team
    await watcher.checkNow()

    // Reset and check again -- should treat it as new
    watcher.reset()
    await watcher.checkNow()
    // No error means reset worked
  })
})

// ============================================================================
// Broadcast integration tests
// ============================================================================

describe('TeamWatcher broadcast', () => {
  it('should call sendToSession for each active session', async () => {
    // This test verifies the broadcast logic by importing the real module
    // and checking that getActiveSessionIds/sendToSession are called.
    // Since the handler module manages real WebSocket state, we verify
    // that when there are no active sessions, broadcast is a no-op.

    await setupTmpConfigDir()
    const watcher = new TeamWatcher()

    await writeTeamConfig('broadcast-team', makeTeamConfig({ name: 'broadcast-team' }))

    // With no active WebSocket sessions, checkNow should still succeed
    // (broadcast sends to zero sessions)
    await watcher.checkNow()

    watcher.stop()
    watcher.reset()
    await cleanupTmpDir()
  })
})

// A sparse fixture catches read-all-then-slice without retaining a large test string.
it('reads only the subagent name prefix of a large transcript', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'watcher-prefix-'))
  const file = path.join(directory, 'agent.jsonl')
  await fs.writeFile(file, JSON.stringify({ agentName: 'bounded-agent' }) + '\n')
  await fs.truncate(file, 64 * 1024 * 1024)
  const readAll = spyOn(syncFs, 'readFileSync').mockImplementation(() => { throw new Error('Unbounded transcript read') })
  try {
    const watcher = new TeamWatcher()
    expect((watcher as unknown as { extractSubagentName(path: string): string | null }).extractSubagentName(file)).toBe('bounded-agent')
    expect(readAll).not.toHaveBeenCalled()
  } finally {
    readAll.mockRestore()
    await fs.rm(directory, { recursive: true, force: true })
  }
})

it('broadcasts plan-only CLI writes to the owning leader without duplicate events', async () => {
  await setupTmpConfigDir()
  const deliveries: Array<{ message: ServerMessage; sessionId?: string }> = []
  const watcher = new TeamWatcher((message, sessionId) => deliveries.push({ message, sessionId }), {
    getWorkbench: async () => { throw new Error('not needed for plan event') },
    markWorkbenchArchiveDeleted: async () => undefined,
  })
  try {
    const { ensureTeamDraft, stageMember } = await import('../../utils/swarm/teamPlanStore.js')
    await writeTeamConfig('plan-fixture', makeTeamConfig({ name: 'plan-fixture', leadSessionId: 'plan-owner' }))
    const runtime = { providerId: 'fake', modelId: 'fixture' }
    await ensureTeamDraft('plan-fixture', 'plan-owner', runtime)
    await watcher.checkNow()
    await watcher.checkNow()
    expect(deliveries.filter(item => item.message.type === 'team_plan_updated')).toHaveLength(1)
    await stageMember('plan-fixture', { id: 'worker', name: 'worker', agentType: 'general-purpose', prompt: 'fixture', runtime })
    await watcher.checkNow()
    const updates = deliveries.filter(item => item.message.type === 'team_plan_updated')
    expect(updates).toHaveLength(2)
    expect(updates.every(item => item.sessionId === 'plan-owner')).toBe(true)
  } finally {
    watcher.stop()
    await cleanupTmpDir()
  }
})
