import { afterEach, describe, expect, test } from 'bun:test'
import { bindSessionContext } from './mcpServer.js'
import type { ComputerUseHostAdapter, ComputerUseSessionContext } from './types.js'
import type { AppTarget, CodexComputerEngine, ComputerExecutor } from './executor.js'
import { ComputerUseRepl } from '../../utils/computerUse/replRuntime.js'
import { NativeCommandError } from './nativeError.js'

const runtimes: ComputerUseRepl[] = []
afterEach(async () => { await Promise.all(runtimes.splice(0).map(runtime => runtime.reset())) })
const suite = process.platform === 'darwin' ? describe : describe.skip

function fixture() {
  const calls: Array<{ name: string, target?: AppTarget }> = []
  const engine = {
    async resolveTarget(target: AppTarget) {
      calls.push({ name: 'resolve', target })
      return {
        pid: 123, bundleId: 'dev.test.Fixture', displayName: 'Fixture', path: '/Applications/Fixture.app',
        executablePath: '/Applications/Fixture.app/Contents/MacOS/Fixture', launchTime: 100,
        processIdentity: { pid: 123, bundleId: 'dev.test.Fixture', executablePath: '/Applications/Fixture.app/Contents/MacOS/Fixture', launchTime: 100 },
      }
    },
    async getAppState(target: AppTarget) {
      calls.push({ name: 'state', target })
      return {
        pid: 123, elementCount: 1, truncated: false, durationMs: 1,
        axText: 'App=Fixture\n\tg1:1 button Test',
        screenshot: { base64: 'AQID', width: 10, height: 10 },
      }
    },
    async click({ target }: { target: AppTarget }) { calls.push({ name: 'click', target }) },
  } as unknown as CodexComputerEngine
  let created = 0
  const adapter: ComputerUseHostAdapter = {
    serverName: 'test', logger: { silly() {}, debug() {}, info() {}, warn() {}, error() {} },
    executor: { capabilities: { platform: 'darwin', screenshotFiltering: 'native', hostBundleId: 'dev.test.host' }, engine } as ComputerExecutor,
    ensureOsPermissions: async () => ({ granted: true }),
    isDisabled: () => false, getAutoUnhideEnabled: () => true,
    getSubGates: () => ({ pixelValidation: false, clipboardPasteMultiline: false, mouseAnimation: false, hideBeforeAction: false, autoTargetDisplay: false, clipboardGuard: false }),
    cropRawPatch: () => null,
    createReplRuntime: () => {
      ++created
      const runtime = new ComputerUseRepl()
      runtimes.push(runtime)
      return runtime
    },
  }
  const context: ComputerUseSessionContext = {
    getAllowedApps: () => [],
    getGrantFlags: () => ({ clipboardRead: false, clipboardWrite: false, systemKeyCombos: false }),
    getUserDeniedBundleIds: () => [], getSelectedDisplayId: () => undefined,
  }
  return { calls, engine, adapter, context, created: () => created }
}

test('invalid JavaScript requests cannot create a kernel on any host platform', async () => {
  const f = fixture()
  const dispatch = bindSessionContext(f.adapter, 'pixels', f.context)
  expect((await dispatch('js', { code: null })).isError).toBe(true)
  expect(f.created()).toBe(0)
  expect(f.calls).toEqual([])
})

test('the session rejects invalid resets, disabled execution and hosts without an isolated runtime', async () => {
  const f = fixture()
  const dispatch = bindSessionContext(f.adapter, 'pixels', f.context)
  for (const args of [null, [], { unexpected: true }]) expect((await dispatch('js_reset', args)).isError).toBe(true)
  f.adapter.isDisabled = () => true
  expect((await dispatch('js', { code: '1' })).isError).toBe(true)
  f.adapter.isDisabled = () => false
  delete f.adapter.createReplRuntime
  expect((await dispatch('js', { code: '1' })).content).toEqual([{ type: 'text', text: expect.stringContaining('does not provide an isolated') }])
  expect(f.created()).toBe(0)
  expect(f.calls).toEqual([])
})

