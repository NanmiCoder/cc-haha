import { afterAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment } from '../../scripts/pr/test-environment.js'

const home = mkdtempSync(join(tmpdir(), 'lead-mailbox-drain-'))
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

const TEAM = 'drain-team'
const LEAD_ID = `team-lead@${TEAM}`
const WORKER_ID = `worker@${TEAM}`

// Each lead turn records its prompt instead of calling a model. The first turn
// is where the last teammate goes away, as a shutdown would remove it.
const prompts: string[] = []
let onTurn: (prompt: string) => void = () => {}
const queryEngine = await import('../QueryEngine.js')
const originalQueryEngine = { ...queryEngine }
mock.module('../QueryEngine.js', () => ({
  ...queryEngine,
  ask: async function* (params: { prompt: unknown }) {
    const prompt =
      typeof params.prompt === 'string'
        ? params.prompt
        : JSON.stringify(params.prompt)
    prompts.push(prompt)
    onTurn(prompt)
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

test('delivers mail the last teammate left behind, with its summary, before the lead stops polling', async () => {
  clearCommandQueue()
  expect(
    await mailbox.writeToMailbox(
      'team-lead',
      {
        from: 'worker',
        text: 'All 42 tests pass',
        summary: 'tests "green"',
        timestamp: new Date().toISOString(),
      },
      TEAM,
    ),
  ).toBe(true)

  const defaults = getDefaultAppState()
  let state = {
    ...defaults,
    teamContext: {
      teamName: TEAM,
      teamFilePath: join(home, 'teams', TEAM, 'config.json'),
      leadAgentId: LEAD_ID,
      teammates: {
        [LEAD_ID]: { name: 'team-lead' },
        [WORKER_ID]: { name: 'worker' },
      },
    },
  } as unknown as typeof defaults
  onTurn = prompt => {
    if (prompt.includes('start')) {
      const teamContext = state.teamContext!
      state = {
        ...state,
        teamContext: {
          ...teamContext,
          teammates: { [LEAD_ID]: teamContext.teammates[LEAD_ID]! },
        },
      }
    }
  }

  const input = new Stream<string>()
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
    for await (const _ of output) {
      // Keep the outbound queue flowing.
    }
  })()

  try {
    input.enqueue(
      `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'start' } })}\n`,
    )
    const deadline = Date.now() + 10_000
    while (prompts.length < 2 && Date.now() < deadline) await Bun.sleep(20)

    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toBe(
      '<teammate-message teammate_id="worker" summary="tests &quot;green&quot;">\n' +
        'All 42 tests pass\n' +
        '</teammate-message>',
    )
    expect(await mailbox.readUnreadMessages('team-lead', TEAM)).toEqual([])
  } finally {
    input.done()
    await drained
    clearCommandQueue()
  }

  // One drain only: the lead then stops polling and the session closes.
  expect(prompts).toHaveLength(2)
}, 30_000)
