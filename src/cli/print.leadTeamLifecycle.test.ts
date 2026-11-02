import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment } from '../../scripts/pr/test-environment.js'

const home = mkdtempSync(join(tmpdir(), 'lead-team-finished-'))
const originalEnv = { ...process.env }
for (const key of Object.keys(process.env)) delete process.env[key]
Object.assign(
  process.env,
  createSandboxedTestEnvironment(
    home,
    { CLAUDE_CODE_SIMPLE: '1', CC_HAHA_AGENT_TEAMS_ENABLED: '1' },
    originalEnv,
  ),
)

const CREATED_AT = 1_790_000_000_000

// Each lead turn records its prompt instead of calling a model.
const prompts: Array<{ text: string; isMeta?: boolean }> = []
const queryEngine = await import('../QueryEngine.js')
const originalQueryEngine = { ...queryEngine }
mock.module('../QueryEngine.js', () => ({
  ...queryEngine,
  ask: async function* (params: { prompt: unknown; isMeta?: boolean }) {
    prompts.push({
      text:
        typeof params.prompt === 'string'
          ? params.prompt
          : JSON.stringify(params.prompt),
      isMeta: params.isMeta,
    })
  },
}))

const { __runHeadlessStreamingForTests, TEAM_FINISHED_SETTLE_MS } = await import('./print.js')
const { StructuredIO } = await import('./structuredIO.js')
const { Stream } = await import('../utils/stream.js')
const { getDefaultAppState } = await import('../state/AppStateStore.js')
const { clearCommandQueue } = await import('../utils/messageQueueManager.js')
const { setIsInteractive, getIsInteractive } = await import(
  '../bootstrap/state.js'
)
const mailbox = await import('../utils/teammateMailbox.js')
const { writeTeamFileAsync } = await import('../utils/swarm/teamHelpers.js')
const tasks = await import('../utils/tasks.js')

const wasInteractive = getIsInteractive()
setIsInteractive(false)
afterAll(() => {
  // mock.restore does not undo mock.module; later files in the same run
  // must see the real QueryEngine.
  mock.module('../QueryEngine.js', () => originalQueryEngine)
  clearCommandQueue()
  setIsInteractive(wasInteractive)
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, originalEnv)
  rmSync(home, { recursive: true, force: true })
})

beforeEach(() => {
  prompts.length = 0
  clearCommandQueue()
})

/** An approved desktop team whose only task is done and whose worker is idle. */
async function finishedTeam(team: string): Promise<void> {
  await setWorker(team, { isActive: false })
  const listId = tasks.getCanonicalTeamTaskListId(team)
  await tasks.withTaskListLifecycleLock(listId, () =>
    tasks.beginTaskListLifecycle(listId, {
      teamName: team,
      createdAt: CREATED_AT,
      leadSessionId: 'lead-session',
    }),
  )
  await tasks.createTask(listId, {
    subject: 'work',
    description: '',
    status: 'completed',
    blocks: [],
    blockedBy: [],
  })
}

async function setWorker(
  team: string,
  worker: { isActive: boolean; terminated?: boolean },
): Promise<void> {
  await writeTeamFileAsync(team, {
    name: team,
    createdAt: CREATED_AT,
    leadAgentId: `team-lead@${team}`,
    leadSessionId: 'lead-session',
    reviewRequired: true,
    members: [
      { agentId: `team-lead@${team}`, name: 'team-lead', joinedAt: CREATED_AT, tmuxPaneId: '', cwd: home, subscriptions: [] },
      { agentId: `worker@${team}`, name: 'worker', joinedAt: CREATED_AT, tmuxPaneId: '', cwd: home, subscriptions: [], backendType: 'process', sessionId: 'worker-session', ...worker },
    ],
  })
}

