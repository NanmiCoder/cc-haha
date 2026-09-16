import { describe, expect, test } from 'bun:test'
import { buildSessionContext, createComputerUseEscapeHandler, dispatchComputerUseCall } from './wrapper.js'
import type { ToolUseContext } from '../../Tool.js'

describe('Computer Use session authorization', () => {
  test('enables every supported app without exposing a runtime permission callback', () => {
    const context = buildSessionContext()

    expect(context.getAllowedApps()).toEqual([])
    expect(context.getUserDeniedBundleIds()).toEqual([])
    expect(context.getGrantFlags()).toEqual({
      clipboardRead: true,
      clipboardWrite: true,
      systemKeyCombos: true,
    })
    expect(context.onPermissionRequest).toBeUndefined()
  })
})

describe('Computer Use CLI dispatch boundary', () => {
  const context = () => ({ abortController: new AbortController() }) as ToolUseContext

  test('pins cancellation to this call rather than the latest queued context', async () => {
    const callContext = context()
    const result = await dispatchComputerUseCall(async (_tool, _args, signal) => {
      expect(signal).toBe(callContext.abortController.signal)
      callContext.abortController.abort()
      expect(signal?.aborted).toBe(true)
      return { content: [{ type: 'text', text: 'cancelled' }] }
    }, 'sequence', { app: 'Finder', steps: [] }, callContext)
    expect(result.data).toEqual([{ type: 'text', text: 'cancelled' }])
  })

  test('preserves partial sequence progress for both the model and SDK', async () => {
    const summary = { status: 'completed', completedSteps: 2, totalSteps: 2 }
    const result = await dispatchComputerUseCall(async () => ({
      structuredContent: summary,
      content: [{ type: 'text', text: 'Current app state' }],
    }), 'sequence', {}, context())
    expect(result.data).toContainEqual({ type: 'text', text: JSON.stringify(summary) })
    expect(result.mcpMeta?.structuredContent).toEqual(summary)
  })

  test('a failed sequence remains a tool error with the completed-step evidence', async () => {
    const summary = { status: 'failed', completedSteps: 1, failedStepIndex: 1, resultUnknown: true }
    try {
      await dispatchComputerUseCall(async () => ({
        isError: true,
        structuredContent: summary,
        content: [{ type: 'text', text: 'Inspect state before retrying; do not replay completed steps.' }],
      }), 'sequence', {}, context())
      throw new Error('failed tool was returned as success')
    } catch (error) {
      expect(String(error)).toContain(JSON.stringify(summary))
      expect(String(error)).toContain('do not replay completed steps')
    }
  })
})

test('queued CLI calls keep their AppState accessors isolated', async () => {
  let release!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  const firstContext = {
    abortController: new AbortController(),
    getAppState: () => ({ computerUseMcpState: { selectedDisplayId: 1 } }),
  } as ToolUseContext
  const secondContext = {
    abortController: new AbortController(),
    getAppState: () => ({ computerUseMcpState: { selectedDisplayId: 2 } }),
  } as ToolUseContext
  const session = buildSessionContext()
  const first = dispatchComputerUseCall(async () => {
    await waiting
    return { content: [{ type: 'text', text: String(session.getSelectedDisplayId()) }] }
  }, 'sequence', {}, firstContext)
  const second = dispatchComputerUseCall(async () => ({
    content: [{ type: 'text', text: String(session.getSelectedDisplayId()) }],
  }), 'click', {}, secondContext)
  expect((await second).data).toEqual([{ type: 'text', text: '2' }])
  release()
  expect((await first).data).toEqual([{ type: 'text', text: '1' }])
})


test('a host Escape callback aborts its turn outside any dispatch async context', async () => {
  const turnController = new AbortController()
  const nextController = new AbortController()
  const onEscape = createComputerUseEscapeHandler(turnController)
  await dispatchComputerUseCall(async () => ({ content: [] }), 'click', {}, {
    abortController: nextController,
  } as ToolUseContext)
  // Simulate a host callback delivered after the promise context has gone away.
  onEscape()
  expect(turnController.signal.aborted).toBe(true)
  expect(nextController.signal.aborted).toBe(false)
})

import { withComputerUseToolContext } from './wrapper.js'

test('CU async contexts preserve each originating turn cancellation across concurrent awaits', async () => {
  const first = new AbortController()
  const second = new AbortController()
  const shared = buildSessionContext()
  let resume!: () => void
  let ready!: () => void
  const pending = new Promise<void>(resolve => { resume = resolve })
  const started = new Promise<void>(resolve => { ready = resolve })
  const firstRun = withComputerUseToolContext({ abortController: first } as ToolUseContext, async () => {
    expect(shared.isAborted?.()).toBe(false)
    ready()
    await pending
    expect(shared.isAborted?.()).toBe(true)
  })
  await started
  await withComputerUseToolContext({ abortController: second } as ToolUseContext, async () => {
    first.abort()
    await Promise.resolve()
    expect(shared.isAborted?.()).toBe(false)
  })
  resume()
  await firstRun
})

import { spyOn } from 'bun:test'
import * as hostAdapterModule from './hostAdapter.js'
import * as lockModule from './computerUseLock.js'
import * as gateModule from './gates.js'
import * as debugModule from '../debug.js'
import type { ComputerUseHostAdapter } from '../../vendor/computer-use-mcp/types.js'
import type { CodexComputerEngine, ComputerExecutor } from '../../vendor/computer-use-mcp/executor.js'

