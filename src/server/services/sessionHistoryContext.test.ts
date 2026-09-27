import { afterEach, beforeEach, expect, test } from 'bun:test'
import { appendFile, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readHistoryContexts } from './sessionHistoryContext.js'

let directory: string
let file: string
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'history-context-test-')); file = join(directory, 'session.jsonl') })
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })
const row = (id: string, fields: object = {}) => JSON.stringify({ uuid: id, ...fields })
const version = async (filePath = file) => { const info = await stat(filePath, { bigint: true }); return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}` }
const classify = (entry: Record<string, unknown>) => ({ notification: entry.notification === true, reset: entry.reset === true, agentToolId: typeof entry.agent === 'string' ? entry.agent : undefined })

test('subagent visibility keeps unowned sidechains without bypassing cached notification suppression', async () => {
  const entries = [
    row('user', { isSidechain: true, reset: true }),
    row('notice', { isSidechain: true, notification: true }),
    row('hidden', { isSidechain: true, parentUuid: 'notice' }),
    row('next', { isSidechain: true, reset: true }),
  ]
  await writeFile(file, entries.join('\n') + '\n')
  const offsets = entries.map((_, index) => Buffer.byteLength(entries.slice(0, index).map(value => value + '\n').join('')))
  const options = { filePath: file, sourceVersion: await version(), offsets, classify }
  const root = await readHistoryContexts(options)
  expect([...root.contexts.values()].map(context => context.suppressed)).toEqual([true, true, true, true])
  const child = await readHistoryContexts({ ...options, includeUnownedSidechains: true })
  expect(child.scannedBytes).toBe(0)
  expect([...child.contexts.values()].map(context => context.suppressed)).toEqual([false, true, true, false])
  expect([...((await readHistoryContexts(options)).contexts.values())].every(context => context.suppressed)).toBe(true)
})

test('indexes EOF records and resumes at their boundary when a newline and new records are appended', async () => {
  const first = row('notification', { notification: true }) + '\n'
  const partial = row('user', { reset: true })
  await writeFile(file, first + partial)
  const before = await readHistoryContexts({ filePath: file, sourceVersion: await version(), offsets: [0, Buffer.byteLength(first)], classify })
  expect(before.contexts.get(0)?.suppressed).toBe(true)
  expect(before.contexts.get(Buffer.byteLength(first))?.suppressed).toBe(false)
  const suffix = '\n' + row('assistant') + '\n'
  await appendFile(file, suffix)
  const after = await readHistoryContexts({ filePath: file, sourceVersion: await version(), offsets: [Buffer.byteLength(first + partial + '\n')], classify })
  expect(after.scannedBytes).toBe(Buffer.byteLength(partial + suffix))
  expect([...after.contexts.values()]).toEqual([{ owner: undefined, suppressed: false }])
})

test('joins concurrent builds and cancelling one subscriber does not cancel the remaining reader', async () => {
  await writeFile(file, Array.from({ length: 128 }, (_, index) => row(String(index)) + '\n').join(''))
  const sourceVersion = await version()
  const controller = new AbortController()
  let visits = 0
  const observed = (entry: Record<string, unknown>) => { visits++; if (visits === 1) controller.abort(); return classify(entry) }
  const first = readHistoryContexts({ filePath: file, sourceVersion, offsets: [0], signal: controller.signal, classify: observed }).catch(error => error)
  const second = readHistoryContexts({ filePath: file, sourceVersion, offsets: [0], classify: observed })
  expect((await first).name).toBe('AbortError')
  expect((await second).contexts.get(0)?.suppressed).toBe(false)
  expect(visits).toBe(128)
  expect((await readHistoryContexts({ filePath: file, sourceVersion, offsets: [0], classify })).scannedBytes).toBe(0)
})

test('replacing a transcript invalidates old scalar state and rejects stale page identities', async () => {
  await writeFile(file, row('notice', { notification: true }) + '\n')
  const oldVersion = await version()
  await readHistoryContexts({ filePath: file, sourceVersion: oldVersion, offsets: [0], classify })
  await writeFile(file + '.new', row('new') + '\n')
  await rename(file + '.new', file)
  const fresh = await readHistoryContexts({ filePath: file, sourceVersion: await version(), offsets: [0], classify })
  expect(fresh.contexts.get(0)?.suppressed).toBe(false)
  await expect(readHistoryContexts({ filePath: file, sourceVersion: oldVersion, offsets: [0], classify })).rejects.toMatchObject({ statusCode: 409 })
})

test('bounds queued file builds and cleans a fully cancelled scan for subsequent retry', async () => {
  const files = Array.from({ length: 6 }, (_, index) => join(directory, `${index}.jsonl`))
  await Promise.all(files.map(filePath => writeFile(filePath, row('one') + '\n' + row('two') + '\n')))
  const versions = await Promise.all(files.map(filePath => version(filePath)))
  const requests = files.slice(0, 5).map((filePath, index) => readHistoryContexts({ filePath, sourceVersion: versions[index]!, offsets: [0], classify }))
  await expect(readHistoryContexts({ filePath: files[5]!, sourceVersion: versions[5]!, offsets: [0], classify })).rejects.toMatchObject({ statusCode: 429 })
  await Promise.all(requests)
  const controller = new AbortController()
  await expect(readHistoryContexts({ filePath: files[5]!, sourceVersion: versions[5]!, offsets: [0], signal: controller.signal, classify: entry => { controller.abort(); return classify(entry) } })).rejects.toThrow()
  expect((await readHistoryContexts({ filePath: files[5]!, sourceVersion: versions[5]!, offsets: [0], classify })).contexts.get(0)?.suppressed).toBe(false)
})


test('rebuilds scalar context after an in-place rewrite grows beyond the cached snapshot', async () => {
  await writeFile(file, row('notice', { notification: true }) + '\n')
  await readHistoryContexts({ filePath: file, sourceVersion: await version(), offsets: [0], classify })
  await writeFile(file, row('replacement', { reset: true }) + '\n' + row('more-records') + '\n')
  const rebuilt = await readHistoryContexts({ filePath: file, sourceVersion: await version(), offsets: [0], classify })
  expect(rebuilt.contexts.get(0)?.suppressed).toBe(false)
  expect(rebuilt.scannedBytes).toBe(Number((await stat(file)).size))
})
