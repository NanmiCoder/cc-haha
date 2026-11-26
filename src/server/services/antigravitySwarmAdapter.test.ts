import { afterEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  antigravitySwarmTeamName,
  deriveSwarmMemberState,
  extractBoardMentions,
  formatAntigravitySwarmSteerPrompt,
  isAntigravitySwarmTeamName,
  nativeSessionIdFromSwarmTeamName,
  readAntigravitySwarmMemberTranscriptPage,
  readAntigravitySwarmSnapshot,
  readAntigravitySwarmTimeline,
  registerAntigravitySwarmSteerHandler,
  sendAntigravitySwarmMemberMessage,
  type AntigravitySwarmSteerPayload,
} from './antigravitySwarmAdapter.js'

const tempDirs: string[] = []
let disposeHandler: (() => void) | null = null

async function makeTempAppDataDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-swarm-adapter-test-'))
  tempDirs.push(dir)
  return dir
}

async function writeBrainFile(
  appDataDir: string,
  conversationId: string,
  relPath: string,
  content: string,
): Promise<string> {
  const fullPath = path.join(appDataDir, 'brain', conversationId, relPath)
  await fs.mkdir(path.dirname(fullPath), { recursive: true })
  await fs.writeFile(fullPath, content, 'utf8')
  return fullPath
}

afterEach(async () => {
  disposeHandler?.()
  disposeHandler = null
  registerAntigravitySwarmSteerHandler(null)
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    await fs.rm(dir, { recursive: true, force: true })
  }
})

