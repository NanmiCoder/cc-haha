import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clearTraceCaptureStateForTests,
  drainTraceCaptureForTests,
  getTraceStorageDir,
  readTraceCaptureSettings,
  readTraceCaptureSettingsSync,
  setTraceAppendBeforeWriteHookForTests,
  traceCaptureService,
  updateTraceCaptureSettings,
} from './traceCapture.js'

const envKeys = ['CLAUDE_CONFIG_DIR', 'CC_HAHA_TRACE_DIR', 'CC_HAHA_TRACE_API_CALLS', 'CC_HAHA_LOCAL_INDEX'] as const
let savedEnv: Array<string | undefined>
let root: string
let config: string

beforeEach(async () => {
  savedEnv = envKeys.map(key => process.env[key])
  root = await fs.mkdtemp(join(tmpdir(), 'trace-storage-'))
  config = join(root, 'config')
  process.env.CLAUDE_CONFIG_DIR = config
  process.env.CC_HAHA_LOCAL_INDEX = 'on'
  delete process.env.CC_HAHA_TRACE_DIR
  delete process.env.CC_HAHA_TRACE_API_CALLS
  clearTraceCaptureStateForTests()
})

afterEach(async () => {
  await drainTraceCaptureForTests()
  clearTraceCaptureStateForTests()
  for (const [i, key] of envKeys.entries()) {
    if (savedEnv[i] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[i]
  }
  await fs.rm(root, { recursive: true, force: true })
})

function record(id: string, sessionId = 'shared-session') {
  return traceCaptureService.recordCall({
    id, sessionId, source: 'proxy', model: id,
    startedAt: '2026-07-15T00:00:00.000Z',
    completedAt: '2026-07-15T00:00:00.001Z',
    request: { body: { marker: id } },
    response: { status: 200, body: { ok: true } },
  })
}

test('preserves legacy settings and the default JSONL and SQLite locations', async () => {
  const settingsFile = join(config, 'cc-haha', 'settings.json')
  await fs.mkdir(join(config, 'cc-haha'), { recursive: true })
  const legacy = { futureField: 'keep', traceCapture: { enabled: false, unknownField: 7 } }
  await fs.writeFile(settingsFile, JSON.stringify(legacy))
  const storageDir = join(config, 'cc-haha', 'traces')
  expect(getTraceStorageDir()).toBe(storageDir)
  expect(await readTraceCaptureSettings()).toEqual({ enabled: false, storageDir })
  expect(await record('disabled')).toBeNull()
  await updateTraceCaptureSettings({ enabled: true })
  expect(JSON.parse(await fs.readFile(settingsFile, 'utf8'))).toEqual({
    ...legacy, traceCapture: { ...legacy.traceCapture, enabled: true },
  })
  await record('default')
  expect(await fs.readFile(join(storageDir, 'shared-session.jsonl'), 'utf8')).toContain('default')
  expect((await fs.stat(join(config, 'cc-haha', 'db', 'trace-index-v1.sqlite'))).isFile()).toBe(true)
})

test('stores and reads custom traces and their index without moving managed settings', async () => {
  const storageDir = join(root, 'custom traces')
  process.env.CC_HAHA_TRACE_DIR = storageDir
  expect(getTraceStorageDir()).toBe(storageDir)
  expect(readTraceCaptureSettingsSync()).toEqual({ enabled: true, storageDir })
  expect(await readTraceCaptureSettings()).toEqual({ enabled: true, storageDir })
  await record('custom')
  const file = join(storageDir, 'shared-session.jsonl')
  expect(await traceCaptureService.getSessionTraceFile('shared-session')).toEqual({ path: file })
  expect((await traceCaptureService.getSessionTraceOverview('shared-session')).calls.map(call => call.id)).toEqual(['custom'])
  expect((await traceCaptureService.getSessionTraceCall('shared-session', 'custom'))?.model).toBe('custom')
  expect((await fs.stat(join(storageDir, 'cc-haha', 'db', 'trace-storage-index-v1.sqlite'))).isFile()).toBe(true)
  await expect(fs.stat(join(config, 'cc-haha', 'traces'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(fs.stat(join(config, 'cc-haha', 'db'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await updateTraceCaptureSettings({ enabled: false })).toEqual({ enabled: false, storageDir })
  expect(await record('disabled')).toBeNull()
  expect(JSON.parse(await fs.readFile(join(config, 'cc-haha', 'settings.json'), 'utf8'))).toEqual({ traceCapture: { enabled: false } })
  await expect(fs.stat(join(storageDir, 'cc-haha', 'settings.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

test('isolates indexes, reads, lists and deletion across storage roots with the same session id', async () => {
  await record('default')
  const defaultFile = join(getTraceStorageDir(), 'shared-session.jsonl')
  const defaultBytes = await fs.readFile(defaultFile, 'utf8')
  const first = join(root, 'first')
  const second = join(root, 'second')
  for (const storageDir of [first, second]) {
    process.env.CC_HAHA_TRACE_DIR = storageDir
    await record(storageDir === first ? 'first' : 'second')
  }
  for (const storageDir of [first, second, first]) {
    process.env.CC_HAHA_TRACE_DIR = storageDir
    const id = storageDir === first ? 'first' : 'second'
    expect((await traceCaptureService.getSessionTraceOverview('shared-session')).calls.map(call => call.id)).toEqual([id])
    const list = await traceCaptureService.listSessionTraces()
    expect(list.storageDir).toBe(storageDir)
    expect(list.settings.storageDir).toBe(storageDir)
    expect(list.traces[0]?.summary.models).toEqual([{ model: id, calls: 1 }])
    expect((await traceCaptureService.listSessionTraceFiles()).storageDir).toBe(storageDir)
    // Exercise the canonical cache as well as the SQLite read path.
    process.env.CC_HAHA_LOCAL_INDEX = 'off'
    expect((await traceCaptureService.getSessionTrace('shared-session')).calls.map(call => call.id)).toEqual([id])
    process.env.CC_HAHA_LOCAL_INDEX = 'on'
  }
  expect(await traceCaptureService.deleteSessionTrace('shared-session')).toEqual({ sessionId: 'shared-session', deleted: true })
  expect((await traceCaptureService.getSessionTraceOverview('shared-session')).calls).toEqual([])
  process.env.CC_HAHA_TRACE_DIR = second
  expect((await traceCaptureService.getSessionTraceOverview('shared-session')).calls[0]?.id).toBe('second')
  delete process.env.CC_HAHA_TRACE_DIR
  expect(await fs.readFile(defaultFile, 'utf8')).toBe(defaultBytes)
  expect((await traceCaptureService.getSessionTraceOverview('shared-session')).calls[0]?.id).toBe('default')
})

test('keeps an in-flight append and index projection in the captured custom directory', async () => {
  const first = join(root, 'first')
  const second = join(root, 'second')
  process.env.CC_HAHA_TRACE_DIR = first
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  let signalStarted!: () => void
  const started = new Promise<void>(resolve => { signalStarted = resolve })
  setTraceAppendBeforeWriteHookForTests(async () => {
    setTraceAppendBeforeWriteHookForTests(null)
    signalStarted()
    await blocked
  })
  const pending = record('first')
  try {
    await started
    process.env.CC_HAHA_TRACE_DIR = second
  } finally {
    release()
    await pending
  }
  await expect(fs.stat(second)).rejects.toMatchObject({ code: 'ENOENT' })
  process.env.CC_HAHA_TRACE_DIR = first
  expect((await traceCaptureService.listSessionTraces()).traces[0]?.summary.models).toEqual([{ model: 'first', calls: 1 }])
})

test('keeps the default index isolated when the custom trace directory is the config directory', async () => {
  await record('default')
  const defaultFile = join(getTraceStorageDir(), 'shared-session.jsonl')
  const defaultBytes = await fs.readFile(defaultFile, 'utf8')
  process.env.CC_HAHA_TRACE_DIR = config
  await record('custom')
  await drainTraceCaptureForTests()
  clearTraceCaptureStateForTests()
  delete process.env.CC_HAHA_TRACE_DIR
  expect((await traceCaptureService.listSessionTraces()).traces[0]?.summary.models).toEqual([{ model: 'default', calls: 1 }])
  expect(await fs.readFile(defaultFile, 'utf8')).toBe(defaultBytes)
  process.env.CC_HAHA_TRACE_DIR = config
  expect((await traceCaptureService.listSessionTraces()).traces[0]?.summary.models).toEqual([{ model: 'custom', calls: 1 }])
  expect((await traceCaptureService.getSessionTrace('shared-session')).calls.map(call => call.id)).toEqual(['custom'])
})

test('keeps list results and settings on the captured root across an asynchronous environment switch', async () => {
  const first = join(root, 'first')
  const second = join(root, 'second')
  process.env.CC_HAHA_TRACE_DIR = first
  await record('first')
  const readFile = fs.readFile.bind(fs)
  const spy = spyOn(fs, 'readFile').mockImplementation(async (...args) => {
    const result = await readFile(...args)
    if (args[0] === join(config, 'cc-haha', 'settings.json')) process.env.CC_HAHA_TRACE_DIR = second
    return result
  })
  await updateTraceCaptureSettings({ enabled: true })
  process.env.CC_HAHA_TRACE_DIR = first
  try {
    const list = await traceCaptureService.listSessionTraces()
    expect(process.env.CC_HAHA_TRACE_DIR).toBe(second)
    expect(list.storageDir).toBe(first)
    expect(list.settings.storageDir).toBe(first)
    expect(list.traces[0]?.summary.models).toEqual([{ model: 'first', calls: 1 }])
  } finally {
    spy.mockRestore()
  }
})

test('deletion waits for an in-flight append and stays on its captured custom root', async () => {
  const first = join(root, 'first')
  const second = join(root, 'second')
  process.env.CC_HAHA_TRACE_DIR = second
  await record('second')
  process.env.CC_HAHA_TRACE_DIR = first
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  let signalStarted!: () => void
  const started = new Promise<void>(resolve => { signalStarted = resolve })
  setTraceAppendBeforeWriteHookForTests(async () => {
    setTraceAppendBeforeWriteHookForTests(null)
    signalStarted()
    await blocked
  })
  const pending = record('first')
  await started
  let deleted = false
  const deleting = traceCaptureService.deleteSessionTrace('shared-session').then(result => {
    deleted = true
    return result
  })
  try {
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(deleted).toBe(false)
    process.env.CC_HAHA_TRACE_DIR = second
  } finally {
    release()
    await pending
  }
  expect(await deleting).toEqual({ sessionId: 'shared-session', deleted: true })
  await expect(fs.stat(join(first, 'shared-session.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await traceCaptureService.getSessionTraceOverview('shared-session')).calls.map(call => call.id)).toEqual(['second'])
  process.env.CC_HAHA_TRACE_DIR = first
  expect((await traceCaptureService.getSessionTraceOverview('shared-session')).calls).toEqual([])
})

test('a directory shared with other JSONL files neither lists nor deletes them as traces', async () => {
  const shared = join(root, 'shared')
  process.env.CC_HAHA_TRACE_DIR = shared
  await record('mine')
  const history = join(shared, 'history.jsonl')
  await fs.writeFile(history, '{"display":"a user prompt"}\n')

  const listed = (await traceCaptureService.listSessionTraces({ all: true })).traces.map(trace => trace.sessionId)
  expect(listed).toEqual(['shared-session'])
  expect(await traceCaptureService.deleteSessionTrace('history')).toMatchObject({ deleted: false })
  expect(await fs.readFile(history, 'utf8')).toContain('a user prompt')
  expect(await traceCaptureService.deleteSessionTrace('shared-session')).toMatchObject({ deleted: true })
})

test('rejects relative paths without writing to the default directory', async () => {
  process.env.CC_HAHA_TRACE_DIR = 'relative-traces'
  expect(() => getTraceStorageDir()).toThrow('CC_HAHA_TRACE_DIR must be an absolute directory path')
  await expect(record('invalid')).rejects.toMatchObject({ code: 'TRACE_INVALID_STORAGE_DIR' })
  await expect(fs.stat(config)).rejects.toMatchObject({ code: 'ENOENT' })
})

test('leaves an occupied path and old trace data untouched after a failed write and rollback', async () => {
  await record('default')
  const file = join(root, 'occupied')
  await fs.writeFile(file, 'do not overwrite')
  process.env.CC_HAHA_TRACE_DIR = file
  await expect(record('failed')).rejects.toThrow()
  expect(await fs.readFile(file, 'utf8')).toBe('do not overwrite')
  delete process.env.CC_HAHA_TRACE_DIR
  expect((await traceCaptureService.getSessionTraceOverview('shared-session')).calls.map(call => call.id)).toEqual(['default'])
})

test('treats an empty directory override as unset', () => {
  process.env.CC_HAHA_TRACE_DIR = '  '
  expect(getTraceStorageDir()).toBe(join(config, 'cc-haha', 'traces'))
})
