import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionService } from './sessionService.js'
import { HISTORY_SCAN_BYTES } from './boundedSessionHistory.js'

let directory: string
let configBefore: string | undefined
let file: string
let service: SessionService
const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const entry = (type: string, uuid: string, content: unknown, extra: object = {}) => ({ type, uuid, message: { role: type, content }, timestamp: '2026-01-01T00:00:00.000Z', ...extra })
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'recovery-history-test-'))
  configBefore = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = directory
  const project = join(directory, 'projects', '-tmp-history')
  await mkdir(project, { recursive: true })
  file = join(project, `${id}.jsonl`)
  service = new SessionService({ getMode: () => 'off' } as any)
})
afterEach(async () => {
  if (configBefore === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = configBefore
  await rm(directory, { recursive: true, force: true })
})

test('recovery retains goal and todo evidence outside the visible tail, including dismissal boundary and exact usage deduplication', async () => {
  const entries = [
    { type: 'system', subtype: 'local_command', uuid: 'goal', content: '<local-command-stdout>Goal set: finish project</local-command-stdout>', timestamp: '2026-01-01T00:00:00.000Z' },
    entry('assistant', 'todo', [{ type: 'tool_use', id: 'todo-use', name: 'TodoWrite', input: { todos: [{ content: 'finish project', status: 'completed' }] } }]),
    entry('user', 'after-todo', 'next task'),
    ...Array.from({ length: 24 }, (_, index) => entry('assistant', `body-${index}`, [{ type: 'text', text: 'x'.repeat(256 * 1024) }], {
      version: '1.0.0', sessionId: id, requestId: 'one-request',
      message: { role: 'assistant', id: 'one-reply', content: [{ type: 'text', text: 'x'.repeat(256 * 1024) }], usage: { input_tokens: 10, output_tokens: 20 } },
    })),
  ]
  await writeFile(file, entries.map(value => JSON.stringify(value)).join('\n') + '\n')
  const page = await service.getSessionHistoryPage(id)
  expect(page.page.hasMore).toBe(true)
  expect(page.page.scannedBytes).toBeLessThanOrEqual(HISTORY_SCAN_BYTES)
  const referenced = await service.getSessionHistoryPage(id, { projectContext: false })
  expect(referenced.page.contextScanBytes).toBe(0)
  expect(referenced.messages.map(message => message.id)).toEqual(page.messages.map(message => message.id))
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(2 * 1024 * 1024)
  expect(page.messages.every(message => message.id.startsWith('body-'))).toBe(true)
  const recovery = await service.getSessionHistoryRecovery(id)
  expect(recovery.status).toBe('ready')
  expect(recovery.messages.map(message => message.id)).toEqual(['goal', 'todo', 'after-todo'])
  expect(recovery.tokenUsage).toMatchObject({ input_tokens: 10, output_tokens: 20 })
  expect(Buffer.byteLength(JSON.stringify(recovery))).toBeLessThan(16 * 1024)
})

test('recovery retains tool lifecycle ownership and does not revive child tools as root work', async () => {
  await writeFile(file, [
    entry('assistant', 'root-call', [{ type: 'tool_use', id: 'agent-1', name: 'Agent', input: { description: 'inspect' } }]),
    entry('assistant', 'child-call', [{ type: 'tool_use', id: 'child-bash', name: 'Bash', input: { command: 'sleep 1', run_in_background: true } }], { parent_tool_use_id: 'agent-1' }),
    entry('user', 'child-result', [{ type: 'tool_result', tool_use_id: 'child-bash', content: 'background task' }], { parentUuid: 'child-call', isSidechain: true }),
    entry('user', 'root-result', [{ type: 'tool_result', tool_use_id: 'agent-1', content: 'done' }]),
  ].map(value => JSON.stringify(value)).join('\n') + '\n')
  const recovery = await service.getSessionHistoryRecovery(id)
  expect(recovery.status).toBe('ready')
  expect(recovery.messages.map(message => message.id)).toEqual(['root-call'])
})

test('oversized evidence is explicitly incomplete and cancellation never returns an authoritative snapshot', async () => {
  await writeFile(file, JSON.stringify(entry('assistant', 'huge', [{ type: 'text', text: 'x'.repeat(9 * 1024 * 1024) }])) + '\n')
  const recovery = await service.getSessionHistoryRecovery(id)
  expect(recovery.status).toBe('incomplete')
  expect(recovery.omittedRecords).toBe(1)
  const controller = new AbortController()
  controller.abort()
  await expect(service.getSessionHistoryRecovery(id, { signal: controller.signal })).rejects.toThrow()
})


test('large foreground shell output and old Todo writes do not poison scalar recovery; workspace limits are independent', async () => {
  await writeFile(file, [
    ...Array.from({ length: 80 }, (_, index) => entry('assistant', `todo-${index}`, [{ type: 'tool_use', id: `todo-${index}`, name: 'TodoWrite', input: { todos: [{ content: `todo ${index}`, status: 'pending' }] } }])),
    entry('assistant', 'shell', [{ type: 'tool_use', id: 'shell', name: 'Bash', input: { command: 'cat file' } }]),
    entry('user', 'shell-result', [{ type: 'tool_result', tool_use_id: 'shell', content: 'x'.repeat(256 * 1024) }]),
    entry('assistant', 'write', [{ type: 'tool_use', id: 'write', name: 'Write', input: { file_path: '/tmp/file', content: 'x'.repeat(128 * 1024) } }]),
  ].map(value => JSON.stringify(value)).join('\n') + '\n')
  const recovery = await service.getSessionHistoryRecovery(id)
  expect(recovery.completeness).toEqual({ goal: true, todos: true, usage: true, activity: true, workspace: false })
  expect(recovery.messages.filter(message => message.id.startsWith('todo-')).map(message => message.id)).toEqual(['todo-79'])
  expect(Buffer.byteLength(JSON.stringify(recovery))).toBeLessThan(16 * 1024)
})

test('launch metadata, title, work directory and metadata appends never materialize transcript history', async () => {
  await writeFile(file, [
    { type: 'session-meta', workDir: '/tmp/history' },
    { type: 'custom-title', customTitle: 'large history' },
    ...Array.from({ length: 24 }, (_, index) => entry('assistant', `body-${index}`, 'x'.repeat(256 * 1024))),
  ].map(value => JSON.stringify(value)).join('\n') + '\n')
  ;(service as any).readJsonlFile = () => { throw new Error('unbounded transcript read') }
  const [launch, workDir, title] = await Promise.all([service.getSessionLaunchInfo(id), service.getSessionWorkDir(id), service.getCustomTitle(id)])
  expect(launch?.transcriptMessageCount).toBe(24)
  expect(workDir).toBe('/tmp/history')
  expect(title).toBe('large history')
  await service.appendSessionMetadata(id, { workDir: '/tmp/history', customTitle: 'updated title' })
  expect(await service.getCustomTitle(id)).toBe('updated title')
})


test('history pages preserve cross-page notification suppression and sidechain ownership, and index only appended bytes', async () => {
  const notification = '<task-notification><task-id>task</task-id><tool-use-id>agent</tool-use-id><status>completed</status></task-notification>'
  await writeFile(file, [
    entry('assistant', 'owner', [{ type: 'tool_use', id: 'agent', name: 'Agent', input: {} }]),
    entry('assistant', 'child', 'child response', { isSidechain: true, parentUuid: 'owner' }),
    entry('user', 'notice', notification),
    entry('assistant', 'hidden', 'internal notification response'),
  ].map(value => JSON.stringify(value)).join('\n') + '\n')
  const latest = await service.getSessionHistoryPage(id, { limit: 1 })
  expect(latest.messages).toEqual([])
  expect(latest.page.contextScanBytes).toBeGreaterThan(0)
  const noticePage = await service.getSessionHistoryPage(id, { limit: 1, cursor: latest.page.nextCursor! })
  expect(noticePage.messages).toEqual([])
  const childPage = await service.getSessionHistoryPage(id, { limit: 1, cursor: noticePage.page.nextCursor! })
  expect(childPage.messages).toMatchObject([{ id: 'child', parentToolUseId: 'agent' }])
  expect(childPage.page.contextScanBytes).toBe(0)
  const suffix = JSON.stringify(entry('user', 'real-user', 'continue', { parentUuid: 'child' })) + '\n'
  await appendFile(file, suffix)
  const appended = await service.getSessionHistoryPage(id, { limit: 1 })
  expect(appended.messages).toMatchObject([{ id: 'real-user' }])
  expect(appended.messages[0]!.parentToolUseId).toBeUndefined()
  expect(appended.page.contextScanBytes).toBe(Buffer.byteLength(suffix))
})

test('recovery resolves sidechain ancestry through Agent calls without attaching ordinary root descendants', async () => {
  await writeFile(file, [
    entry('assistant', 'owner', [{ type: 'tool_use', id: 'agent', name: 'Agent', input: {} }]),
    entry('assistant', 'child', [{ type: 'tool_use', id: 'child-todo', name: 'TodoWrite', input: { todos: [{ content: 'child work', status: 'pending' }] } }], { isSidechain: true, parentUuid: 'owner' }),
    entry('assistant', 'root', [{ type: 'tool_use', id: 'root-todo', name: 'TodoWrite', input: { todos: [{ content: 'root work', status: 'pending' }] } }], { parentUuid: 'child' }),
  ].map(value => JSON.stringify(value)).join('\n') + '\n')
  const recovered = await service.getSessionHistoryRecovery(id)
  expect(recovered.messages.map(message => message.id)).toEqual(['owner', 'root'])
})


test('a multi-megabyte foreground tool output preserves complete paged messages and does not degrade recovery', async () => {
  await writeFile(file, [
    entry('assistant', 'call', [{ type: 'tool_use', id: 'bash', name: 'Bash', input: { command: 'cat large-log' } }]),
    entry('user', 'result', [{ type: 'tool_result', tool_use_id: 'bash', content: 'x'.repeat(4 * 1024 * 1024) }]),
    ...Array.from({ length: 158 }, (_, index) => entry('assistant', `reply-${index}`, 'ok')),
  ].map(value => JSON.stringify(value)).join('\n') + '\n')
  const latest = await service.getSessionHistoryPage(id)
  expect(latest.messages).toHaveLength(158)
  const large = await service.getSessionHistoryPage(id, { cursor: latest.page.nextCursor! })
  expect(large.messages).toHaveLength(1)
  expect(large.messages[0]).toMatchObject({ id: 'result', content: [{ type: 'tool_result', tool_use_id: 'bash', content: 'x'.repeat(4 * 1024 * 1024) }] })
  expect(large.messages[0]?.bodyTruncated).toBeUndefined()
  expect(large.page.omittedOversizedEntries).toBe(0)
  const oldest = await service.getSessionHistoryPage(id, { cursor: large.page.nextCursor! })
  expect(oldest.messages.map(message => message.id)).toEqual(['call'])
  expect(oldest.page.nextCursor).toBeNull()
  expect([...oldest.messages, ...large.messages, ...latest.messages]).toHaveLength(160)
  const recovery = await service.getSessionHistoryRecovery(id)
  expect(recovery.status).toBe('ready')
  expect(recovery.omittedRecords).toBe(0)
  expect((await service.getSessionLaunchInfo(id))?.transcriptMessageCount).toBe(160)
})