test('real CU call wrapper delivers sequence metadata/images and releases fresh locks cancelled during acquisition', async () => {
  // Narrow, restored spies only; a separately imported wrapper keeps its cached
  // binder out of other tests. No helper command, real lock, user config or UI.
  const engineCalls: string[] = []
  let failInput = false
  const engine = {
    async resolveTarget() {
      engineCalls.push('resolve')
      return { pid: 420, bundleId: 'com.test.blender', launchTime: 100, executablePath: '/fixture/Blender' }
    },
    async pressKey() {
      engineCalls.push('pressKey')
      if (failInput) throw new Error('fixture response failure after dispatch')
    },
    async getAppState() {
      engineCalls.push('getAppState')
      return { pid: 420, appName: 'Fixture Blender', bundleId: 'com.test.blender', windowTitle: 'Untitled',
        elementCount: 0, truncated: false, durationMs: 1, axText: 'Fixture state',
        screenshot: { base64: 'Zml4dHVyZS1wbmc=', width: 1, height: 1 } }
    },
  } as unknown as CodexComputerEngine
  const adapter = {
    serverName: 'computer-use',
    logger: { silly() {}, debug() {}, info() {}, warn() {}, error() {} },
    executor: { capabilities: { platform: 'darwin', screenshotFiltering: 'native' }, engine } as ComputerExecutor,
    ensureOsPermissions: async () => ({ granted: true }),
    isDisabled: () => false,
  } as ComputerUseHostAdapter
  const adapterSpy = spyOn(hostAdapterModule, 'getComputerUseHostAdapter').mockReturnValue(adapter)
  const checkSpy = spyOn(lockModule, 'checkComputerUseLock').mockResolvedValue({ kind: 'held_by_self' })
  const acquireSpy = spyOn(lockModule, 'tryAcquireComputerUseLock').mockResolvedValue({ kind: 'acquired', fresh: true })
  const releaseSpy = spyOn(lockModule, 'releaseComputerUseLock').mockResolvedValue(true)
  const coordSpy = spyOn(gateModule, 'getChicagoCoordinateMode').mockReturnValue('pixels')
  const debugSpy = spyOn(debugModule, 'logForDebugging').mockImplementation(() => {})
  try {
    const moduleUrl = new URL('./wrapper.tsx', import.meta.url)
    moduleUrl.search = '?cu-wrapper-delivery-fixture'
    const wrapper = await import(moduleUrl.href) as typeof import('./wrapper.js')
    const makeContext = (abortController = new AbortController()) => ({
      abortController, getAppState: () => ({ computerUseMcpState: undefined }),
      setAppState() {}, sendOSNotification() {},
    }) as unknown as ToolUseContext
    const call = wrapper.getComputerUseMCPToolOverrides('sequence').call
    const args = { app: 'Fixture Blender', steps: [{ tool: 'press_key', key: 'a b c' }] }
    const delivered = await call(args, makeContext())
    const blocks = delivered.data as Array<Record<string, any>>
    expect(engineCalls).toEqual(['resolve', 'pressKey', 'getAppState'])
    expect(JSON.parse(blocks[0]!.text)).toMatchObject({ status: 'completed', completedSteps: 1, resultUnknown: false })
    expect(blocks.find(block => block.type === 'image')).toEqual({
      type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'Zml4dHVyZS1wbmc=' },
    })
    expect(blocks.some(block => block.type === 'text' && block.text.includes('Fixture state'))).toBe(true)

    // The wrapper must deliver the actual error and structured partial outcome,
    // not replace it with a generic successful Computer Use result.
    failInput = true
    const failed = await call(args, makeContext()).then(() => '', error => String(error))
    expect(failed).toContain('fixture response failure after dispatch')
    expect(failed).toContain('"completedSteps":0')
    expect(failed).toContain('"failedStepIndex":0')
    expect(failed).toContain('"resultUnknown":true')
    expect(debugSpy).toHaveBeenCalled()

    // Real buildSessionContext acquire callback, with only file-lock IO mocked.
    let enterAcquire!: () => void
    let finishAcquire!: () => void
    const entered = new Promise<void>(resolve => { enterAcquire = resolve })
    const holdAcquire = new Promise<void>(resolve => { finishAcquire = resolve })
    acquireSpy.mockImplementation(async () => {
      enterAcquire()
      await holdAcquire
      return { kind: 'acquired', fresh: true }
    })
    const abort = new AbortController()
    const acquiring = wrapper.withComputerUseToolContext(makeContext(abort), () => wrapper.buildSessionContext().acquireCuLock!())
    await entered
    abort.abort()
    finishAcquire()
    await expect(acquiring).rejects.toThrow('cancelled during lock acquisition')
    expect(releaseSpy).toHaveBeenCalledTimes(1)

    const callsBefore = acquireSpy.mock.calls.length
    await expect(wrapper.withComputerUseToolContext(makeContext(abort), () => wrapper.buildSessionContext().acquireCuLock!()))
      .rejects.toThrow('cancelled before lock acquisition')
    expect(acquireSpy.mock.calls.length).toBe(callsBefore)

    // A normal reentrant acquisition continues and does not release another
    // operation's existing session lock.
    acquireSpy.mockResolvedValue({ kind: 'acquired', fresh: false })
    await wrapper.withComputerUseToolContext(makeContext(), () => wrapper.buildSessionContext().acquireCuLock!())
    expect(releaseSpy).toHaveBeenCalledTimes(1)
  } finally {
    for (const spy of [adapterSpy, checkSpy, acquireSpy, releaseSpy, coordSpy, debugSpy]) spy.mockRestore()
  }
})
