import { expect, spyOn, test } from 'bun:test'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clearTraceCaptureStateForTests,
  traceCaptureService,
  TRACE_RECORD_BYTES_LIMIT,
  TRACE_WINDOW_RECORD_LIMIT,
  TRACE_WINDOW_BYTES_LIMIT,
  captureResponseTraceSnapshot,
  TRACE_STREAM_CAPTURE_BYTES,
} from './traceCapture.js'

async function fixture(run: (filePath: string) => Promise<void>) {
  const previousConfig = process.env.CLAUDE_CONFIG_DIR
  const previousMode = process.env.CC_HAHA_LOCAL_INDEX
  const scope = await fs.mkdtemp(join(tmpdir(), 'trace-hard-bounds-'))
  process.env.CLAUDE_CONFIG_DIR = scope
  process.env.CC_HAHA_LOCAL_INDEX = 'on'
  clearTraceCaptureStateForTests()
  try {
    const dir = join(scope, 'cc-haha', 'traces')
    await fs.mkdir(dir, { recursive: true })
    await run(join(dir, 'fixture.jsonl'))
  } finally {
    clearTraceCaptureStateForTests()
    if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousConfig
    if (previousMode === undefined) delete process.env.CC_HAHA_LOCAL_INDEX
    else process.env.CC_HAHA_LOCAL_INDEX = previousMode
    await fs.rm(scope, { recursive: true, force: true })
  }
}

function callLine(id: string, preview = '') {
  return JSON.stringify({ type: 'call', record: {
    id, sessionId: 'fixture', source: 'proxy', status: 'ok', startedAt: '2026-01-01T00:00:00Z',
    request: { method: 'POST', url: 'https://example.test', headers: {}, body: {
      bytes: preview.length, contentType: 'text', preview, sha256: '', truncated: false,
    } },
  } }) + '\n'
}

test('skips oversized JSONL records before parse and keeps raw bytes available', () => fixture(async filePath => {
  await fs.writeFile(filePath, callLine('huge', 'x'.repeat(TRACE_RECORD_BYTES_LIMIT * 3)) + callLine('small'))
  const bytesBefore = (await fs.stat(filePath)).size
  const parse = JSON.parse.bind(JSON)
  let largestParsedString = 0
  const parseSpy = spyOn(JSON, 'parse').mockImplementation((value, reviver) => {
    largestParsedString = Math.max(largestParsedString, typeof value === 'string' ? Buffer.byteLength(value) : 0)
    return parse(value, reviver)
  })
  try {
    const overview = await traceCaptureService.getSessionTraceOverview('fixture')
    expect(overview.calls.map(call => call.id)).toEqual(['small'])
    expect(overview.window).toMatchObject({ state: 'limited', oversizedRecords: 1, recordBytesLimit: TRACE_RECORD_BYTES_LIMIT })
    expect(largestParsedString).toBeLessThanOrEqual(TRACE_RECORD_BYTES_LIMIT)
    await expect(traceCaptureService.getSessionTraceCall('fixture', 'huge')).rejects.toMatchObject({ code: 'TRACE_RECORD_TOO_LARGE' })
    expect((await fs.stat(filePath)).size).toBe(bytesBefore)
    expect(await traceCaptureService.getSessionTraceFile('fixture')).toEqual({ path: filePath })
  } finally { parseSpy.mockRestore() }
}))

test('pages stable bounded rows and continues beyond the first index window', () => fixture(async filePath => {
  const handle = await fs.open(filePath, 'w')
  for (let i = 0; i < TRACE_WINDOW_RECORD_LIMIT + 20; i++) await handle.write(callLine(`call-${i}`))
  await handle.close()
  const first = await traceCaptureService.getSessionTraceOverview('fixture', { limit: 7 })
  expect(first.calls).toHaveLength(7)
  expect(first.window).toMatchObject({ totalCalls: TRACE_WINDOW_RECORD_LIMIT, hasMore: true, state: 'limited', startByte: 0 })
  expect(first.window?.nextScanCursor).toBeString()
  const nextPage = await traceCaptureService.getSessionTraceOverview('fixture', { offset: 7, limit: 7, revisionToken: first.window!.revisionToken })
  expect(nextPage.calls[0]?.id).toBe('call-7')
  const nextWindow = await traceCaptureService.getSessionTraceOverview('fixture', { scanCursor: first.window!.nextScanCursor })
  expect(nextWindow.calls).toHaveLength(20)
  expect(nextWindow.calls[0]?.id).toBe(`call-${TRACE_WINDOW_RECORD_LIMIT}`)
  expect(nextWindow.window).toMatchObject({ totalCalls: 20, hasMore: false, state: 'ready' })
  expect(nextWindow.window!.startByte).toBeGreaterThan(0)
  await traceCaptureService.getSessionTraceRevision('fixture')
  expect((await traceCaptureService.getSessionTraceCall('fixture', `call-${TRACE_WINDOW_RECORD_LIMIT}`))?.id).toBe(`call-${TRACE_WINDOW_RECORD_LIMIT}`)
  await fs.appendFile(filePath, callLine('new'))
  await expect(traceCaptureService.getSessionTraceOverview('fixture', { scanCursor: first.window!.nextScanCursor })).rejects.toMatchObject({ code: 'TRACE_PAGE_STALE' })
  await expect(traceCaptureService.getSessionTraceOverview('fixture', { revisionToken: first.window!.revisionToken, offset: 7 })).rejects.toMatchObject({ code: 'TRACE_PAGE_STALE' })
}))

