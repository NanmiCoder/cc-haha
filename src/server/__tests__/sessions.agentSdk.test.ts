import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import { appendFile, mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { handleSessionsApi } from '../api/sessions.js'
import { markAgentSdkSession, readConversationRuntime } from '../services/officialAgentSdkRuntime.js'
import { sessionService } from '../services/sessionService.js'
import { getSideChat } from '../services/sideChatRegistry.js'
import { ProviderService } from '../services/providerService.js'

let directory: string
let previousHome: string | undefined
let previousConfig: string | undefined
beforeEach(async () => {
  previousHome = process.env.HOME
  previousConfig = process.env.CLAUDE_CONFIG_DIR
  directory = await mkdtemp(join(tmpdir(), 'sessions-agent-sdk-'))
  process.env.HOME = directory
  process.env.CLAUDE_CONFIG_DIR = directory
})
afterEach(async () => {
  mock.restore()
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfig
  await rm(directory, { recursive: true, force: true })
})

function request(sessionId: string, action: string, body: unknown): Promise<Response> {
  const url = new URL(`http://localhost/api/sessions/${sessionId}/${action}`)
  return handleSessionsApi(new Request(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }), url, ['api', 'sessions', sessionId, action])
}

async function nativeFixture() {
  const workDir = join(directory, 'project')
  await mkdir(workDir)
  const { sessionId } = await sessionService.createSession(workDir)
  markAgentSdkSession(directory, sessionId)
  await sessionService.appendSessionMetadata(sessionId, {
    workDir, customTitle: 'SDK project', runtimeProviderId: 'official-sdk-fixture',
    runtimeModelId: 'claude-haiku-5-5', effortLevel: 'low', permissionMode: 'default',
  })
  const info = (await sessionService.getSessionLaunchInfo(sessionId))!
  const ids = Array.from({ length: 4 }, () => crypto.randomUUID())
  const records = ids.map((uuid, index) => ({
    type: index % 2 ? 'assistant' : 'user', uuid, parentUuid: index ? ids[index - 1] : null,
    timestamp: new Date(Date.now() + index * 1000).toISOString(), cwd: workDir, sessionId,
    isSidechain: false, message: { role: index % 2 ? 'assistant' : 'user', content: [{ type: 'text', text: `native fixture ${index}` }] },
  }))
  await appendFile(info.filePath, [
    { type: 'session-meta', isMeta: true, fixtureExtension: { preserved: true } },
    ...records,
    { type: 'file-history-snapshot', messageId: ids[0], snapshot: { messageId: ids[0], trackedFileBackups: {} } },
  ].map(record => JSON.stringify(record)).join('\n') + '\n')
  return { sessionId, ids, records, info, workDir }
}

