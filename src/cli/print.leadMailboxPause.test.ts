import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment } from '../../scripts/pr/test-environment.js'

const home = mkdtempSync(join(tmpdir(), 'lead-mailbox-pause-'))
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

const LEAD_ID = 'team-lead@pause-team'
const WORKER_ID = 'worker@pause-team'

// Each lead turn records its prompt instead of calling a model.
const prompts: string[] = []
const queryEngine = await import('../QueryEngine.js')
const originalQueryEngine = { ...queryEngine }
mock.module('../QueryEngine.js', () => ({
  ...queryEngine,
  ask: async function* (params: { prompt: unknown }) {
    prompts.push(
      typeof params.prompt === 'string'
        ? params.prompt
        : JSON.stringify(params.prompt),
    )
  },
}))

const { __runHeadlessStreamingForTests } = await import('./print.js')
const { StructuredIO } = await import('./structuredIO.js')
const { Stream } = await import('../utils/stream.js')
const { getDefaultAppState } = await import('../state/AppStateStore.js')
const { clearCommandQueue } = await import('../utils/messageQueueManager.js')
const { setIsInteractive, getIsInteractive } = await import(
  '../bootstrap/state.js'
)
const mailbox = await import('../utils/teammateMailbox.js')

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

function startLead(team: string) {
  const defaults = getDefaultAppState()
  let state = {
    ...defaults,
    teamContext: {
      teamName: team,
      teamFilePath: join(home, 'teams', team, 'config.json'),
      leadAgentId: LEAD_ID,
      teammates: {
        [LEAD_ID]: { name: 'team-lead' },
        [WORKER_ID]: { name: 'worker' },
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
    async control(subtype: string) {
      const id = `${subtype}-${Math.random()}`
      send({ type: 'control_request', request_id: id, request: { subtype } })
      await until(() => responses.has(id))
    },
    async close() {
      // Without teammates the closing input ends the session instead of
      // asking the lead to shut a team down.
      state = { ...state, teamContext: { ...state.teamContext!, teammates: { [LEAD_ID]: { name: 'team-lead' } } } } as typeof state
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

async function report(team: string, text: string): Promise<void> {
  expect(
    await mailbox.writeToMailbox(
      'team-lead',
      { from: 'worker', text, timestamp: new Date().toISOString() },
      team,
    ),
  ).toBe(true)
}

const delivered = (text: string) =>
  `<teammate-message teammate_id="worker">\n${text}\n</teammate-message>`

test('a team pause keeps teammate mail from starting lead turns until the user speaks again', async () => {
  const team = 'pause-team'
  const lead = startLead(team)
  try {
    lead.say('start')
    await until(() => prompts.length === 1)
    await lead.control('team_plan_pause')

    // A report a member wrote before the Stop killed it.
    await report(team, 'halfway done')
    // Several poll intervals: the lead must not act on its own.
    await Bun.sleep(1_500)
    expect(prompts).toEqual(['start'])
    expect((await mailbox.readUnreadMessages('team-lead', team)).map(m => m.text)).toEqual(['halfway done'])

    lead.say('continue')
    await until(() => prompts.length === 3)
    expect(prompts).toEqual(['start', 'continue', delivered('halfway done')])
  } finally {
    await lead.close()
  }
}, 30_000)

test('a plain interrupt keeps delivering teammate mail between turns', async () => {
  const team = 'interrupt-team'
  const lead = startLead(team)
  try {
    lead.say('start')
    await until(() => prompts.length === 1)
    await lead.control('interrupt')

    await report(team, 'done')
    await until(() => prompts.length === 2)
    expect(prompts).toEqual(['start', delivered('done')])
  } finally {
    await lead.close()
  }
}, 30_000)
