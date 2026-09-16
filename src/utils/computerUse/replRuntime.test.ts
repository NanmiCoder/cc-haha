import { afterEach, describe, expect, test } from 'bun:test'
import { AsyncLocalStorage } from 'node:async_hooks'
import { ComputerUseRepl } from './replRuntime.js'

const runtimes: ComputerUseRepl[] = []
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.reset()))
})

const suite = process.platform === 'darwin' ? describe : describe.skip
test('unsupported platforms fail closed without starting an unsandboxed worker', async () => {
  const runtime = new ComputerUseRepl()
  runtimes.push(runtime)
  const result = await runtime.run({ code: '1', timeoutMs: process.platform === 'darwin' ? 0 : 1000 }, async () => {
    throw new Error('must not dispatch')
  })
  expect(result.isError).toBe(true)
  expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringMatching(process.platform === 'darwin' ? /Invalid/ : /macOS only/) })
})
suite('Computer Use isolated persistent runtime', () => {
  function createRuntime() {
    const runtime = new ComputerUseRepl()
    runtimes.push(runtime)
    return runtime
  }

  test('a known pre-dispatch rejection is neither a completed action nor an unknown result', async () => {
    const runtime = createRuntime()
    const result = await runtime.run({ code: 'await cua.getApp("Fixture")', timeoutMs: 5000 }, async () => ({
      isError: true, nativeCallNotDispatched: true,
      content: [{ type: 'text', text: 'permissions required' }],
    }))
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({
      nativeCallsStarted: 1, nativeCallsCompleted: 0, nativeCallsRejectedBeforeDispatch: 1, nativeResultUnknown: false,
    })
    expect(result.structuredContent?.recovery).toContain('No native actions were dispatched')
  })

  test('keeps App bindings and performs sequential loops without model round trips', async () => {
    const runtime = createRuntime()
    const calls: string[] = []
    const invoke = async (name: string) => {
      calls.push(name)
      return { content: [{ type: 'text' as const, text: 'App=Fixture\n[g1:1] button Test' }] }
    }
    const first = await runtime.run({ code: 'let app = await cua.getApp("Fixture")', timeoutMs: 5000 }, invoke)
    expect(first.isError).not.toBe(true)
    const second = await runtime.run({ code: 'for (let i = 0; i < 3; i++) await app.click([10, 10]); nodeRepl.write("done")', timeoutMs: 5000 }, invoke)
    expect(second.isError).not.toBe(true)
    expect(second.content).toContainEqual({ type: 'text', text: 'done' })
    expect(calls).toEqual(['get_app_state', 'click', 'click', 'click'])
  })

  test('a reused worker invokes each cell in its current caller context across awaits', async () => {
    const contexts = new AsyncLocalStorage<{ turn: string; displayId: number; aborted: boolean }>()
    const observed: Array<{ method: string; turn: string | undefined; displayId: number | undefined; afterAwait: string | undefined }> = []
    const runtime = createRuntime()
    const firstContext = { turn: 'first-turn', displayId: 1, aborted: false }
    const secondContext = { turn: 'second-turn', displayId: 2, aborted: false }
    const invoke = async (method: string) => {
      const context = contexts.getStore()
      await Promise.resolve()
      observed.push({ method, turn: context?.turn, displayId: context?.displayId, afterAwait: contexts.getStore()?.turn })
      if (context?.aborted) {
        return { isError: true, nativeCallNotDispatched: true, content: [{ type: 'text' as const, text: 'The caller turn has ended' }] }
      }
      return { content: [{ type: 'text' as const, text: 'App=Fixture\n[g1:1] button Test' }] }
    }

    const first = await contexts.run(firstContext, () => runtime.run({ code: 'let app = await cua.getApp("Fixture")', timeoutMs: 5000 }, invoke))
    expect(first.isError).not.toBe(true)
    // The warmed worker's stdout listener belongs to this completed turn.
    // Its next native callback must use the new turn's state and cancellation.
    firstContext.aborted = true
    const second = await contexts.run(secondContext, () => runtime.run({ code: 'await app.click([10,10])', timeoutMs: 5000 }, invoke))

    expect(second.isError).not.toBe(true)
    expect(observed).toEqual([
      { method: 'get_app_state', turn: 'first-turn', displayId: 1, afterAwait: 'first-turn' },
      { method: 'click', turn: 'second-turn', displayId: 2, afterAwait: 'second-turn' },
    ])
  })

  test('the sandboxed worker completes paste, timer, and observation without replaying paste', async () => {
    const runtime = createRuntime()
    const calls: string[] = []
    const image = { type: 'image' as const, data: 'AAH+/w==', mimeType: 'image/png' }
    const invoke = async (name: string) => {
      calls.push(name)
      return { content: [{ type: 'text' as const, text: 'fixture state' }, image] }
    }
    const selected = await runtime.run({ code: 'var app = await cua.getApp("Fixture")', timeoutMs: 5000 }, invoke)
    expect(selected.isError).not.toBe(true)
    const result = await runtime.run({ code: `
      await app.paste('query')
      await new Promise(resolve => setTimeout(resolve, 0))
      await app.getAXStateAndScreenshot()
    `, timeoutMs: 5000 }, invoke)
    expect(result.isError).not.toBe(true)
    expect(calls).toEqual(['get_app_state', 'paste', 'get_app_state'])
    expect(result.content).toEqual([{ type: 'text', text: 'fixture state' }, image])
  })

  test('cancellation during a timer wait resets its bindings and prevents the following action', async () => {
    const runtime = createRuntime()
    const abort = new AbortController()
    const calls: string[] = []
    let scheduled!: () => void
    const timerScheduled = new Promise<void>(resolve => { scheduled = resolve })
    const result = runtime.run({ code: `
      var app = await cua.getApp('Fixture')
      var waiting = new Promise(resolve => setTimeout(resolve, 10000))
      await app.getAXState()
      await waiting
      await app.click([2,2])
    `, timeoutMs: 5000, signal: abort.signal }, async name => {
      calls.push(name)
      if (calls.length === 2) scheduled()
      return { content: [{ type: 'text', text: 'fixture state' }] }
    })
    // Surface a worker startup failure directly instead of waiting for a
    // marker that can no longer arrive.
    expect(await Promise.race([timerScheduled.then(() => true), result.then(() => false)])).toBe(true)
    abort.abort()
    const cancelled = await result
    expect(cancelled.isError).toBe(true)
    expect(cancelled.structuredContent).toMatchObject({ bindingsReset: true, nativeResultUnknown: false })
    expect(calls).toEqual(['get_app_state', 'get_app_state'])
    const fresh = await runtime.run({ code: 'nodeRepl.write(typeof waiting)', timeoutMs: 5000 }, async () => {
      throw new Error('No native action expected')
    })
    expect(fresh.content).toEqual([{ type: 'text', text: 'undefined' }])
  })

  test('the parent deadline also terminates an awaited timer and its pending action', async () => {
    const runtime = createRuntime()
    const invoke = async () => ({ content: [] })
    expect((await runtime.run({ code: 'var retained = 1', timeoutMs: 5000 }, invoke)).isError).not.toBe(true)
    const result = await runtime.run({ code: `
      await new Promise(resolve => setTimeout(resolve, 10000))
      await cua.getApp('Must not dispatch')
    `, timeoutMs: 150 }, async () => {
      throw new Error('No native action expected')
    })
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('timed out') }])
    expect(result.structuredContent).toMatchObject({ bindingsReset: true, nativeCallsStarted: 0 })
    const fresh = await runtime.run({ code: 'nodeRepl.write(typeof retained)', timeoutMs: 5000 }, invoke)
    expect(fresh.content).toEqual([{ type: 'text', text: 'undefined' }])
  })

  test('terminates CPU loops, discards bindings, and starts a fresh kernel', async () => {
    const runtime = createRuntime()
    const invoke = async () => ({ content: [] })
    await runtime.run({ code: 'let saved = 42', timeoutMs: 5000 }, invoke)
    const started = Date.now()
    const result = await runtime.run({ code: 'while (true) {}', timeoutMs: 150 }, invoke)
    expect(result.isError).toBe(true)
    expect(Date.now() - started).toBeLessThan(3000)
    const next = await runtime.run({ code: 'nodeRepl.write(typeof saved)', timeoutMs: 5000 }, invoke)
    expect(next.content).toContainEqual({ type: 'text', text: 'undefined' })
  })

  test('cancellation drains an already dispatched action and stops later actions', async () => {
    const runtime = createRuntime()
    const abort = new AbortController()
    let release!: () => void
    const actionPending = new Promise<void>(resolve => { release = resolve })
    let started!: () => void
    const actionStarted = new Promise<void>(resolve => { started = resolve })
    const calls: string[] = []
    const result = runtime.run({
      code: 'let app = await cua.getApp("Fixture"); await app.click([1,1]); await app.click([2,2])',
      timeoutMs: 5000,
      signal: abort.signal,
    }, async name => {
      calls.push(name)
      if (name === 'click') {
        started()
        await actionPending
      }
      return { content: [{ type: 'text', text: 'state' }] }
    })
    await actionStarted
    abort.abort()
    let finished = false
    void result.then(() => { finished = true })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(finished).toBe(false)
    release()
    const cancelled = await result
    expect(cancelled.isError).toBe(true)
    expect(cancelled.structuredContent).toMatchObject({ nativeCallsStarted: 2, nativeCallsCompleted: 2, nativeResultUnknown: false, bindingsReset: true })
    expect(calls).toEqual(['get_app_state', 'click'])
  })

  test('a detached microtask loop cannot report success and is terminated by the parent', async () => {
    const runtime = createRuntime()
    const invoke = async () => ({ content: [] })
    const result = await runtime.run({
      code: 'let spin; spin = () => { Promise.resolve().then(spin) }; Promise.resolve().then(spin)',
      timeoutMs: 150,
    }, invoke)
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('timed out') }])
    const fresh = await runtime.run({ code: 'nodeRepl.write(typeof spin)', timeoutMs: 5000 }, invoke)
    expect(fresh.content).toEqual([{ type: 'text', text: 'undefined' }])
  })

  test('idle health checks retain a responsive kernel and its variables', async () => {
    const runtime = new ComputerUseRepl({ maxRssBytes: 768 * 1024 * 1024, healthCheckMs: 50 })
    runtimes.push(runtime)
    const invoke = async () => ({ content: [] })
    expect((await runtime.run({ code: 'let retained = 7', timeoutMs: 5000 }, invoke)).isError).not.toBe(true)
    await new Promise(resolve => setTimeout(resolve, 2200))
    const result = await runtime.run({ code: 'nodeRepl.write(retained)', timeoutMs: 5000 }, invoke)
    expect(result.isError).not.toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: '7' }])
  })

  test('the parent memory watchdog terminates a child independently of its VM', async () => {
    // A tiny injected budget tests real RSS measurement without allocating
    // hundreds of megabytes on the developer's machine.
    const runtime = new ComputerUseRepl({ maxRssBytes: 1, healthCheckMs: 50 })
    runtimes.push(runtime)
    const result = await runtime.run({ code: 'await new Promise(() => {})', timeoutMs: 5000 }, async () => ({ content: [] }))
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('memory budget') }])
  })

  test('an ignored failing App action cannot be reported as successful execution', async () => {
    const runtime = createRuntime()
    const result = await runtime.run({
      code: 'let app = await cua.getApp("Fixture"); app.click([1,1]); await app.getAXState()',
      timeoutMs: 5000,
    }, async name => name === 'click'
      ? { isError: true, content: [{ type: 'text', text: 'fixture click failed' }] }
      : { content: [{ type: 'text', text: 'fixture state' }] })
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({ nativeResultUnknown: true })
  })

  test('explicitly handled App failures can observe the outcome and continue', async () => {
    const runtime = createRuntime()
    const result = await runtime.run({
      code: 'let app = await cua.getApp("Fixture"); try { await app.click([1,1]) } catch(error) { nodeRepl.write(error.message) }; await app.getAXState()',
      timeoutMs: 5000,
    }, async name => name === 'click'
      ? { isError: true, content: [{ type: 'text', text: 'fixture click failed' }] }
      : { content: [{ type: 'text', text: 'fixture state' }] })
    expect(result.isError).not.toBe(true)
    expect(result.content).toContainEqual({ type: 'text', text: 'fixture click failed' })
    expect(result.content.at(-1)).toEqual({ type: 'text', text: 'fixture state' })
  })

  test('invalid bridge operations and output floods stop the kernel without native calls', async () => {
    for (const code of [
      'await __cuInvoke("js", {code:"1"})',
      '__cuEmit({type:"image",data:"AA==",mimeType:"text/html"})',
      'for(let i=0;i<129;i++) nodeRepl.write(i)',
    ]) {
      const runtime = createRuntime()
      let calls = 0
      const result = await runtime.run({ code, timeoutMs: 5000 }, async () => { ++calls; return { content: [] } })
      expect(result.isError).toBe(true)
      expect(result.structuredContent).toMatchObject({ bindingsReset: true, nativeCallsStarted: 0 })
      expect(calls).toBe(0)
    }
  })

  test('the native call budget stops an oversized loop without replaying actions', async () => {
    const runtime = createRuntime()
    let clicks = 0
    const result = await runtime.run({
      code: 'let app = await cua.getApp("Fixture"); for(let i=0;i<300;i++) await app.click([1,1])',
      timeoutMs: 5000,
    }, async name => {
      if (name === 'click') ++clicks
      return { content: [{ type: 'text', text: 'fixture state' }] }
    })
    expect(result.isError).toBe(true)
    expect(clicks).toBe(255)
    expect(result.structuredContent).toMatchObject({ nativeCallsStarted: 256, nativeCallsCompleted: 256, bindingsReset: true })
  })
})
