import { afterEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  antigravitySwarmTeamName,
  beginAntigravitySwarmPause,
  completeAntigravitySwarmPause,
  deriveSwarmMemberState,
  extractBoardMentions,
  forgetAntigravitySwarmSessionMapping,
  forgetAntigravitySwarmSessionMappingsForSession,
  formatAntigravitySwarmSteerPrompt,
  getAntigravitySwarmRuntimeControlView,
  isAntigravitySwarmTeamName,
  listRememberedAntigravitySwarmSessions,
  nativeSessionIdFromSwarmTeamName,
  readAntigravitySwarmMemberTranscriptPage,
  readAntigravitySwarmSnapshot,
  readAntigravitySwarmTimeline,
  registerAntigravitySwarmResumeHandler,
  registerAntigravitySwarmRuntimeProbe,
  registerAntigravitySwarmSteerHandler,
  rememberAntigravitySwarmSessionMapping,
  resetAntigravitySwarmControlStateForTests,
  resumeAntigravitySwarm,
  sendAntigravitySwarmMemberMessage,
  type AntigravitySwarmResumePayload,
  type AntigravitySwarmSteerPayload,
} from './antigravitySwarmAdapter.js'
import { TeamWatcher } from './teamWatcher.js'

const tempDirs: string[] = []
let disposeHandler: (() => void) | null = null
let disposeResumeHandler: (() => void) | null = null
let disposeRuntimeProbe: (() => void) | null = null

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
  disposeResumeHandler?.()
  disposeResumeHandler = null
  disposeRuntimeProbe?.()
  disposeRuntimeProbe = null
  resetAntigravitySwarmControlStateForTests()
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
    expect(deriveSwarmMemberState({ phase: 'RUNNING', wake_mode: 'anything', killed: false }))
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
    const unhook = registerAntigravitySwarmSteerHandler(null)
    try {
      await expect(
        sendAntigravitySwarmMemberMessage(teamName, `reader@${teamName}`, 'double check line 2', { appDataDir }),
      ).rejects.toMatchObject({ statusCode: 503, code: 'ANTIGRAVITY_SWARM_STEERING_UNAVAILABLE' })
    } finally {
      unhook()
    }

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

  it('keeps swarmIncarnationId deterministic independent of volatile leadSessionId and returns 409 when steering is busy', async () => {
    const appDataDir = await makeTempAppDataDir()
    const { nativeSessionId, teamName } = await seedPhase0SwarmFixture(appDataDir, {
      nativeSessionId: 'incarnation-det-1111-2222-333333333333',
      readerKilled: false,
    })

    // Read snapshot BEFORE leadSessionId is known/remembered
    const beforeLead = await readAntigravitySwarmSnapshot(nativeSessionId, { appDataDir })
    expect(beforeLead).not.toBeNull()
    expect(beforeLead!.team.leadSessionId).toBeUndefined()

    // Read snapshot AFTER leadSessionId is provided
    const afterLead = await readAntigravitySwarmSnapshot(nativeSessionId, {
      appDataDir,
      leadSessionId: 'cc-session-after-restart',
    })
    expect(afterLead).not.toBeNull()
    expect(afterLead!.team.leadSessionId).toBe('cc-session-after-restart')
    expect(afterLead!.team.incarnationId).toBe(beforeLead!.team.incarnationId)

    // Busy steering handler returns HTTP 409 conflict
    disposeHandler = registerAntigravitySwarmSteerHandler(async () => ({
      routed: false,
      reason: 'busy',
    }))
    await expect(
      sendAntigravitySwarmMemberMessage(teamName, `reader@${teamName}`, 'status?', { appDataDir }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'ANTIGRAVITY_SWARM_SESSION_BUSY',
    })
  })

  it('projects native swarm_pane plan.json object-map tasks, DAG dependencies, live [done] status, and brief fallback', async () => {
    const appDataDir = await makeTempAppDataDir()
    const nativeSessionId = 'pane-plan-1111-2222-333333333333'
    const swarmDir = path.join(appDataDir, 'brain', nativeSessionId, '.system_generated', 'swarm')
    await fs.mkdir(swarmDir, { recursive: true })
    await fs.writeFile(
      path.join(swarmDir, 'swarm.json'),
      JSON.stringify({ version: 1, backend: 'local', swarm_id: nativeSessionId, created_at: '2026-11-26T13:35:52Z' }),
      'utf8',
    )
    await fs.writeFile(
      path.join(swarmDir, 'members.json'),
      JSON.stringify({
        title: 'Analyze v0.7.8..v0.8.0 changes',
        members: {
          coordinator: { conversation_id: nativeSessionId, role: 'coordinator', phase: 'RUNNING', wake_mode: 'working', killed: false, model: 'gemini-4-hydrogen-low' },
          security: { conversation_id: 'sec-1111', role: 'worker', phase: 'RUNNING', wake_mode: 'mentions', killed: false, model: 'gemini-4-hydrogen-low' },
          quality: { conversation_id: 'qual-2222', role: 'worker', phase: 'RUNNING', wake_mode: 'working', killed: false, model: 'gemini-4-hydrogen-low' },
          monitor: { conversation_id: 'mon-3333', role: 'worker', phase: 'RUNNING', wake_mode: 'mentions', killed: false, model: 'gemini-4-hydrogen-low' },
        },
      }),
      'utf8',
    )
    // 1. Before plan.json is written: derive tasks from board.jsonl briefs (excluding monitor)
    await fs.writeFile(
      path.join(swarmDir, 'board.jsonl'),
      [
        JSON.stringify({ seq: 1, agent: 'coordinator', kind: 'brief', time: '2026-11-26 05:35:53', text: '@security Audit security boundaries' }),
        JSON.stringify({ seq: 2, agent: 'coordinator', kind: 'brief', time: '2026-11-26 05:35:54', text: '@quality Review code quality' }),
        JSON.stringify({ seq: 3, agent: 'coordinator', kind: 'brief', time: '2026-11-26 05:35:55', text: '@monitor Stall monitor' }),
        JSON.stringify({ seq: 4, agent: 'security', time: '2026-11-26 05:36:10', text: '@coordinator [done] No critical vulnerabilities found.' }),
      ].join('\n') + '\n',
      'utf8',
    )

    const beforePlan = await readAntigravitySwarmSnapshot(nativeSessionId, { appDataDir, leadSessionId: 'lead-1' })
    expect(beforePlan).not.toBeNull()
    expect(beforePlan!.tasks.map(t => ({ owner: t.owner, status: t.status, blockedBy: t.blockedBy }))).toEqual([
      { owner: 'security', status: 'completed', blockedBy: [] },
      { owner: 'quality', status: 'in_progress', blockedBy: [] },
      { owner: 'coordinator', status: 'pending', blockedBy: ['1', '2'] },
    ])

    // 2. Write real swarm_pane plan.json object-map + coordinator [done]
    await fs.writeFile(
      path.join(swarmDir, 'plan.json'),
      JSON.stringify({
        goal: { title: 'Release Change Analysis', line: 'Review security and code quality.' },
        tasks: {
          security: 'Audit security risks and boundaries',
          quality: 'Review code quality and tests',
        },
        threads: [{ id: 't-analysis', title: 'Analysis', goal: 'Produce findings', tasks: ['security', 'quality'] }],
      }),
      'utf8',
    )
    await fs.appendFile(
      path.join(swarmDir, 'board.jsonl'),
      [
        JSON.stringify({ seq: 5, agent: 'quality', time: '2026-11-26 05:36:20', text: '@coordinator [done] Quality looks good.' }),
        JSON.stringify({ seq: 6, agent: 'coordinator', time: '2026-11-26 05:36:25', text: '[done] Completed full release analysis.' }),
      ].join('\n') + '\n',
      'utf8',
    )

    const afterPlan = await readAntigravitySwarmSnapshot(nativeSessionId, { appDataDir, leadSessionId: 'lead-1' })
    expect(afterPlan).not.toBeNull()
    expect(afterPlan!.team.description).toBe('Release Change Analysis')
    expect(afterPlan!.tasks.map(t => ({ id: t.id, owner: t.owner, status: t.status, subject: t.subject, blocks: t.blocks, blockedBy: t.blockedBy }))).toEqual([
      { id: '1', owner: 'security', status: 'completed', subject: 'Audit security risks and boundaries', blocks: ['3'], blockedBy: [] },
      { id: '2', owner: 'quality', status: 'completed', subject: 'Review code quality and tests', blocks: ['3'], blockedBy: [] },
      { id: '3', owner: 'coordinator', status: 'completed', subject: 'Release Change Analysis', blocks: [], blockedBy: ['1', '2'] },
    ])
    expect(afterPlan!.team.members.find(m => m.name === 'security')?.status).toBe('completed')
    expect(afterPlan!.team.members.find(m => m.name === 'coordinator')?.status).toBe('completed')
  })

  it('TeamWatcher broadcasts team_created and team_workbench_updated for remembered Antigravity Swarms', async () => {
    const appDataDir = await makeTempAppDataDir()
    const nativeSessionId = 'watcher-swarm-1111-2222-333333333333'
    const prevEnv = process.env.CC_HAHA_ANTIGRAVITY_APP_DATA_DIR
    process.env.CC_HAHA_ANTIGRAVITY_APP_DATA_DIR = appDataDir
    rememberAntigravitySwarmSessionMapping(nativeSessionId, 'cc-watcher-session')

    const events: Array<{ type: string; teamName?: string; leadSessionId?: string }> = []
    const watcher = new TeamWatcher((msg, leadSessionId) => {
      events.push({
        type: msg.type,
        teamName: 'teamName' in msg ? msg.teamName : undefined,
        leadSessionId,
      })
    })

    try {
      // Before swarm files exist -> emits nothing
      await watcher.checkNow()
      expect(events).toEqual([])

      // Create swarm on disk -> emits team_created to the lead session
      await seedPhase0SwarmFixture(appDataDir, { nativeSessionId })
      await watcher.checkNow()
      expect(events).toEqual([{
        type: 'team_created',
        teamName: antigravitySwarmTeamName(nativeSessionId),
        leadSessionId: 'cc-watcher-session',
      }])

      // Unchanged -> no duplicate event
      await watcher.checkNow()
      expect(events).toHaveLength(1)

      // Write plan.json -> emits team_workbench_updated
      const swarmDir = path.join(appDataDir, 'brain', nativeSessionId, '.system_generated', 'swarm')
      await fs.writeFile(
        path.join(swarmDir, 'plan.json'),
        JSON.stringify({ goal: { title: 'Updated Goal' }, tasks: { reader: 'Read note.txt' } }),
        'utf8',
      )
      await watcher.checkNow()
      expect(events).toHaveLength(2)
      expect(events[1]).toEqual({
        type: 'team_workbench_updated',
        teamName: antigravitySwarmTeamName(nativeSessionId),
        leadSessionId: 'cc-watcher-session',
      })

      // Forgetting by cc-haha sessionId removes the mapping and stops further watcher broadcasts.
      forgetAntigravitySwarmSessionMappingsForSession('cc-watcher-session')
      expect(listRememberedAntigravitySwarmSessions().some(entry => entry.nativeSessionId === nativeSessionId)).toBe(false)
      await fs.writeFile(
        path.join(swarmDir, 'plan.json'),
        JSON.stringify({ goal: { title: 'After Clear' }, tasks: { reader: 'Read note.txt' } }),
        'utf8',
      )
      await watcher.checkNow()
      expect(events).toHaveLength(2)
    } finally {
      watcher.reset()
      forgetAntigravitySwarmSessionMapping(nativeSessionId)
      if (prevEnv === undefined) delete process.env.CC_HAHA_ANTIGRAVITY_APP_DATA_DIR
      else process.env.CC_HAHA_ANTIGRAVITY_APP_DATA_DIR = prevEnv
    }
  })

  it('projects paused/stopped state without mutating disk files and supports explicit resume with CAS, idempotency, and partial retry', async () => {
    const appDataDir = await makeTempAppDataDir()
    const nativeSessionId = 'pause-resume-1111-2222-333333333333'
    const teamName = antigravitySwarmTeamName(nativeSessionId)
    const swarmDir = path.join(appDataDir, 'brain', nativeSessionId, '.system_generated', 'swarm')
    await fs.mkdir(swarmDir, { recursive: true })
    await fs.writeFile(
      path.join(swarmDir, 'swarm.json'),
      JSON.stringify({ version: 1, backend: 'local', swarm_id: nativeSessionId, created_at: '2026-11-27T01:00:00Z' }),
      'utf8',
    )
    const membersPayload = JSON.stringify({
      title: 'Audit pipeline',
      members: {
        coordinator: { conversation_id: nativeSessionId, role: 'coordinator', phase: 'RUNNING', wake_mode: 'working', killed: false, model: 'gemini-4-neon' },
        worker1: { conversation_id: 'w1-conv', role: 'worker', phase: 'RUNNING', wake_mode: 'working', killed: false, model: 'gemini-4-neon' },
        monitor: { conversation_id: 'mon-conv', role: 'worker', phase: 'RUNNING', wake_mode: 'anything', killed: false, model: 'gemini-4-neon' },
        doneWorker: { conversation_id: 'done-conv', role: 'worker', phase: 'KILLED', wake_mode: 'mentions', killed: true, model: 'gemini-4-neon' },
      },
    })
    await fs.writeFile(path.join(swarmDir, 'members.json'), membersPayload, 'utf8')
    await fs.writeFile(
      path.join(swarmDir, 'board.jsonl'),
      `${JSON.stringify({ seq: 1, agent: 'coordinator', kind: 'brief', time: '2026-11-27 01:00:01', text: '@worker1 Audit modules' })}\n`,
      'utf8',
    )

    let runtimeAlive = true
    disposeRuntimeProbe = registerAntigravitySwarmRuntimeProbe(() => runtimeAlive)
    rememberAntigravitySwarmSessionMapping(nativeSessionId, 'cc-pause-lead')

    // 1. Live runtime -> running control view + worker1 active, monitor idle
    const runningSnap = await readAntigravitySwarmSnapshot(nativeSessionId, { appDataDir, leadSessionId: 'cc-pause-lead' })
    expect(runningSnap).not.toBeNull()
    expect(runningSnap!.team.members.find(m => m.name === 'worker1')).toMatchObject({ status: 'running', activity: 'active' })
    expect(runningSnap!.team.members.find(m => m.name === 'monitor')).toMatchObject({ status: 'idle', activity: 'idle' })
    expect(runningSnap!.team.members.find(m => m.name === 'doneWorker')).toMatchObject({ status: 'completed', activity: 'exited' })

    const runningControl = await getAntigravitySwarmRuntimeControlView(teamName, {
      leadSessionId: 'cc-pause-lead',
      incarnationId: runningSnap!.team.incarnationId,
    }, { appDataDir })
    expect(runningControl).not.toBeNull()
    expect(runningControl!.status).toBe('running')
    expect(runningControl!.resumeEligibleCount).toBe(0)

    // Mismatched incarnation throws TeamPlanError
    await expect(getAntigravitySwarmRuntimeControlView(teamName, {
      leadSessionId: 'cc-pause-lead',
      incarnationId: 'wrong-incarnation',
    }, { appDataDir })).rejects.toMatchObject({ status: 409 })

    // 2. Begin + complete pause -> unfinished workers become stopped without touching members.json on disk
    const pauseToken = beginAntigravitySwarmPause(nativeSessionId)
    const pausingView = await getAntigravitySwarmRuntimeControlView(teamName, {
      leadSessionId: 'cc-pause-lead',
      incarnationId: runningSnap!.team.incarnationId,
    }, { appDataDir })
    expect(pausingView!.status).toBe('pausing')

    runtimeAlive = false
    completeAntigravitySwarmPause(nativeSessionId, pauseToken, { boardMaxSeq: 1 })
    const pausedSnap = await readAntigravitySwarmSnapshot(nativeSessionId, { appDataDir, leadSessionId: 'cc-pause-lead' })
    expect(pausedSnap!.team.members.find(m => m.name === 'worker1')).toMatchObject({ status: 'idle', activity: 'stopped' })
    expect(pausedSnap!.team.members.find(m => m.name === 'monitor')).toMatchObject({ status: 'idle', activity: 'stopped' })
    expect(pausedSnap!.team.members.find(m => m.name === 'doneWorker')).toMatchObject({ status: 'completed', activity: 'exited' })
    expect(pausedSnap!.team.members.find(m => m.name === 'coordinator')).toMatchObject({ status: 'idle', activity: 'idle' })
    // Disk file remains untouched (read-only invariant)
    expect(await fs.readFile(path.join(swarmDir, 'members.json'), 'utf8')).toBe(membersPayload)

    const pausedControl = await getAntigravitySwarmRuntimeControlView(teamName, {
      leadSessionId: 'cc-pause-lead',
      incarnationId: runningSnap!.team.incarnationId,
    }, { appDataDir })
    expect(pausedControl!.status).toBe('paused')
    expect(pausedControl!.resumeEligibleCount).toBe(1)

    // 3. Stale revision conflict rejects with 409
    await expect(resumeAntigravitySwarm(teamName, {
      leadSessionId: 'cc-pause-lead',
      incarnationId: runningSnap!.team.incarnationId,
      expectedRevision: pausedControl!.revision - 1,
      requestId: 'req-stale',
    }, async () => {}, { appDataDir })).rejects.toMatchObject({ status: 409 })

    // 4. Resume failure records partial status, then retry with same requestId succeeds
    const receivedResumes: AntigravitySwarmResumePayload[] = []
    let failFirst = true
    let startLeaderCalls = 0
    disposeResumeHandler = registerAntigravitySwarmResumeHandler(async (payload) => {
      receivedResumes.push(payload)
      if (failFirst) {
        failFirst = false
        return { routed: false, error: 'temporary acp boot failure' }
      }
      runtimeAlive = true
      return { routed: true }
    })

    const partialRes = await resumeAntigravitySwarm(teamName, {
      leadSessionId: 'cc-pause-lead',
      incarnationId: runningSnap!.team.incarnationId,
      expectedRevision: pausedControl!.revision,
      requestId: 'req-resume-1',
    }, async () => { startLeaderCalls += 1 }, { appDataDir })
    expect(partialRes.status).toBe('partial')
    expect(partialRes.error).toBe('temporary acp boot failure')
    expect(startLeaderCalls).toBe(1)

    const resumed = await resumeAntigravitySwarm(teamName, {
      leadSessionId: 'cc-pause-lead',
      incarnationId: runningSnap!.team.incarnationId,
      expectedRevision: partialRes.revision,
      requestId: 'req-resume-1',
    }, async () => { startLeaderCalls += 1 }, { appDataDir })
    expect(resumed.status).toBe('running')
    expect(receivedResumes.at(-1)!.prompt).toContain('@worker1')
    expect(receivedResumes.at(-1)!.prompt).toContain('@monitor resume')

    // Idempotent replay with same requestId does not re-dispatch
    const replayed = await resumeAntigravitySwarm(teamName, {
      leadSessionId: 'cc-pause-lead',
      incarnationId: runningSnap!.team.incarnationId,
      expectedRevision: partialRes.revision,
      requestId: 'req-resume-1',
    }, async () => { startLeaderCalls += 1 }, { appDataDir })
    expect(replayed.status).toBe('running')
    expect(receivedResumes).toHaveLength(2)

    // 5. Auto-clears paused overlay if new board.jsonl activity arrives on a live runtime
    const pauseToken2 = beginAntigravitySwarmPause(nativeSessionId)
    completeAntigravitySwarmPause(nativeSessionId, pauseToken2, { boardMaxSeq: 1 })
    runtimeAlive = true
    await fs.appendFile(
      path.join(swarmDir, 'board.jsonl'),
      `${JSON.stringify({ seq: 2, agent: 'worker1', time: '2026-11-27 01:02:00', text: '@coordinator resumed progress' })}\n`,
      'utf8',
    )
    const recoveredControl = await getAntigravitySwarmRuntimeControlView(teamName, {
      leadSessionId: 'cc-pause-lead',
      incarnationId: runningSnap!.team.incarnationId,
    }, { appDataDir })
    expect(recoveredControl!.status).toBe('running')

    forgetAntigravitySwarmSessionMapping(nativeSessionId)
  })

  it('sendAntigravitySwarmMemberMessage starts a paused leader and clears paused state on delivery', async () => {
    const appDataDir = await makeTempAppDataDir()
    const { nativeSessionId, teamName } = await seedPhase0SwarmFixture(appDataDir, {
      nativeSessionId: 'revive-steer-1111-2222-333333333333',
      readerKilled: false,
    })
    rememberAntigravitySwarmSessionMapping(nativeSessionId, 'cc-revive-steer')
    let runtimeAlive = false
    disposeRuntimeProbe = registerAntigravitySwarmRuntimeProbe(() => runtimeAlive)
    const pauseToken = beginAntigravitySwarmPause(nativeSessionId)
    completeAntigravitySwarmPause(nativeSessionId, pauseToken, { boardMaxSeq: 2 })

    let startedLeaders: string[] = []
    disposeHandler = registerAntigravitySwarmSteerHandler(async () => {
      if (!runtimeAlive) return { routed: false, reason: 'unavailable' }
      return { routed: true, delivery: 'steering' }
    })

    const res = await sendAntigravitySwarmMemberMessage(teamName, `reader@${teamName}`, 'continue checking', {
      appDataDir,
      startLeader: async (sessionId) => {
        startedLeaders.push(sessionId)
        runtimeAlive = true
      },
    })
    expect(startedLeaders).toEqual(['cc-revive-steer'])
    expect(res).toMatchObject({ ok: true, routed: true, target: 'reader', formattedPrompt: '@reader continue checking' })

    const snap = await readAntigravitySwarmSnapshot(nativeSessionId, { appDataDir, leadSessionId: 'cc-revive-steer' })
    expect(snap!.team.members.find(m => m.name === 'reader')).toMatchObject({ status: 'running', activity: 'active' })
    forgetAntigravitySwarmSessionMapping(nativeSessionId)
  })

  it('TeamWatcher emits immediate team_workbench_updated when an Antigravity Swarm pauses', async () => {
    const appDataDir = await makeTempAppDataDir()
    const nativeSessionId = 'watcher-pause-1111-2222-333333333333'
    const prevEnv = process.env.CC_HAHA_ANTIGRAVITY_APP_DATA_DIR
    process.env.CC_HAHA_ANTIGRAVITY_APP_DATA_DIR = appDataDir
    rememberAntigravitySwarmSessionMapping(nativeSessionId, 'cc-watcher-pause')
    let runtimeAlive = true
    disposeRuntimeProbe = registerAntigravitySwarmRuntimeProbe(() => runtimeAlive)

    const events: Array<{ type: string; teamName?: string }> = []
    const watcher = new TeamWatcher((msg) => {
      events.push({ type: msg.type, teamName: 'teamName' in msg ? msg.teamName : undefined })
    })
    try {
      await seedPhase0SwarmFixture(appDataDir, { nativeSessionId, readerKilled: false })
      watcher.start()
      await new Promise((resolve) => setTimeout(resolve, 25))
      await watcher.checkNow()
      const countBeforePause = events.length

      const pauseToken = beginAntigravitySwarmPause(nativeSessionId)
      runtimeAlive = false
      completeAntigravitySwarmPause(nativeSessionId, pauseToken, { boardMaxSeq: 2 })

      // Debounced immediate notification (well below 3000ms poll interval)
      const deadline = Date.now() + 1_000
      while (events.length <= countBeforePause && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      expect(events.length).toBeGreaterThan(countBeforePause)
      expect(events.at(-1)).toEqual({
        type: 'team_workbench_updated',
        teamName: antigravitySwarmTeamName(nativeSessionId),
      })
    } finally {
      watcher.stop()
      watcher.reset()
      forgetAntigravitySwarmSessionMapping(nativeSessionId)
      if (prevEnv === undefined) delete process.env.CC_HAHA_ANTIGRAVITY_APP_DATA_DIR
      else process.env.CC_HAHA_ANTIGRAVITY_APP_DATA_DIR = prevEnv
    }
  })
})