test('SDK branch uses native UUID remapping, preserves desktop config and engine, and leaves the parent unchanged', async () => {
  const source = await nativeFixture()
  const original = await readFile(source.info.filePath, 'utf8')
  const response = await request(source.sessionId, 'branch', { targetMessageId: source.ids[1] })
  expect(response.status).toBe(201)
  const result = await response.json() as { sessionId: string; title: string; workDir: string }
  expect(result).toMatchObject({ title: 'SDK project (Branch)', workDir: source.workDir })
  expect(readConversationRuntime(directory, result.sessionId)).toBe('agent-sdk')
  expect(await readFile(source.info.filePath, 'utf8')).toBe(original)
  const child = (await sessionService.getSessionLaunchInfo(result.sessionId))!
  expect(child).toMatchObject({
    runtimeProviderId: 'official-sdk-fixture', runtimeModelId: 'claude-haiku-5-5',
    effortLevel: 'low', permissionMode: 'default', transcriptMessageCount: 2,
  })
  const records = (await readFile(child.filePath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  expect(records.some(entry => entry.type === 'file-history-snapshot')).toBe(false)
  expect(records.find(entry => entry.fixtureExtension)).toMatchObject({ fixtureExtension: { preserved: true } })
  const messages = records.filter(entry => entry.type === 'user' || entry.type === 'assistant')
  expect(messages).toHaveLength(2)
  expect(messages.every(entry => !source.ids.includes(entry.uuid) && entry.sessionId === result.sessionId)).toBe(true)
  expect(messages[0].parentUuid).toBeNull()
  expect(messages[1].parentUuid).toBe(messages[0].uuid)
  expect(messages.map(entry => entry.forkedFrom.messageUuid)).toEqual(source.ids.slice(0, 2))
  expect(records.some(entry => JSON.stringify(entry).includes('native fixture 2'))).toBe(false)
})

test('SDK branch refuses an unknown or sidechain boundary without creating child files', async () => {
  const source = await nativeFixture()
  const sideId = crypto.randomUUID()
  await appendFile(source.info.filePath, JSON.stringify({ ...source.records[3], uuid: sideId, isSidechain: true }) + '\n')
  const before = await readdir(dirname(source.info.filePath))
  for (const targetMessageId of [crypto.randomUUID(), sideId]) {
    expect((await request(source.sessionId, 'branch', { targetMessageId })).status).toBe(400)
  }
  expect(await readdir(dirname(source.info.filePath))).toEqual(before)
  expect(await readdir(join(directory, 'cc-haha', 'session-runtimes'))).toEqual([`${source.sessionId}.json`])
})

test('SDK side chats capture the main native history boundary and inherited config without creating a transcript', async () => {
  const source = await nativeFixture()
  const original = await readFile(source.info.filePath, 'utf8')
  const response = await request(source.sessionId, 'side-chats', {})
  expect(response.status).toBe(200)
  const result = await response.json() as { sessionId: string }
  const side = getSideChat(result.sessionId)!
  expect(side).toMatchObject({ parentSessionId: source.sessionId, resumePath: source.info.filePath, resumeAt: source.ids[3], started: false })
  expect(side.launchInfo).toMatchObject({ filePath: '', runtimeProviderId: 'official-sdk-fixture', runtimeModelId: 'claude-haiku-5-5', effortLevel: 'low' })
  expect(await readFile(source.info.filePath, 'utf8')).toBe(original)
  expect(await readdir(dirname(source.info.filePath))).toEqual([`${source.sessionId}.jsonl`])
})

test('SDK side chat forks include trailing native system records instead of cutting at the assistant bubble', async () => {
  const source = await nativeFixture()
  const boundary = crypto.randomUUID()
  await appendFile(source.info.filePath, JSON.stringify({
    type: 'system', subtype: 'turn_duration', uuid: boundary, parentUuid: source.ids[3],
    sessionId: source.sessionId, timestamp: new Date(Date.now() + 10_000).toISOString(),
    durationMs: 10, isSidechain: false,
  }) + '\n')
  const response = await request(source.sessionId, 'side-chats', {})
  expect(response.status).toBe(200)
  const result = await response.json() as { sessionId: string }
  expect(getSideChat(result.sessionId)?.resumeAt).toBe(boundary)
})

test('unmarked legacy sessions continue through the existing branch validation', async () => {
  const launch = spyOn(sessionService, 'getSessionLaunchInfo').mockResolvedValue(null)
  const response = await request(crypto.randomUUID(), 'branch', { targetMessageId: 'fixture-user-message' })
  expect(response.status).toBe(404)
  expect(launch).toHaveBeenCalled()
  expect(await readdir(directory)).toEqual([])
})

test('explicit legacy import creates a new pinned SDK branch without changing original history or runtime', async () => {
  const source = await nativeFixture()
  await rm(join(directory, 'cc-haha', 'session-runtimes', `${source.sessionId}.json`))
  spyOn(ProviderService.prototype, 'getProvider').mockResolvedValue({
    id: 'sdk-import-provider', runtime: 'agent-sdk', baseUrl: 'https://api.anthropic.com',
    apiFormat: 'anthropic', authStrategy: 'api_key', apiKey: 'fake-sdk-key', models: { main: 'claude-haiku-5-5' },
  } as Awaited<ReturnType<ProviderService['getProvider']>>)
  const original = await readFile(source.info.filePath, 'utf8')
  const response = await request(source.sessionId, 'branch', { targetMessageId: source.ids[1], agentSdk: { providerId: 'sdk-import-provider' } })
  expect(response.status).toBe(201)
  const result = await response.json() as { sessionId: string; title: string }
  expect(result.title).toBe('SDK project (Agent SDK) (Branch)')
  expect(readConversationRuntime(directory, source.sessionId)).toBe('claude-code')
  expect(readConversationRuntime(directory, result.sessionId)).toBe('agent-sdk')
  expect(await readFile(source.info.filePath, 'utf8')).toBe(original)
  const child = (await sessionService.getSessionLaunchInfo(result.sessionId))!
  expect(child).toMatchObject({ runtimeProviderId: 'sdk-import-provider', runtimeModelId: 'claude-haiku-5-5', permissionMode: 'default' })
  const text = await readFile(child.filePath, 'utf8')
  expect(text).toContain('native fixture 0')
  expect(text).not.toContain('native fixture 2')
  expect(text).toContain('importedFrom')
})

test('legacy import rejects invalid providers and unfinished historical tools without creating an SDK branch', async () => {
  const source = await nativeFixture()
  await rm(join(directory, 'cc-haha', 'session-runtimes', `${source.sessionId}.json`))
  const provider = spyOn(ProviderService.prototype, 'getProvider').mockResolvedValue({ runtime: 'claude-code' } as Awaited<ReturnType<ProviderService['getProvider']>>)
  expect((await request(source.sessionId, 'branch', { targetMessageId: source.ids[1], agentSdk: { providerId: 'legacy' } })).status).toBe(400)
  provider.mockResolvedValue({ id: 'sdk', runtime: 'agent-sdk', baseUrl: 'https://api.anthropic.com', apiFormat: 'anthropic', authStrategy: 'api_key', apiKey: 'fake', models: { main: 'claude-haiku-5-5' } } as Awaited<ReturnType<ProviderService['getProvider']>>)
  const pendingId = crypto.randomUUID()
  await appendFile(source.info.filePath, JSON.stringify({ ...source.records[3], uuid: pendingId, parentUuid: source.ids[3], message: { role: 'assistant', content: [{ type: 'tool_use', id: 'unfinished', name: 'Write', input: {} }] } }) + '\n')
  const before = await readdir(dirname(source.info.filePath))
  expect((await request(source.sessionId, 'branch', { targetMessageId: pendingId, agentSdk: { providerId: 'sdk' } })).status).toBe(400)
  expect(await readdir(dirname(source.info.filePath))).toEqual(before)
  expect(await readdir(join(directory, 'cc-haha', 'session-runtimes'))).toEqual([])
})


test('SDK history normalizes owned tool names for desktop rendering while preserving native disk records', async () => {
  const source = await nativeFixture()
  await appendFile(source.info.filePath, JSON.stringify({
    ...source.records[3], uuid: crypto.randomUUID(), parentUuid: source.ids[3],
    message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'native-team-tool', name: 'mcp__cc_haha__TeamCreate', input: { team_name: 'owned' } },
      { type: 'tool_use', id: 'foreign-team-tool', name: 'mcp__other__TeamCreate', input: { team_name: 'foreign' } },
    ] },
  }) + '\n')
  const raw = await readFile(source.info.filePath, 'utf8')
  const messages = await sessionService.getSessionMessages(source.sessionId, { includeSubagents: false })
  const tools = messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
    .filter(block => typeof block === 'object' && block.type === 'tool_use') as { name: string }[]
  expect(tools.map(tool => tool.name)).toEqual(['TeamCreate', 'mcp__other__TeamCreate'])
  expect(await readFile(source.info.filePath, 'utf8')).toBe(raw)
})
