import { afterEach, beforeEach, expect, test } from 'bun:test'
import { appendFile, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readHistoryContexts, stopHistoryContexts } from './sessionHistoryContext.js'

let directory: string
let file: string
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'history-context-test-')); file = join(directory, 'session.jsonl') })
afterEach(async () => { await stopHistoryContexts(); await rm(directory, { recursive: true, force: true }) })
const row = (id: string, fields: object = {}) => JSON.stringify({ uuid: id, ...fields })
const version = async (filePath = file) => { const info = await stat(filePath, { bigint: true }); return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}` }
const agentToolId = (entry: Record<string, unknown>) => typeof entry.agent === 'string' ? entry.agent : undefined
const messageAgentToolId = (entry: Record<string, unknown>) => {
  const content = (entry.message as { content?: unknown } | undefined)?.content
  const blocks = Array.isArray(content) ? content : []
  return blocks.find(block => block.type === 'tool_use' && ['Agent', 'Task'].includes(block.name))?.id as string | undefined
}

test('releases cached context databases at shutdown and rebuilds on restart', async () => {
  await writeFile(file, row('side', { isSidechain: true }) + '\n')
  const options = { filePath: file, sourceVersion: await version(), offsets: [0], agentToolId }
  const initial = await readHistoryContexts(options)
  expect((await readHistoryContexts(options)).scannedBytes).toBe(0)
  await stopHistoryContexts()
  await stopHistoryContexts()
  const restarted = await readHistoryContexts(options)
  expect(restarted.contexts).toEqual(initial.contexts)
  expect(restarted.scannedBytes).toBe(initial.scannedBytes)
  expect(restarted.scannedBytes).toBeGreaterThan(0)
})

test('root reads hide unowned sidechains while a child transcript keeps them, from one shared scan', async () => {
  const entries = [
    row('owner', { agent: 'agent-tool' }),
    row('owned', { isSidechain: true, parentUuid: 'owner' }),
    row('orphan', { isSidechain: true }),
    row('root'),
  ]
  await writeFile(file, entries.join('\n') + '\n')
  const offsets = entries.map((_, index) => Buffer.byteLength(entries.slice(0, index).map(value => value + '\n').join('')))
  const options = { filePath: file, sourceVersion: await version(), offsets, agentToolId }
  const root = await readHistoryContexts(options)
  expect([...root.contexts.values()]).toEqual([
    { owner: undefined, hidden: false },
    { owner: 'agent-tool', hidden: false },
    { owner: undefined, hidden: true },
    { owner: undefined, hidden: false },
  ])
  const child = await readHistoryContexts({ ...options, includeUnownedSidechains: true })
  expect(child.scannedBytes).toBe(0)
  expect([...child.contexts.values()].map(context => context.hidden)).toEqual([false, false, false, false])
  expect([...((await readHistoryContexts(options)).contexts.values())].map(context => context.hidden)).toEqual([false, false, true, false])
})

test('indexes EOF records and resumes at their boundary when a newline and new records are appended', async () => {
  const first = row('owner', { agent: 'agent-tool' }) + '\n'
  const partial = row('child', { isSidechain: true, parentUuid: 'owner' })
  await writeFile(file, first + partial)
  const before = await readHistoryContexts({ filePath: file, sourceVersion: await version(), offsets: [0, Buffer.byteLength(first)], agentToolId })
  expect(before.contexts.get(0)).toEqual({ owner: undefined, hidden: false })
  expect(before.contexts.get(Buffer.byteLength(first))).toEqual({ owner: 'agent-tool', hidden: false })
  const suffix = '\n' + row('assistant') + '\n'
  await appendFile(file, suffix)
  const after = await readHistoryContexts({ filePath: file, sourceVersion: await version(), offsets: [Buffer.byteLength(first + partial + '\n')], agentToolId })
  expect(after.scannedBytes).toBe(Buffer.byteLength(partial + suffix))
  expect([...after.contexts.values()]).toEqual([{ owner: undefined, hidden: false }])
})

test('joins concurrent builds and cancelling one subscriber does not cancel the remaining reader', async () => {
  await writeFile(file, Array.from({ length: 128 }, (_, index) => row(String(index)) + '\n').join(''))
  const sourceVersion = await version()
  const controller = new AbortController()
  let visits = 0
  const observed = (entry: Record<string, unknown>) => { visits++; if (visits === 1) controller.abort(); return agentToolId(entry) }
  const first = readHistoryContexts({ filePath: file, sourceVersion, offsets: [0], signal: controller.signal, agentToolId: observed }).catch(error => error)
  const second = readHistoryContexts({ filePath: file, sourceVersion, offsets: [0], agentToolId: observed })
  expect((await first).name).toBe('AbortError')
  expect((await second).contexts.get(0)?.hidden).toBe(false)
  expect(visits).toBe(128)
  expect((await readHistoryContexts({ filePath: file, sourceVersion, offsets: [0], agentToolId })).scannedBytes).toBe(0)
})

test('replacing a transcript invalidates old scalar state and rejects stale page identities', async () => {
  await writeFile(file, row('side', { isSidechain: true }) + '\n')
  const oldVersion = await version()
  expect((await readHistoryContexts({ filePath: file, sourceVersion: oldVersion, offsets: [0], agentToolId })).contexts.get(0)?.hidden).toBe(true)
  await writeFile(file + '.new', row('new') + '\n')
  await rename(file + '.new', file)
  const fresh = await readHistoryContexts({ filePath: file, sourceVersion: await version(), offsets: [0], agentToolId })
  expect(fresh.contexts.get(0)?.hidden).toBe(false)
  await expect(readHistoryContexts({ filePath: file, sourceVersion: oldVersion, offsets: [0], agentToolId })).rejects.toMatchObject({ statusCode: 409 })
})

test('bounds queued file builds and cleans a fully cancelled scan for subsequent retry', async () => {
  const files = Array.from({ length: 6 }, (_, index) => join(directory, `${index}.jsonl`))
  await Promise.all(files.map(filePath => writeFile(filePath, row('one') + '\n' + row('two') + '\n')))
  const versions = await Promise.all(files.map(filePath => version(filePath)))
  const requests = files.slice(0, 5).map((filePath, index) => readHistoryContexts({ filePath, sourceVersion: versions[index]!, offsets: [0], agentToolId }))
  await expect(readHistoryContexts({ filePath: files[5]!, sourceVersion: versions[5]!, offsets: [0], agentToolId })).rejects.toMatchObject({ statusCode: 429 })
  await Promise.all(requests)
  const controller = new AbortController()
  await expect(readHistoryContexts({ filePath: files[5]!, sourceVersion: versions[5]!, offsets: [0], signal: controller.signal, agentToolId: entry => { controller.abort(); return agentToolId(entry) } })).rejects.toThrow()
  expect((await readHistoryContexts({ filePath: files[5]!, sourceVersion: versions[5]!, offsets: [0], agentToolId })).contexts.get(0)?.hidden).toBe(false)
})


test('rebuilds scalar context after an in-place rewrite grows beyond the cached snapshot', async () => {
  await writeFile(file, row('side', { isSidechain: true }) + '\n')
  await readHistoryContexts({ filePath: file, sourceVersion: await version(), offsets: [0], agentToolId })
  await writeFile(file, row('replacement') + '\n' + row('more-records') + '\n')
  const rebuilt = await readHistoryContexts({ filePath: file, sourceVersion: await version(), offsets: [0], agentToolId })
  expect(rebuilt.contexts.get(0)?.hidden).toBe(false)
  expect(rebuilt.scannedBytes).toBe(Number((await stat(file)).size))
})

test('oversized Agent input preserves the sidechain owner for later small records', async () => {
  const parent = row('parent', { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'agent-tool', name: 'Agent', input: { prompt: 'x'.repeat(9 * 1024 * 1024) } }] } }) + '\n'
  const child = row('child', { type: 'assistant', parentUuid: 'parent', isSidechain: true, message: { role: 'assistant', content: 'Child result' } }) + '\n'
  await writeFile(file, parent + child)
  const offset = Buffer.byteLength(parent)
  const contexts = await readHistoryContexts({ filePath: file, sourceVersion: await version(), offsets: [offset], agentToolId: messageAgentToolId })
  expect(contexts.contexts.get(offset)).toEqual({ owner: 'agent-tool', hidden: false })
})

test('a malformed oversized record does not disturb the records after it', async () => {
  const malformed = '{"message":{"content":"' + 'x'.repeat(9 * 1024 * 1024) + '\n'
  const reply = row('reply', { type: 'assistant', message: { role: 'assistant', content: 'Still visible' } }) + '\n'
  await writeFile(file, malformed + reply)
  const offset = Buffer.byteLength(malformed)
  const contexts = await readHistoryContexts({ filePath: file, sourceVersion: await version(), offsets: [offset], agentToolId: messageAgentToolId })
  expect(contexts.contexts.get(offset)).toEqual({ owner: undefined, hidden: false })
})