test('bounds a window by bytes as well as record count and permits continuation', () => fixture(async filePath => {
  const handle = await fs.open(filePath, 'w')
  const line = Buffer.alloc(1024 * 1024, 0x20)
  line[line.length - 1] = 0x0a
  for (let i = 0; i < 66; i++) await handle.write(line)
  await handle.write(callLine('after-byte-window'))
  await handle.close()
  const first = await traceCaptureService.getSessionTraceOverview('fixture')
  expect(first.window?.scannedBytes).toBe(TRACE_WINDOW_BYTES_LIMIT)
  expect(first.window?.nextScanCursor).toBeString()
  const next = await traceCaptureService.getSessionTraceOverview('fixture', { scanCursor: first.window!.nextScanCursor })
  expect(next.calls[0]?.id).toBe('after-byte-window')
}))

test('aborting the last overview consumer stops physical reads and closes its handle', () => fixture(async filePath => {
  await fs.writeFile(filePath, callLine('huge', 'x'.repeat(8 * 1024 * 1024)))
  const controller = new AbortController()
  const originalOpen = fs.open.bind(fs)
  let reads = 0
  let closed = false
  const openSpy = spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await originalOpen(...args)
    if (String(args[0]) !== filePath) return handle
    return new Proxy(handle, {
      get(target, property) {
        if (property === 'read') return async (buffer: Uint8Array, offset: number, length: number, position: number) => {
          const result = await target.read(buffer, offset, length, position)
          reads += 1
          if (reads === 2) controller.abort()
          return result
        }
        if (property === 'close') return async () => { closed = true; await target.close() }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  })
  try {
    await expect(traceCaptureService.getSessionTraceOverview('fixture', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(reads).toBe(2)
    expect(closed).toBe(true)
  } finally { openSpy.mockRestore() }
}))

test('shares cold work and keeps reading while another consumer still needs it', () => fixture(async filePath => {
  await fs.writeFile(filePath, callLine('huge', 'x'.repeat(6 * 1024 * 1024)) + callLine('small'))
  const fileBytes = (await fs.stat(filePath)).size
  const controller = new AbortController()
  const originalOpen = fs.open.bind(fs)
  let reads = 0
  const openSpy = spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await originalOpen(...args)
    if (String(args[0]) !== filePath) return handle
    return new Proxy(handle, {
      get(target, property) {
        if (property === 'read') return async (buffer: Uint8Array, offset: number, length: number, position: number) => {
          const result = await target.read(buffer, offset, length, position)
          reads += 1
          if (reads === 2) controller.abort()
          return result
        }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  })
  try {
    const abandoned = traceCaptureService.getSessionTraceOverview('fixture', { signal: controller.signal })
    const retained = traceCaptureService.getSessionTraceOverview('fixture')
    await expect(abandoned).rejects.toMatchObject({ name: 'AbortError' })
    expect((await retained).calls[0]?.id).toBe('small')
    expect(reads).toBe(Math.ceil(fileBytes / (256 * 1024)))
  } finally { openSpy.mockRestore() }
}))

test('bounds queued cold jobs and cancels queued work before opening source files', () => fixture(async filePath => {
  for (let i = 0; i < 9; i++) await fs.writeFile(filePath.replace('fixture.jsonl', `queued-${i}.jsonl`), callLine(`call-${i}`))
  const originalOpen = fs.open.bind(fs)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  let reads = 0
  const openSpy = spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await originalOpen(...args)
    if (!String(args[0]).includes('/queued-')) return handle
    return new Proxy(handle, {
      get(target, property) {
        if (property === 'read') return async (buffer: Uint8Array, offset: number, length: number, position: number) => {
          reads += 1
          entered()
          await gate
          return target.read(buffer, offset, length, position)
        }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  })
  const controllers = Array.from({ length: 9 }, () => new AbortController())
  try {
    const requests = controllers.map((controller, index) => traceCaptureService.getSessionTraceOverview(`queued-${index}`, { signal: controller.signal })
      .then(value => ({ value, error: null }), error => ({ value: null, error })))
    await started
    expect((await Promise.race(requests))?.error?.code).toBe('TRACE_INDEX_BUSY')
    controllers.forEach(controller => controller.abort())
    release()
    await Promise.all(requests)
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(reads).toBe(1)
  } finally {
    release()
    openSpy.mockRestore()
  }
}))


test('live event metadata is bounded without invoking accessors', () => fixture(async filePath => {
  let getterCalls = 0
  await traceCaptureService.recordEvent({ sessionId: 'fixture', phase: 'fixture', metadata: {
    get expensive() { getterCalls += 1; return 'x'.repeat(8 * 1024 * 1024) },
  } })
  const raw = await fs.readFile(filePath, 'utf8')
  expect(getterCalls).toBe(0)
  expect(Buffer.byteLength(raw)).toBeLessThan(TRACE_RECORD_BYTES_LIMIT)
  expect(JSON.parse(raw).event.metadata).toMatchObject({ traceCaptureOmitted: { reason: 'accessor' } })
}))

test('an oversized response chunk is sliced before decoding and stops trace capture', async () => {
  let cancelled = false
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(8 * 1024 * 1024).fill(0x78)) },
    cancel() { cancelled = true },
  }))
  const originalDecode = TextDecoder.prototype.decode
  let largestDecoded = 0
  const decodeSpy = spyOn(TextDecoder.prototype, 'decode').mockImplementation(function (input, options) {
    largestDecoded = Math.max(largestDecoded, input?.byteLength ?? 0)
    return originalDecode.call(this, input, options)
  })
  try {
    const result = await captureResponseTraceSnapshot(response)
    expect(largestDecoded).toBeLessThanOrEqual(TRACE_STREAM_CAPTURE_BYTES)
    expect(result.snapshot.truncated).toBe(true)
    expect(result.aborted).toBe(false)
    expect(cancelled).toBe(true)
  } finally { decodeSpy.mockRestore() }
})