function startLead(team: string) {
  const leadId = `team-lead@${team}`
  const workerId = `worker@${team}`
  const defaults = getDefaultAppState()
  let state = {
    ...defaults,
    teamContext: {
      teamName: team,
      teamFilePath: join(home, 'teams', team, 'config.json'),
      leadAgentId: leadId,
      teammates: {
        [leadId]: { name: 'team-lead' },
        [workerId]: { name: 'worker' },
      },
    },
  } as unknown as typeof defaults
  const input = new Stream<string>()
  const responses = new Set<string>()
  const output = __runHeadlessStreamingForTests(
    new StructuredIO(input),
    [],
    [],
    [],
    [],
    (() => undefined) as never,
    {},
    () => state,
    update => {
      state = update(state)
    },
    [],
    { outputFormat: 'stream-json' } as never,
  )
  const drained = (async () => {
    for await (const message of output) {
      const response = (message as { type?: string; response?: { request_id?: string } })
      if (response.type === 'control_response' && response.response?.request_id) {
        responses.add(response.response.request_id)
      }
    }
  })()
  const send = (message: unknown) => input.enqueue(`${JSON.stringify(message)}\n`)
  return {
    say: (content: string) => send({ type: 'user', message: { role: 'user', content } }),
    teamName: () => state.teamContext?.teamName,
    async control(subtype: string, fields: Record<string, unknown> = {}) {
      const id = `${subtype}-${Math.random()}`
      send({ type: 'control_request', request_id: id, request: { subtype, ...fields } })
      await until(() => responses.has(id))
    },
    async close() {
      // Without teammates the closing input ends the session instead of
      // asking the lead to shut a team down.
      if (state.teamContext) state = { ...state, teamContext: { ...state.teamContext, teammates: { [leadId]: { name: 'team-lead' } } } } as typeof state
      input.done()
      await drained
      clearCommandQueue()
    },
  }
}

async function until(done: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!done() && Date.now() < deadline) await Bun.sleep(20)
  expect(done()).toBe(true)
}

const reminders = () =>
  prompts.filter(prompt => prompt.text.includes('Every task on the shared task list'))

test('a lead that stops after its members approve the shutdown is reminded again, to delete the team', async () => {
  const team = 'finished-team'
  await finishedTeam(team)
  const lead = startLead(team)
  try {
    lead.say('report the result')
    await until(() => reminders().length === 1)
    // Hidden from the chat, and it names the member still running.
    expect(reminders()[0]!.isMeta).toBe(true)
    expect(reminders()[0]!.text).toContain('send each of worker its own shutdown_request')

    // Nothing changed: no second reminder, however long the lead stays idle.
    await Bun.sleep(TEAM_FINISHED_SETTLE_MS + 1_000)
    expect(reminders()).toHaveLength(1)

    // The lead shut the member down; its approval reaches the lead, which
    // then stops without calling TeamDelete.
    await setWorker(team, { isActive: false, terminated: true })
    // Written as a desktop member's SendMessage writes it.
    const approval = JSON.stringify(mailbox.createShutdownApprovedMessage({
      requestId: `shutdown-1@worker`,
      from: 'worker',
      backendType: 'process',
    }))
    await mailbox.writeToMailbox('team-lead', { from: 'worker', text: approval, timestamp: new Date().toISOString() }, team)

    await until(() => reminders().length === 2)
    expect(reminders()[1]!.isMeta).toBe(true)
    expect(reminders()[1]!.text).toContain('every teammate has already stopped, so call TeamDelete')
    // The approval was read first, as its own turn.
    const order = prompts.map(prompt =>
      prompt.isMeta ? 'reminder' : prompt.text.includes('shutdown_approved') ? 'approval' : prompt.text,
    )
    expect(order).toEqual(['report the result', 'reminder', 'approval', 'reminder'])
  } finally {
    await lead.close()
  }
}, 30_000)

test('a paused team is not reminded while the host holds its lead', async () => {
  const team = 'paused-finished-team'
  await finishedTeam(team)
  const lead = startLead(team)
  try {
    lead.say('start')
    await until(() => prompts.length === 1)
    await lead.control('team_plan_pause')

    await Bun.sleep(TEAM_FINISHED_SETTLE_MS + 1_500)
    expect(prompts.map(prompt => prompt.text)).toEqual(['start'])
  } finally {
    await lead.close()
  }
}, 30_000)

test('a lead lets go of a team the host ended, and only that team', async () => {
  const team = 'host-ended-team'
  await finishedTeam(team)
  const lead = startLead(team)
  try {
    await lead.control('team_runtime_ended', { team_name: 'another-team' })
    expect(lead.teamName()).toBe(team)
    await lead.control('team_runtime_ended', { team_name: team })
    expect(lead.teamName()).toBeUndefined()
  } finally {
    await lead.close()
  }
}, 30_000)
