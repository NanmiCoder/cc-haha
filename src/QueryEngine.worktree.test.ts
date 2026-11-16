import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment } from '../scripts/pr/test-environment.js'

const home = realpathSync(mkdtempSync(join(tmpdir(), 'query-worktree-')))
const worktree = join(home, 'worktree')
mkdirSync(worktree)
const originalEnv = { ...process.env }
const previousMacro = (globalThis as any).MACRO
;(globalThis as any).MACRO = { VERSION: 'fixture', BUILD_TIME: 'fixture' }
for (const key of Object.keys(process.env)) delete process.env[key]
Object.assign(process.env, createSandboxedTestEnvironment(home, { CLAUDE_CODE_SIMPLE: '1', DISABLE_TELEMETRY: '1' }, originalEnv))
const originals = {
  query: { ...await import('./query.js') },
  input: { ...await import('./utils/processUserInput/processUserInput.js') },
  storage: { ...await import('./utils/sessionStorage.js') },
  context: { ...await import('./utils/queryContext.js') },
}
const { setCwd } = await import('./utils/Shell.js')
const { restoreWorktreeSession } = await import('./utils/worktree.js')
const { createAssistantMessage, createUserMessage } = await import('./utils/messages.js')
let transition: 'enter-exit' | 'failed' | 'unchanged'
let flushed = false
mock.module('./utils/queryContext.js', () => ({ ...originals.context, fetchSystemPromptParts: async () => ({ defaultSystemPrompt: [], userContext: {}, systemContext: {} }) }))
mock.module('./utils/processUserInput/processUserInput.js', () => ({ ...originals.input, processUserInput: async () => ({ messages: [], shouldQuery: true, allowedTools: [] }) }))
mock.module('./utils/sessionStorage.js', () => ({ ...originals.storage, recordTranscript: async () => {}, flushSessionStorage: async () => { flushed = true } }))
mock.module('./query.js', () => ({ ...originals.query, query: async function* () {
  if (transition === 'enter-exit') {
    setCwd(worktree)
    restoreWorktreeSession({ originalCwd: home, worktreePath: worktree, worktreeName: 'fixture', sessionId: 'fixture' })
  }
  yield createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'enter', content: 'tool result', ...(transition === 'failed' ? { is_error: true } : {}) }] })
  if (transition === 'enter-exit') {
    setCwd(home)
    restoreWorktreeSession(null)
    yield createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'exit', content: 'exited' }] })
  }
  yield createAssistantMessage({ content: [{ type: 'text', text: 'done' }] })
} }))
const { QueryEngine } = await import('./QueryEngine.js')
const { getDefaultAppState } = await import('./state/AppStateStore.js')

function engine() {
  let state = getDefaultAppState()
  return new QueryEngine({ cwd: home, tools: [], commands: [], mcpClients: [], agents: [], readFileCache: new Map() as any,
    customSystemPrompt: 'fixture', userSpecifiedModel: 'claude-sonnet-4-5', thinkingConfig: { type: 'disabled' },
    canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }),
    getAppState: () => state, setAppState: update => { state = update(state) },
  })
}

beforeEach(() => { restoreWorktreeSession(null); flushed = false })
afterAll(() => {
  restoreWorktreeSession(null)
  setCwd(process.cwd())
  for (const [name, value] of Object.entries(originals)) {
    const paths = { query: './query.js', input: './utils/processUserInput/processUserInput.js', storage: './utils/sessionStorage.js', context: './utils/queryContext.js' }
    mock.module(paths[name as keyof typeof paths], () => value)
  }
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, originalEnv)
  if (previousMacro === undefined) delete (globalThis as any).MACRO
  else (globalThis as any).MACRO = previousMacro
  rmSync(home, { recursive: true, force: true })
})

test('enter and exit publish the new cwd before their tool results within the same turn', async () => {
  transition = 'enter-exit'
  const events: any[] = []
  for await (const event of engine().submitMessage('enter then exit')) {
    if (event.type === 'system' && event.subtype === 'init' && event.cwd === worktree) expect(flushed).toBe(true)
    events.push(event)
  }
  const inits = events.filter(event => event.type === 'system' && event.subtype === 'init')
  expect(inits.map(event => event.cwd)).toEqual([home, worktree, home])
  expect(new Set(inits.map(event => event.uuid)).size).toBe(3)
  expect(events.indexOf(inits[1])).toBeLessThan(events.findIndex(event => event.type === 'user'))
})

test.each(['failed', 'unchanged'] as const)('%s tool execution does not publish a false workspace switch', async mode => {
  transition = mode
  const inits: any[] = []
  for await (const event of engine().submitMessage('tool boundary')) {
    if (event.type === 'system' && event.subtype === 'init') inits.push(event)
  }
  expect(inits.map(event => event.cwd)).toEqual([home])
})
