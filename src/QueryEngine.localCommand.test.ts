import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment } from '../scripts/pr/test-environment.js'

const home = mkdtempSync(join(tmpdir(), 'query-local-command-'))
const originalEnv = { ...process.env }
const previousMacro = (globalThis as any).MACRO
;(globalThis as any).MACRO = { VERSION: 'fixture', BUILD_TIME: 'fixture' }
for (const key of Object.keys(process.env)) delete process.env[key]
Object.assign(process.env, createSandboxedTestEnvironment(home, { CLAUDE_CODE_SIMPLE: '1', DISABLE_TELEMETRY: '1' }, originalEnv))
const originals = {
  input: { ...await import('./utils/processUserInput/processUserInput.js') },
  storage: { ...await import('./utils/sessionStorage.js') },
  context: { ...await import('./utils/queryContext.js') },
}
let inputOptions: any
mock.module('./utils/queryContext.js', () => ({ ...originals.context,
  fetchSystemPromptParts: async () => ({ defaultSystemPrompt: [], userContext: {}, systemContext: {} }),
}))
mock.module('./utils/processUserInput/processUserInput.js', () => ({ ...originals.input,
  processUserInput: async (options: any) => {
    inputOptions = options
    return { messages: [], shouldQuery: false, allowedTools: [] }
  },
}))
mock.module('./utils/sessionStorage.js', () => ({ ...originals.storage,
  recordTranscript: async () => {}, flushSessionStorage: async () => {},
}))
const { QueryEngine } = await import('./QueryEngine.js')
const { getDefaultAppState } = await import('./state/AppStateStore.js')
const { createSessionMessageInbox, sessionMessageUuid } = await import('./utils/sessionMessageInbox.js')

function engine() {
  let state = getDefaultAppState()
  return new QueryEngine({ cwd: home, tools: [], commands: [
    { name: 'compact', type: 'local', description: 'Fixture compact' },
    { name: 'secret', type: 'local', description: 'Fixture sensitive command', isSensitive: true },
    { name: 'review', type: 'prompt', description: 'Fixture skill' },
  ] as any, mcpClients: [], agents: [], readFileCache: new Map() as any,
  customSystemPrompt: 'fixture', userSpecifiedModel: 'claude-sonnet-4-5', thinkingConfig: { type: 'disabled' },
  canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }),
  getAppState: () => state, setAppState: update => { state = update(state) },
  })
}

beforeEach(() => { inputOptions = undefined })
afterAll(() => {
  mock.module('./utils/processUserInput/processUserInput.js', () => originals.input)
  mock.module('./utils/sessionStorage.js', () => originals.storage)
  mock.module('./utils/queryContext.js', () => originals.context)
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, originalEnv)
  if (previousMacro === undefined) delete (globalThis as any).MACRO
  else (globalThis as any).MACRO = previousMacro
  rmSync(home, { recursive: true, force: true })
})

test.each([
  { input: '/compact retain the question' },
  { input: [{ type: 'text', text: 'preceding context' }, { type: 'text', text: '/compact retain the question' }] },
])('acknowledges local dispatch before asynchronous command work begins (%j)', async ({ input }) => {
  const iterator = engine().submitMessage(input as any, { uuid: 'current-command' })
  try {
    const first = await iterator.next()
    expect(first.value).toMatchObject({ type: 'system', subtype: 'local_command', uuid: 'current-command',
      content: expect.stringContaining('<command-args>retain the question</command-args>'),
    })
    expect(inputOptions).toBeUndefined()
    await iterator.next()
    expect(inputOptions).toMatchObject({ input, uuid: 'current-command', skipSlashCommands: false })
  } finally {
    await iterator.return()
  }
})

test.each(['/secret credential', '/unknown', '/review', 'normal message', [{ type: 'text', text: '/compact' }, { type: 'image', source: {} }]].map(input => ({ input })))(
  'does not invent a local dispatch marker for non-local or sensitive input (%j)', async ({ input }) => {
    const iterator = engine().submitMessage(input as any)
    try {
      expect((await iterator.next()).value).not.toMatchObject({ type: 'system', subtype: 'local_command' })
    } finally { await iterator.return() }
  },
)

test('peer input retains literal slash text without a local command acknowledgement', async () => {
  const inbox = createSessionMessageInbox(() => {}, () => {})
  inbox.accept({ subtype: 'enqueue_session_message', message_id: 'compact-peer', sender_session_id: 'peer', text: '/compact' })
  const iterator = engine().submitMessage('/compact', { uuid: sessionMessageUuid('compact-peer'), isMeta: true })
  try {
    expect((await iterator.next()).value).not.toMatchObject({ type: 'system', subtype: 'local_command' })
    expect(inputOptions).toMatchObject({ skipSlashCommands: true, skipAttachments: true })
  } finally {
    await iterator.return()
    inbox.dispose()
  }
})