suite('persistent JavaScript through guarded session dispatch', () => {
  test('both lock conflict paths reject before native dispatch without an unknown action result', async () => {
    for (const conflictAfterAcquire of [false, true]) {
      const f = fixture()
      let checks = 0
      f.context.checkCuLock = async () => (++checks === 1 && conflictAfterAcquire)
        ? { holder: undefined, isSelf: false } : { holder: 'another session', isSelf: false }
      const dispatch = bindSessionContext(f.adapter, 'pixels', f.context)
      const result = await dispatch('js', { code: 'await cua.getApp("Fixture")' })
      expect(result.isError).toBe(true)
      expect(result.structuredContent).toMatchObject({
        nativeCallsCompleted: 0, nativeCallsRejectedBeforeDispatch: 1, nativeResultUnknown: false,
      })
      expect(f.calls).toEqual([])
    }
  })

  test('a TCC refusal preserves its typed cause and reports that no action was dispatched', async () => {
    const f = fixture()
    f.adapter.ensureOsPermissions = async () => ({ granted: false })
    const dispatch = bindSessionContext(f.adapter, 'pixels', f.context)
    const result = await dispatch('js', { code: 'await cua.getApp("Fixture")' })
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({
      nativeCallsCompleted: 0, nativeCallsRejectedBeforeDispatch: 1, nativeResultUnknown: false,
    })
    const caught = await dispatch('js', { code: 'try { await cua.getApp("Fixture") } catch (e) { nodeRepl.write([e.name, e.code, e.errorName]) }' })
    expect(caught.content).toEqual([{ type: 'text', text: '["SkyComputerUseError",-10009,"permissionsNotGranted"]' }])
    expect(f.calls).toEqual([])
  })

  test('preserves typed native errors across the worker and allows explicit recovery without replay', async () => {
    const f = fixture()
    let clicks = 0
    f.engine.click = async () => { ++clicks; throw new NativeCommandError('receiver disappeared', 'process_gone') }
    const dispatch = bindSessionContext(f.adapter, 'pixels', f.context)
    expect((await dispatch('js', { code: 'let app = await cua.getApp("Fixture", { emit: false })' })).isError).not.toBe(true)
    const result = await dispatch('js', { code: 'try { await app.click([1,2]) } catch (e) { nodeRepl.write({ name: e.name, code: e.code, errorName: e.errorName, message: e.message, nativeCode: e.nativeCode, request: e.request, requestType: e.requestType }) }' })
    expect(result.isError).not.toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify({
      name: 'SkyComputerUseError', code: -10007, errorName: 'runningApplicationNotFound',
      message: 'receiver disappeared', nativeCode: 'process_gone', request: null, requestType: 'jsonRPC',
    }) }])
    expect(clicks).toBe(1)
    expect((await dispatch('js', { code: 'await app.getAXState({ emit: false })' })).isError).not.toBe(true)
    expect(clicks).toBe(1)
  })

  test('native inventory survives the isolated worker RPC without adding observations', async () => {
    const f = fixture()
    const apps = [
      { id: 'dev.test.Editor', displayName: 'Editor', isRunning: false, lastUsedDate: '2026-09-09T01:00:00Z', useCount: 4 },
      { id: 'dev.test.Unknown' },
    ]
    let enumerations = 0
    f.engine.listAppsInfo = async () => { ++enumerations; return apps }
    f.engine.listApps = async () => { throw new Error('must not enumerate twice') }
    const dispatch = bindSessionContext(f.adapter, 'pixels', f.context)
    const result = await dispatch('js', { code: 'nodeRepl.write(await cua.listApps({ emit: false }))' })
    expect(result.isError).not.toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(apps) }])
    expect(enumerations).toBe(1)
    expect(f.calls).toEqual([])
  })

  test('binds the approved app path, rechecks every action and emits only requested observations', async () => {
    const f = fixture()
    const dispatch = bindSessionContext(f.adapter, 'pixels', f.context)
    const first = await dispatch('js', { code: 'let app = await cua.getApp("Fixture")' })
    expect(first.isError).not.toBe(true)
    expect(first.content.filter(block => block.type === 'image')).toHaveLength(0)
    const next = await dispatch('js', {
      code: 'for (let i = 0; i < 3; i++) await app.click([1,2]); await app.getAXStateAndScreenshot()',
    })
    expect(next.isError).not.toBe(true)
    expect(f.created()).toBe(1)
    expect(f.calls.filter(call => call.name === 'resolve').map(call => call.target)).toEqual([
      { app: 'Fixture' }, ...Array(4).fill({ app: '/Applications/Fixture.app' }),
    ])
    expect(f.calls.filter(call => call.name === 'click')).toHaveLength(3)
    expect(f.calls.filter(call => call.name === 'state')).toHaveLength(2)
    expect(next.content.filter(block => block.type === 'image')).toEqual([{ type: 'image', data: 'AQID', mimeType: 'image/png' }])
  })

  test('validates the cell before creating a kernel and keeps pure JS out of TCC and lock gates', async () => {
    const f = fixture()
    f.adapter.ensureOsPermissions = async () => { throw new Error('unexpected TCC') }
    f.context.checkCuLock = async () => { throw new Error('unexpected lock') }
    const dispatch = bindSessionContext(f.adapter, 'pixels', f.context)
    for (const args of [{ code: '1', timeout_ms: 0 }, { code: null }, { code: '1', injected: true }]) {
      expect((await dispatch('js', args)).isError).toBe(true)
    }
    expect(f.created()).toBe(0)
    const pure = await dispatch('js', { code: 'let counter = 1; nodeRepl.write(++counter)' })
    expect(pure.isError).not.toBe(true)
    expect(pure.content).toEqual([{ type: 'text', text: '2' }])
    expect(f.calls).toEqual([])
  })

  test('a JavaScript cell owns the outer queue while its internal guarded actions run', async () => {
    const f = fixture()
    let entered!: () => void
    const enteredPromise = new Promise<void>(resolve => { entered = resolve })
    let release!: () => void
    const barrier = new Promise<void>(resolve => { release = resolve })
    const order: number[] = []
    f.engine.click = async options => {
      order.push(options.x!)
      if (options.x === 1) { entered(); await barrier }
    }
    const dispatch = bindSessionContext(f.adapter, 'pixels', f.context)
    const cell = dispatch('js', { code: 'let app = await cua.getApp("Fixture"); await app.click([1,1]); await app.click([2,2])' })
    await enteredPromise
    const ordinary = dispatch('click', { app: 'Fixture', x: 3, y: 3 })
    expect(order).toEqual([1])
    release()
    expect((await cell).isError).not.toBe(true)
    expect((await ordinary).isError).not.toBe(true)
    expect(order).toEqual([1, 2, 3])
  })

  test('reset interrupts the active cell and invalidates queued cells without replaying input', async () => {
    const f = fixture()
    let entered!: () => void
    const enteredPromise = new Promise<void>(resolve => { entered = resolve })
    let release!: () => void
    const barrier = new Promise<void>(resolve => { release = resolve })
    let clicked = 0
    f.engine.click = async () => { ++clicked; entered(); await barrier }
    const dispatch = bindSessionContext(f.adapter, 'pixels', f.context)
    const running = dispatch('js', { code: 'let app = await cua.getApp("Fixture"); await app.click([1,1]); await app.click([2,2])' })
    await enteredPromise
    const queued = dispatch('js', { code: 'await app.click([3,3])' })
    const reset = dispatch('js_reset', {})
    release()
    expect((await running).isError).toBe(true)
    expect((await queued).isError).toBe(true)
    expect((await reset).isError).not.toBe(true)
    expect(clicked).toBe(1)
    const next = await dispatch('js', { code: 'nodeRepl.write(typeof app)' })
    expect(next.content).toEqual([{ type: 'text', text: 'undefined' }])
  })
})
