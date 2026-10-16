import { afterAll, beforeAll, expect, mock, spyOn, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as gracefulShutdownModule from '../utils/gracefulShutdown.js'

// Copied before mocking: bun's mock.module is process-wide, so the real module
// is put back afterwards for any file sharing this process.
const realGracefulShutdown = { ...gracefulShutdownModule }
const shutdowns: number[] = []
mock.module('../utils/gracefulShutdown.js', () => ({
  ...realGracefulShutdown,
  gracefulShutdownSync: (exitCode = 0) => {
    shutdowns.push(exitCode)
  },
}))
const { __loadInitialMessagesForTests: loadInitialMessages } = await import('./print.js')

const ids = {
  prompt: crypto.randomUUID(),
  plan: crypto.randomUUID(),
  toolUse: crypto.randomUUID(),
}
const saved = {
  config: process.env.CLAUDE_CONFIG_DIR,
  simple: process.env.CLAUDE_CODE_SIMPLE,
}
let dir = ''
let transcript = ''

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'print-resume-at-'))
  process.env.CLAUDE_CONFIG_DIR = join(dir, 'config')
  process.env.CLAUDE_CODE_SIMPLE = '1'
  const sessionId = crypto.randomUUID()
  const base = {
    sessionId, cwd: dir, version: '9.9.9', timestamp: new Date().toISOString(),
    isSidechain: false, userType: 'external',
  }
  const assistant = (id: string, content: unknown[]) => ({
    id, role: 'assistant', model: 'claude-sonnet-4-5', content,
    stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 },
  })
  const rows = [
    { ...base, uuid: ids.prompt, parentUuid: null, type: 'user', message: { role: 'user', content: 'start' } },
    { ...base, uuid: ids.plan, parentUuid: ids.prompt, type: 'assistant', message: assistant('msg_plan', [{ type: 'text', text: 'PLAN' }]) },
    { ...base, uuid: ids.toolUse, parentUuid: ids.plan, type: 'assistant', message: assistant('msg_tool', [{ type: 'tool_use', id: 'toolu_job', name: 'Bash', input: { command: 'sleep 600' } }]) },
  ]
  transcript = join(dir, `${sessionId}.jsonl`)
  await writeFile(transcript, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
})

afterAll(async () => {
  mock.module('../utils/gracefulShutdown.js', () => realGracefulShutdown)
  for (const [key, value] of [
    ['CLAUDE_CONFIG_DIR', saved.config],
    ['CLAUDE_CODE_SIMPLE', saved.simple],
  ] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await rm(dir, { recursive: true, force: true })
})

function load(resumeSessionAt: string) {
  return loadInitialMessages(() => {}, {
    continue: undefined,
    teleport: undefined,
    resume: transcript,
    resumeSessionAt,
    forkSession: true,
    outputFormat: 'text',
    restoredWorkerState: Promise.resolve(null),
  })
}

test('print resume forks at a tool call that has no result yet', async () => {
  const result = await load(ids.toolUse)
  expect(result.messages.map(message => message.uuid)).toEqual([ids.prompt, ids.plan])
  expect(result.turnInterruptionState).toEqual({ kind: 'none' })
  expect(shutdowns).toEqual([])
})

test('print resume reports an unknown boundary and shuts down with exit code 1', async () => {
  const missing = crypto.randomUUID()
  shutdowns.length = 0
  const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true)
  try {
    const result = await load(missing)
    expect(result.messages).toEqual([])
    expect(shutdowns).toEqual([1])
    expect(stderr.mock.calls.map(call => String(call[0]))).toContain(
      `No message found with message.uuid of: ${missing}\n`,
    )
  } finally {
    stderr.mockRestore()
  }
})
