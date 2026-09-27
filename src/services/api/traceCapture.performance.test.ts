import { expect, spyOn, test } from 'bun:test'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearTraceCaptureStateForTests, traceCaptureService } from './traceCapture.js'

for (const mode of ['on', 'off', 'shadow']) {
  test(`trace overview streams locator shells with index ${mode}`, async () => {
    const previousConfig = process.env.CLAUDE_CONFIG_DIR
    const previousMode = process.env.CC_HAHA_LOCAL_INDEX
    const scope = await fs.mkdtemp(join(tmpdir(), 'trace-bounded-'))
    process.env.CLAUDE_CONFIG_DIR = scope
    process.env.CC_HAHA_LOCAL_INDEX = mode
    clearTraceCaptureStateForTests()
    const dir = join(scope, 'cc-haha', 'traces')
    const filePath = join(dir, 'fixture.jsonl')
    const line = (id: string) => JSON.stringify({ type: 'call', record: {
      id, sessionId: 'fixture', source: 'proxy', status: 'error',
      startedAt: '2026-06-09T08:00:00.000Z',
      request: { method: 'POST', url: 'https://example.test', headers: {},
        body: { bytes: 900_000, contentType: 'text', preview: '中文'.repeat(150_000), sha256: '', truncated: false } },
    } }) + '\n'
    const originalOpen = fs.open.bind(fs)
    let fullReads = 0
    let largestRead = 0
    let removeBeforeNextRead = false
    const openSpy = spyOn(fs, 'open').mockImplementation(async (...args) => {
      if (removeBeforeNextRead && String(args[0]) === filePath) {
        removeBeforeNextRead = false
        await fs.unlink(filePath)
      }
      const handle = await originalOpen(...args)
      if (String(args[0]) !== filePath) return handle
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'readFile') return async () => { fullReads++; return target.readFile() }
          if (property === 'read') return async (buffer: Uint8Array, offset: number, length: number, position: number) => {
            largestRead = Math.max(largestRead, length)
            return target.read(buffer, offset, length, position)
          }
          const value = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    })
    try {
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(filePath, line('first'))
      const first = await traceCaptureService.getSessionTraceOverview('fixture')
      expect(first.summary.failedCalls).toBe(1)
      expect(first.calls[0].request.body.preview).toBe('')
      await fs.appendFile(filePath, line('second') + line('third'))
      const appended = await traceCaptureService.getSessionTraceOverview('fixture')
      expect(appended.calls).toHaveLength(3)
      expect(appended.summary.failedCalls).toBe(3)
      expect(fullReads).toBe(0)
      expect(largestRead).toBeLessThanOrEqual(256 * 1024)
      const list = await traceCaptureService.listSessionTraces()
      expect(list.traces[0]?.summary.apiCalls).toBe(3)
      expect(fullReads).toBe(0)
      expect(await traceCaptureService.getSessionTraceCall('fixture', 'missing')).toBeNull()
      expect(fullReads).toBe(0)
      expect(largestRead).toBeLessThanOrEqual(256 * 1024)
      const detail = await traceCaptureService.getSessionTraceCall('fixture', 'second')
      expect(detail?.request.body.preview).toBe('中文'.repeat(150_000))
      expect(fullReads).toBe(0)
      if (mode === 'off') {
        // Deletion between directory discovery and the stream open must not
        // turn a trace-list refresh into a failed request.
        removeBeforeNextRead = true
        const removed = await traceCaptureService.listSessionTraces()
        expect(removed.traces[0]?.summary.apiCalls).toBe(0)
      }
    } finally {
      openSpy.mockRestore()
      clearTraceCaptureStateForTests()
      if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previousConfig
      if (previousMode === undefined) delete process.env.CC_HAHA_LOCAL_INDEX
      else process.env.CC_HAHA_LOCAL_INDEX = previousMode
      await fs.rm(scope, { recursive: true, force: true })
    }
  })
}