/** Golden fixture matching Phase 0 probe `task3_swarm`. */
async function seedPhase0SwarmFixture(
  appDataDir: string,
  options: {
    nativeSessionId?: string
    workerConvId?: string
    readerKilled?: boolean
    includePlan?: boolean
  } = {},
): Promise<{ nativeSessionId: string; workerConvId: string; teamName: string }> {
  const nativeSessionId = options.nativeSessionId ?? '0679f85e-556a-45da-82fa-d22c2c16206a'
  const workerConvId = options.workerConvId ?? '4556868f-98b1-4991-a306-a461603b967b'
  const readerKilled = options.readerKilled ?? true

  await writeBrainFile(
    appDataDir,
    nativeSessionId,
    '.system_generated/swarm/swarm.json',
    JSON.stringify({
      version: 1,
      backend: 'local',
      swarm_id: nativeSessionId,
      created_at: '2026-11-26T09:33:47Z',
    }),
  )

  await writeBrainFile(
    appDataDir,
    nativeSessionId,
    '.system_generated/swarm/members.json',
    JSON.stringify({
      title: 'Read note.txt',
      members: {
        coordinator: {
          conversation_id: nativeSessionId,
          role: 'coordinator',
          desired_state: 'RUNNING',
          desired_model: 'gemini-3.8-flash-low',
          applied_model: 'gemini-3.8-flash-low',
          workspace_mode: 'inherit',
          phase: 'RUNNING',
          wake_mode: 'mentions',
          wait_since: 2,
          last_read_seq: 2,
          last_nudged_seq: 2,
          last_park_blocked_seq: 0,
          killed: false,
          model: 'gemini-3.8-flash-low',
        },
        reader: {
          conversation_id: workerConvId,
          role: 'worker',
          desired_state: readerKilled ? 'KILLED' : 'RUNNING',
          desired_model: 'gemini-3.8-flash-low',
          applied_model: 'gemini-3.8-flash-low',
          workspace_mode: 'inherit',
          phase: readerKilled ? 'KILLED' : 'RUNNING',
          wake_mode: 'working',
          wait_since: 2,
          last_read_seq: 2,
          last_nudged_seq: 2,
          last_park_blocked_seq: 0,
          killed: readerKilled,
          model: 'gemini-3.8-flash-low',
        },
      },
    }),
  )

  await writeBrainFile(
    appDataDir,
    nativeSessionId,
    '.system_generated/swarm/board.jsonl',
    [
      JSON.stringify({
        seq: 1,
        agent: 'coordinator',
        text: '@reader Read /tmp/agy-p3-L6PrnN/note.txt and post "@coordinator [done] <content>" to the board.',
        time: '2026-11-26 01:33:47',
        kind: 'brief',
        request_id: '8b729351-866e-49f3-aec5-0562d775d08a',
      }),
      JSON.stringify({
        seq: 2,
        agent: 'reader',
        text: '@coordinator [done] SWARM_SECRET_42',
        time: '2026-11-26 01:33:53',
        request_id: '9d7464ec-bd8f-4774-94e4-9223d3c6041d',
      }),
    ].join('\n') + '\n',
  )

  await writeBrainFile(
    appDataDir,
    nativeSessionId,
    `.system_generated/subagents/${workerConvId}.json`,
    JSON.stringify({
      conversationId: workerConvId,
      subagentDescriptor: { typeName: 'worker', role: 'Swarm Worker (reader)' },
      state: readerKilled ? 'SUBAGENT_STATE_KILLED' : 'SUBAGENT_STATE_ALIVE',
      spawnStepIndex: 5,
      workspaceUris: ['file:///tmp/agy-p3-L6PrnN'],
    }),
  )

  await writeBrainFile(
    appDataDir,
    workerConvId,
    '.system_generated/logs/transcript.jsonl',
    [
      {
        step_index: 0,
        source: 'SYSTEM',
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        created_at: '2026-11-26T09:33:47Z',
        content:
          '<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-26T09:33:47Z sender=system priority=MESSAGE_PRIORITY_HIGH content=[swarm] new board message #1\n</SYSTEM_MESSAGE>',
      },
      {
        step_index: 1,
        source: 'SYSTEM',
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        created_at: '2026-11-26T09:33:47Z',
        content:
          '<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-26T09:33:47Z sender=0679f85e-556a-45da-82fa-d22c2c16206a priority=MESSAGE_PRIORITY_HIGH content=You have just started. Your assignment (recorded on the board as #1 for @reader):\n\nRead /tmp/agy-p3-L6PrnN/note.txt\n</SYSTEM_MESSAGE>',
      },
      {
        step_index: 2,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-26T09:33:47Z',
        model: 'gemini-3.8-flash-low',
        input_tokens: 21700,
        cache_read_tokens: 0,
        output_tokens: 63,
        tool_calls: [{ name: 'read_file', args: { Path: '"/tmp/agy-p3-L6PrnN/note.txt"' } }],
      },
      {
        step_index: 3,
        source: 'MODEL',
        type: 'GENERIC',
        status: 'DONE',
        created_at: '2026-11-26T09:33:50Z',
        content: 'Showing lines 1-1 of 1\n1: SWARM_SECRET_42',
      },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n',
  )

  if (options.includePlan) {
    await writeBrainFile(
      appDataDir,
      nativeSessionId,
      '.system_generated/swarm/plan.json',
      JSON.stringify({
        tasks: [
          {
            id: '1',
            subject: 'Read secret note',
            description: 'Read note.txt and report secret',
            status: 'done',
            owner: 'reader',
            blocks: ['2'],
          },
          {
            id: '2',
            title: 'Verify result',
            status: 'in_progress',
            assignee: 'coordinator',
            blocked_by: ['1'],
          },
        ],
      }),
    )
  }

  return {
    nativeSessionId,
    workerConvId,
    teamName: antigravitySwarmTeamName(nativeSessionId),
  }
}

describe('antigravitySwarmAdapter', () => {
  it('encodes and validates swarm team names safely', () => {
    const teamName = antigravitySwarmTeamName('0679f85e-556a-45da-82fa-d22c2c16206a')
    expect(isAntigravitySwarmTeamName(teamName)).toBe(true)
    expect(nativeSessionIdFromSwarmTeamName(teamName)).toBe('0679f85e-556a-45da-82fa-d22c2c16206a')
    expect(isAntigravitySwarmTeamName('regular-team')).toBe(false)
    expect(isAntigravitySwarmTeamName('agy-swarm-../escape')).toBe(false)
  })

  it('maps Antigravity member phases and wake_modes to cc-haha status and activity', () => {
    expect(deriveSwarmMemberState({ phase: 'RUNNING', wake_mode: 'working', killed: false }))
      .toEqual({ status: 'running', activity: 'active' })
    expect(deriveSwarmMemberState({ phase: 'RUNNING', wake_mode: 'mentions', killed: false }))
      .toEqual({ status: 'idle', activity: 'idle' })
    expect(deriveSwarmMemberState({ phase: 'WAITING', killed: false }))
      .toEqual({ status: 'idle', activity: 'idle' })
    expect(deriveSwarmMemberState({ phase: 'STOPPED', killed: false }))
      .toEqual({ status: 'idle', activity: 'stopped' })
    expect(deriveSwarmMemberState({ phase: 'KILLED', killed: true }))
      .toEqual({ status: 'completed', activity: 'exited' })
    expect(deriveSwarmMemberState({ phase: 'FAILED', killed: false }))
      .toEqual({ status: 'failed', activity: 'exited' })
  })

  it('extracts @mentions, @all broadcasts, and multi-recipient board posts', () => {
    const roster = new Set(['coordinator', 'reader', 'verifier'])
    expect(extractBoardMentions('@reader please check note.txt', roster, 'coordinator')).toEqual({
      to: 'reader',
      recipients: ['reader'],
      kind: 'direct',
    })
    expect(extractBoardMentions('@reader @verifier sync up', roster, 'coordinator')).toEqual({
      to: '*',
      recipients: ['reader', 'verifier'],
      kind: 'broadcast',
    })
    expect(extractBoardMentions('@all stop editing', roster, 'coordinator')).toEqual({
      to: '*',
      recipients: ['reader', 'verifier'],
      kind: 'broadcast',
    })
    // Should ignore email addresses
    expect(extractBoardMentions('contact dev@reader.com for info', roster, 'coordinator')).toEqual({
      to: '*',
      recipients: [],
      kind: 'broadcast',
    })
  })

  it('projects Phase 0 swarm disk files + optional plan.json into TeamWorkbenchSnapshot and timeline', async () => {
    const appDataDir = await makeTempAppDataDir()
    const { nativeSessionId, workerConvId, teamName } = await seedPhase0SwarmFixture(appDataDir, {
      readerKilled: true,
      includePlan: true,
    })

    const timeline = await readAntigravitySwarmTimeline('cc-session-1', nativeSessionId, {
      appDataDir,
      workDir: '/tmp/agy-p3-L6PrnN',
    })
    expect(timeline).not.toBeNull()
    expect(timeline!.sessionId).toBe('cc-session-1')
    expect(timeline!.teamName).toBe(teamName)
    expect(timeline!.source).toBe('live')
    expect(timeline!.snapshots).toHaveLength(1)

    const snapshot = timeline!.snapshots[0]!
    expect(snapshot.team.description).toBe('Read note.txt')
    expect(snapshot.team.leadSessionId).toBe('cc-session-1')
    expect(snapshot.team.leadAgentId).toBe(`coordinator@${teamName}`)
    expect(snapshot.team.members.map((m) => m.name)).toEqual(['coordinator', 'reader'])

    const [coordinator, reader] = snapshot.team.members
    expect(coordinator!.activity).toBe('idle')
    expect(coordinator!.model).toBe('gemini-3.8-flash-low')
    expect(coordinator!.effortLevel).toBe('low')
    expect(coordinator!.providerId).toBe('antigravity-acp')
    expect(coordinator!.sessionId).toBe(nativeSessionId)

    expect(reader!.status).toBe('completed')
    expect(reader!.activity).toBe('exited')
    expect(reader!.sessionId).toBe(workerConvId)
    expect(reader!.cwd).toBe('/tmp/agy-p3-L6PrnN')

    // Board messages
    expect(snapshot.messages).toHaveLength(2)
    expect(snapshot.messages[0]).toMatchObject({
      from: 'coordinator',
      to: 'reader',
      recipients: ['reader'],
      kind: 'direct',
    })
    expect(snapshot.messages[1]).toMatchObject({
      from: 'reader',
      to: 'coordinator',
      recipients: ['coordinator'],
      kind: 'direct',
      text: '@coordinator [done] SWARM_SECRET_42',
    })

    // Tasks from plan.json
    expect(snapshot.tasks).toEqual([
      {
        id: '1',
        subject: 'Read secret note',
        description: 'Read note.txt and report secret',
        status: 'completed',
        owner: 'reader',
        blocks: ['2'],
        blockedBy: [],
        taskListId: teamName,
      },
      {
        id: '2',
        subject: 'Verify result',
        description: '',
        status: 'in_progress',
        owner: 'coordinator',
        blocks: [],
        blockedBy: ['1'],
        taskListId: teamName,
      },
    ])
  })

  it('serves incremental worker transcript pages with cursor append and reset detection', async () => {
    const appDataDir = await makeTempAppDataDir()
    const { workerConvId, teamName } = await seedPhase0SwarmFixture(appDataDir, {
      readerKilled: false,
    })

    const page1 = await readAntigravitySwarmMemberTranscriptPage(
      teamName,
      `reader@${teamName}`,
      { appDataDir },
    )
    expect(page1.ownerAgentIds).toEqual([workerConvId])
    expect(page1.messages).toHaveLength(4)
    expect(page1.afterOrdinal).toBe(3)
    expect(page1.reset).toBeUndefined()

    // No changes -> empty delta
    const page2 = await readAntigravitySwarmMemberTranscriptPage(
      teamName,
      `reader@${teamName}`,
      {
        appDataDir,
        signature: page1.signature,
        cursor: page1.cursor,
        afterOrdinal: page1.afterOrdinal,
      },
    )
    expect(page2.messages).toEqual([])
    expect(page2.reset).toBeUndefined()

    // Append a new step -> returns only the new message
    const transcriptPath = path.join(
      appDataDir,
      'brain',
      workerConvId,
      '.system_generated/logs/transcript.jsonl',
    )
    await fs.appendFile(
      transcriptPath,
      `${JSON.stringify({
        step_index: 4,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-26T09:33:52Z',
        model: 'gemini-3.8-flash-low',
        content: 'Done reading.',
      })}\n`,
      'utf8',
    )

    const page3 = await readAntigravitySwarmMemberTranscriptPage(
      teamName,
      `reader@${teamName}`,
      {
        appDataDir,
        signature: page2.signature,
        cursor: page2.cursor,
        afterOrdinal: page2.afterOrdinal,
      },
    )
    expect(page3.reset).toBeUndefined()
    expect(page3.messages).toHaveLength(1)
    expect(page3.afterOrdinal).toBe(4)

    // Malformed cursor triggers clean reset
    const pageReset = await readAntigravitySwarmMemberTranscriptPage(
      teamName,
      `reader@${teamName}`,
      { appDataDir, cursor: 'not-valid-base64-cursor', afterOrdinal: 2 },
    )
    expect(pageReset.reset).toBe(true)
    expect(pageReset.messages).toHaveLength(5)
  })

  it('routes member steering via registered handler, blocks exited members, and returns 503 when unhooked', async () => {
    const appDataDir = await makeTempAppDataDir()
    const { nativeSessionId, teamName } = await seedPhase0SwarmFixture(appDataDir, {
      readerKilled: false,
    })

    // Populate session mapping via timeline read
    await readAntigravitySwarmTimeline('cc-session-steer', nativeSessionId, { appDataDir })

    // Without handler -> 503 actionable error
    await expect(
      sendAntigravitySwarmMemberMessage(teamName, `reader@${teamName}`, 'double check line 2', { appDataDir }),
    ).rejects.toMatchObject({ statusCode: 503, code: 'ANTIGRAVITY_SWARM_STEERING_UNAVAILABLE' })

    // With registered handler -> forwards formatted @mention prompt
    const received: AntigravitySwarmSteerPayload[] = []
    disposeHandler = registerAntigravitySwarmSteerHandler(async (payload) => {
      received.push(payload)
      return { routed: true, delivery: 'steering' }
    })

    const res = await sendAntigravitySwarmMemberMessage(
      teamName,
      `reader@${teamName}`,
      'double check line 2',
      { appDataDir },
    )
    expect(res).toEqual({
      ok: true,
      routed: true,
      delivery: 'steering',
      target: 'reader',
      formattedPrompt: '@reader double check line 2',
    })
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({
      teamName,
      nativeSessionId,
      sessionId: 'cc-session-steer',
      memberName: 'reader',
      formattedPrompt: '@reader double check line 2',
    })

    // Formatting rules: coordinator and slash commands don't double-prefix
    expect(formatAntigravitySwarmSteerPrompt('coordinator', 'status update')).toBe('status update')
    expect(formatAntigravitySwarmSteerPrompt('reader', '@reader already prefixed')).toBe('@reader already prefixed')
    expect(formatAntigravitySwarmSteerPrompt('reader', '/compact')).toBe('/compact')

    // Exited member -> 409 conflict
    const killedDir = await makeTempAppDataDir()
    const killed = await seedPhase0SwarmFixture(killedDir, { readerKilled: true })
    await expect(
      sendAntigravitySwarmMemberMessage(killed.teamName, `reader@${killed.teamName}`, 'wake up', { appDataDir: killedDir }),
    ).rejects.toMatchObject({ statusCode: 409 })
  })

  it('returns null snapshot when swarm directory does not exist', async () => {
    const appDataDir = await makeTempAppDataDir()
    const snapshot = await readAntigravitySwarmSnapshot('no-such-swarm', { appDataDir })
    expect(snapshot).toBeNull()
  })
})