test('the legacy full snapshot helper rejects giant files before reading and directs callers to pages', () => fixture(async filePath => {
  await fs.writeFile(filePath, '')
  await fs.truncate(filePath, 16 * 1024 * 1024)
  await expect(traceCaptureService.getSessionTrace('fixture')).rejects.toMatchObject({ code: 'TRACE_RECORD_TOO_LARGE' })
  expect((await fs.stat(filePath)).size).toBe(16 * 1024 * 1024)
}))

test('a single huge line yields bounded byte windows and resumes skipping until the next record', () => fixture(async filePath => {
  const handle = await fs.open(filePath, 'w')
  await handle.write('{"padding":"')
  const block = Buffer.alloc(1024 * 1024, 0x78)
  for (let i = 0; i < 128; i++) await handle.write(block)
  await handle.write('"}\n' + callLine('after-huge-line'))
  await handle.close()
  let page = await traceCaptureService.getSessionTraceOverview('fixture')
  expect(page.window?.scannedBytes).toBeLessThanOrEqual(TRACE_WINDOW_BYTES_LIMIT + 256 * 1024)
  expect(page.window?.oversizedRecords).toBe(1)
  expect(page.window?.nextScanCursor).toBeString()
  let windows = 1
  while (page.window?.nextScanCursor) {
    page = await traceCaptureService.getSessionTraceOverview('fixture', { scanCursor: page.window.nextScanCursor })
    expect(page.window?.scannedBytes).toBeLessThanOrEqual(TRACE_WINDOW_BYTES_LIMIT + 256 * 1024)
    windows += 1
    expect(windows).toBeLessThanOrEqual(3)
  }
  expect(windows).toBe(3)
  expect(page.calls.map(call => call.id)).toEqual(['after-huge-line'])
}))

test('appends cannot grow a full metadata window beyond its row budget', () => fixture(async filePath => {
  await fs.writeFile(filePath, Array.from({ length: TRACE_WINDOW_RECORD_LIMIT }, (_, i) => callLine(`call-${i}`)).join(''))
  const first = await traceCaptureService.getSessionTraceOverview('fixture')
  expect(first.window?.totalCalls).toBe(TRACE_WINDOW_RECORD_LIMIT)
  expect(first.window?.nextScanCursor).toBeUndefined()
  await fs.appendFile(filePath, callLine('new-1') + callLine('new-2'))
  const full = await traceCaptureService.getSessionTraceOverview('fixture')
  expect(full.window?.totalCalls).toBe(TRACE_WINDOW_RECORD_LIMIT)
  expect(full.window?.nextScanCursor).toBeString()
  const next = await traceCaptureService.getSessionTraceOverview('fixture', { scanCursor: full.window?.nextScanCursor })
  expect(next.calls.map(call => call.id)).toEqual(['new-1', 'new-2'])
}))
