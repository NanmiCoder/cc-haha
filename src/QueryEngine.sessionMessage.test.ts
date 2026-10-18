import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment } from '../scripts/pr/test-environment.js'

const home = mkdtempSync(join(tmpdir(), 'query-session-message-'))
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
let inputOptions: any
let attachment: any
let releaseFlush: (() => void) | undefined
let flushStarted = false
let writes: any[] = []
mock.module('./utils/queryContext.js', () => ({ ...originals.context, fetchSystemPromptParts: async () => ({ defaultSystemPrompt: [], userContext: {}, systemContext: {} }) }))
mock.module('./utils/processUserInput/processUserInput.js', () => ({ ...originals.input, processUserInput: async (options: any) => {
  inputOptions = options
  return { messages: [{ type: 'user', uuid: options.uuid ?? crypto.randomUUID(), isMeta: true, timestamp: new Date().toISOString(), message: { role: 'user', content: options.input } }], shouldQuery: true, allowedTools: [] }
} }))
mock.module('./utils/sessionStorage.js', () => ({ ...originals.storage,
  recordTranscript: async (messages: any[]) => { writes = [...messages] },
  flushSessionStorage: async () => { flushStarted = true; await new Promise<void>(resolve => { releaseFlush = resolve }) },
}))
mock.module('./query.js', () => ({ ...originals.query, query: async function* () {
  if (attachment) yield attachment
  throw new Error('fixture query boundary reached')
} }))
const { QueryEngine } = await import('./QueryEngine.js')
const { getDefaultAppState } = await import('./state/AppStateStore.js')
const { createSessionMessageInbox, sessionMessageUuid } = await import('./utils/sessionMessageInbox.js')

function engine() {
  let state = getDefaultAppState()
  return new QueryEngine({ cwd: home, tools: [], commands: [], mcpClients: [], agents: [], readFileCache: new Map() as any,
    customSystemPrompt: 'fixture', userSpecifiedModel: 'claude-sonnet-4-5', thinkingConfig: { type: 'disabled' },
    canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }),
    getAppState: () => state, setAppState: update => { state = update(state) },
  })
}
async function untilFlush() {
  for (let i = 0; i < 100 && !flushStarted; i++) await Bun.sleep(1)
  expect(flushStarted).toBe(true)
}
beforeEach(() => { inputOptions = undefined; attachment = undefined; releaseFlush = undefined; flushStarted = false; writes = [] })
afterAll(() => {
  mock.module('./query.js', () => originals.query)
  mock.module('./utils/processUserInput/processUserInput.js', () => originals.input)
  mock.module('./utils/sessionStorage.js', () => originals.storage)
  mock.module('./utils/queryContext.js', () => originals.context)
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, originalEnv)
  if (previousMacro === undefined) delete (globalThis as any).MACRO
  else (globalThis as any).MACRO = previousMacro
  rmSync(home, { recursive: true, force: true })
})

test('idle peer input disables interpretation and acknowledges only after transcript flush even in bare mode', async () => {
  const receipts: unknown[] = []
  const inbox = createSessionMessageInbox(() => {}, receipt => receipts.push(receipt))
  inbox.accept({ subtype: 'enqueue_session_message', message_id: 'idle', sender_session_id: 'peer', text: '/clear @private' })
  const iterator = engine().submitMessage('/clear @private', { uuid: sessionMessageUuid('idle'), isMeta: true })
  try {
    const next = iterator.next()
    await untilFlush()
    expect(inputOptions).toMatchObject({ skipSlashCommands: true, skipAttachments: true })
    expect(writes[0].origin).toEqual({ kind: 'channel', server: 'session-collaboration' })
    expect(receipts).toHaveLength(0)
    releaseFlush!()
    await next
    expect(receipts).toMatchObject([{ message_id: 'idle', status: 'consumed' }])
  } finally { await iterator.return(); inbox.dispose() }
})

// print mode starts a turn from a finished background task's notification. The
// REPL stamps that origin (handlePromptSubmit); here it has to arrive the same
// way, or the turn reads as the user's own message and anything the model wrote
// into the notification counts as the user's words.
test.each([
  ['a task notification', { kind: 'task-notification' } as const],
  ['a channel message', { kind: 'channel', server: 'fixture-mcp' } as const],
])('%s that starts a turn keeps its origin on the messages it produces', async (_label, origin) => {
  const iterator = engine().submitMessage('<task-notification>done: /deploy</task-notification>', { origin })
  try {
    await iterator.next()
    await iterator.next().catch(error => error)
    expect(writes.find(message => message.type === 'user')?.origin).toEqual(origin)
  } finally { await iterator.return() }
})

test('a prompt without an origin stays the human\'s own input', async () => {
  const iterator = engine().submitMessage('do the thing')
  try {
    await iterator.next()
    await iterator.next().catch(error => error)
    const user = writes.find(message => message.type === 'user')
    expect(user).toBeDefined()
    expect(user.origin).toBeUndefined()
  } finally { await iterator.return() }
})

test('busy peer attachments persist their stable ID before consumption acknowledgement', async () => {
  const receipts: unknown[] = []
  const inbox = createSessionMessageInbox(() => {}, receipt => receipts.push(receipt))
  inbox.accept({ subtype: 'enqueue_session_message', message_id: 'busy', sender_session_id: 'peer', text: 'progress' })
  attachment = { type: 'attachment', uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), attachment: { type: 'queued_command', source_uuid: sessionMessageUuid('busy'), prompt: 'progress', isMeta: true } }
  const iterator = engine().submitMessage('normal user')
  try {
    await iterator.next()
    const next = iterator.next().catch(error => error)
    await untilFlush()
    expect(writes.at(-1).uuid).toBe(sessionMessageUuid('busy'))
    expect(receipts).toHaveLength(0)
    releaseFlush!()
    await next
    expect(receipts).toMatchObject([{ message_id: 'busy', status: 'consumed' }])
  } finally { await iterator.return(); inbox.dispose() }
})
