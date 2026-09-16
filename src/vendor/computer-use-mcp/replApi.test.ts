import { describe, expect, test } from 'bun:test'
import { createContext, runInContext } from 'node:vm'
import { COMPUTER_USE_BATCHING_GUIDANCE } from './instructions.js'
import {
  createReplApi,
  REPL_BOOTSTRAP_SOURCE,
  type ReplApiBridge,
  type ReplToolResult,
} from './replApi.js'

const full = '<app_state>\nWindow: "Fixture"\ng7:0 window\n\tg7:1 button Save\n\tg7:4 text field Name\n</app_state>'
const diffHeader = 'The following is a diff from the previous accessibility tree for Window: "Fixture" with ~ and + representing changed and added elements, respectively. Removed elements are summarized by ID range.'
// A complete 1×1 RGB JPEG encoded at quality 80; no native capture or user data.
const jpeg = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCWAFLQ/9k='

function jpegState(): ReplToolResult {
  return { ...state(), content: [{ type: 'text', text: full }, { type: 'image', data: jpeg, mimeType: 'image/jpeg' }] }
}

function state(text = full, image = true): ReplToolResult {
  return {
    app: '/Applications/Fixture.app',
    content: [
      { type: 'text', text },
      ...(image ? [{ type: 'image' as const, data: 'AAH+/w==', mimeType: 'image/png' }] : []),
    ],
  }
}

function fixture() {
  const calls: Array<{ method: string; args: Record<string, unknown> }> = []
  const emitted: Array<{ type: string; value: unknown }> = []
  const results: ReplToolResult[] = []
  const bridge: ReplApiBridge = {
    async invoke(method, args) {
      calls.push({ method, args })
      return results.shift() ?? (method === 'get_app_state' ? state() : { content: [] })
    },
    emit(type: string, value: unknown) {
      emitted.push({ type, value })
    },
  }
  return { cua: createReplApi(bridge), calls, emitted, results }
}

describe('native Computer Use JavaScript facade', () => {
  test('binding observes once, emits only AX text, and retains the approved selector', async () => {
    const f = fixture()
    const app = await f.cua.getApp('Fixture alias')
    expect(f.calls).toEqual([{ method: 'get_app_state', args: { app: 'Fixture alias', disableDiff: true } }])
    expect(f.emitted).toHaveLength(1)
    expect(f.emitted[0]?.type).toBe('text')
    expect(f.emitted[0]?.value).toContain('Native App API')
    expect(String(f.emitted[0]?.value).endsWith(full)).toBe(true)
    await app.click([15, 20])
    await app.pressKey('Cmd+A')
    expect(f.calls.slice(1)).toEqual([
      { method: 'click', args: { app: '/Applications/Fixture.app', x: 15, y: 20 } },
      { method: 'press_key', args: { app: '/Applications/Fixture.app', key: 'Cmd+A' } },
    ])
    expect(f.emitted).toHaveLength(1)
  })

  test('observations use the same native request but separate outputs and return values', async () => {
    const f = fixture()
    const app = await f.cua.getApp('Fixture')
    f.emitted.length = 0
    expect(await app.getAXState({ disableDiffing: true })).toBe(full)
    expect(f.calls.at(-1)).toEqual({ method: 'get_app_state', args: { app: '/Applications/Fixture.app', disableDiff: true } })
    expect(f.emitted).toEqual([{ type: 'text', value: full }])
    f.emitted.length = 0
    expect(Array.from(await app.getScreenshot())).toEqual([0, 1, 254, 255])
    expect(f.calls.at(-1)).toEqual({ method: 'get_app_state', args: { app: '/Applications/Fixture.app' } })
    expect(f.emitted).toEqual([{ type: 'image', value: { data: 'AAH+/w==', mimeType: 'image/png' } }])
    f.emitted.length = 0
    const both = await app.getAXStateAndScreenshot({ disableDiffing: false })
    expect(both.state).toBe(full)
    expect(Array.from(both.screenshot!)).toEqual([0, 1, 254, 255])
    expect(f.emitted.map(item => item.type)).toEqual(['text', 'image'])
    expect(f.calls.at(-1)?.args.disableDiff).toBe(false)
  })

  test('emit:false suppresses every observation output while returning usable data', async () => {
    const f = fixture()
    const app = await f.cua.getApp('Fixture')
    f.emitted.length = 0
    expect(await app.getAXState({ emit: false })).toBe(full)
    await app.click(1)
    expect(f.calls.at(-1)?.args.element_index).toBe('g7:1')
    expect(Array.from(await app.getScreenshot({ emit: false }))).toEqual([0, 1, 254, 255])
    const both = await app.getAXStateAndScreenshot({ emit: false })
    expect(both.state).toBe(full)
    expect(both.screenshot).toBeInstanceOf(Uint8Array)
    expect(f.emitted).toEqual([])
  })

  test('missing images preserve AX state but image-only calls reject', async () => {
    const f = fixture()
    const app = await f.cua.getApp('Fixture')
    f.results.push(state(full, false), state(full, false))
    expect(await app.getAXStateAndScreenshot({ emit: false })).toEqual({ state: full })
    await expect(app.getScreenshot()).rejects.toThrow('Screenshot unavailable')
    await expect(app.click(1)).rejects.toThrow('no current observed handle')
  })

  test('every native action maps names and parameters without implicit observations', async () => {
    const f = fixture()
    const app = await f.cua.getApp('Fixture')
    f.calls.length = 0
    await app.click(1, { mouseButton: 1, clickCount: 2 })
    await app.drag([1, 2], [30, 40])
    await app.pressKey('Meta+Shift+S')
    await app.scroll(4, 'down', 0.5)
    await app.scroll([50, 60], 'u')
    await app.paste('one')
    await app.paste('**two**', { format: 'md' })
    await app.typeText('three')
    await app.selectText(4, 'word', { prefix: 'a ', suffix: ' b', selectionType: 'cursor_after' })
    await app.setValue('g7:4', 'new')
    await app.performSecondaryAction(1, 'show menu')
    const appArg = { app: '/Applications/Fixture.app' }
    expect(f.calls).toEqual([
      { method: 'click', args: { ...appArg, element_index: 'g7:1', mouse_button: 'right', click_count: 2 } },
      { method: 'drag', args: { ...appArg, from_x: 1, from_y: 2, to_x: 30, to_y: 40 } },
      { method: 'press_key', args: { ...appArg, key: 'Meta+Shift+S' } },
      { method: 'scroll', args: { ...appArg, element_index: 'g7:4', direction: 'down', pages: 0.5 } },
      { method: 'scroll', args: { ...appArg, x: 50, y: 60, direction: 'up' } },
      { method: 'paste', args: { ...appArg, text: 'one', format: 'text' } },
      { method: 'paste', args: { ...appArg, text: '**two**', format: 'md' } },
      { method: 'type_text', args: { ...appArg, text: 'three' } },
      { method: 'select_text', args: { ...appArg, element_index: 'g7:4', text: 'word', prefix: 'a ', suffix: ' b', selection_type: 'cursor_after' } },
      { method: 'set_value', args: { ...appArg, element_index: 'g7:4', value: 'new' } },
      { method: 'perform_secondary_action', args: { ...appArg, element_index: 'g7:1', action: 'show menu' } },
    ])
  })

  test('official mouse aliases do not enter the older numeric convention', async () => {
    const f = fixture()
    const app = await f.cua.getApp('Fixture')
    for (const [input, output] of [[0, 'left'], [1, 'right'], [2, 'middle'], ['l', 'left'], ['r', 'right'], ['m', 'middle']] as const) {
      await app.click([1, 2], { mouseButton: input })
      expect(f.calls.at(-1)?.args.mouse_button).toBe(output)
    }
  })

  test('macOS accepts trimmed case-insensitive mouse aliases like its actual native client', async () => {
    const f = fixture()
    const app = await f.cua.getApp('Fixture')
    for (const [mouseButton, expected] of [[' RIGHT ', 'right'], ['Left', 'left'], [' M ', 'middle']] as const) {
      await app.click([1, 2], { mouseButton: mouseButton as 'right' })
      expect(f.calls.at(-1)?.args.mouse_button).toBe(expected)
    }
  })

  test('macOS scroll aliases normalize without accepting invalid pages or directions', async () => {
    const f = fixture()
    const app = await f.cua.getApp('Fixture')
    await app.scroll([1, 2], ' U ', 0.5)
    expect(f.calls.at(-1)?.args).toEqual({ app: '/Applications/Fixture.app', x: 1, y: 2, direction: 'up', pages: 0.5 })
    const calls = f.calls.length
    await expect(app.scroll([1, 2], 'diagonal')).rejects.toThrow('direction must be up, down, left, or right')
    for (const pages of [0, -1, Infinity, NaN]) {
      await expect(app.scroll([1, 2], 'down', pages)).rejects.toThrow('pages must be a finite number > 0')
    }
    expect(f.calls).toHaveLength(calls)
  })

  test('listApps preserves trusted inventory fields and does not infer running status', async () => {
    const f = fixture()
    const apps = [
      { id: 'fixture.running', displayName: 'Running', isRunning: true, lastUsedDate: '2026-01-02T03:04:05Z', useCount: 4 },
      { id: 'fixture.stopped', displayName: 'Stopped', isRunning: false },
      { id: 'fixture.unknown' },
    ]
    f.results.push({ content: [{ type: 'text', text: 'Legacy formatter must not override metadata' }], apps })
    expect(await f.cua.listApps({ emit: false })).toEqual(apps)
    expect(f.emitted).toEqual([])
  })

  test('computer exposes every actual macOS window member without browser or phantom initialization methods', async () => {
    const f = fixture()
    expect(Object.keys(f.cua).sort()).toEqual(['computer', 'getApp', 'getState', 'listApps'])
    const computer = f.cua.computer
    expect(Object.keys(computer).sort()).toEqual([
      'target', 'list_apps', 'get_app_state', 'click', 'drag', 'paste',
      'perform_secondary_action', 'press_key', 'scroll', 'select_text', 'set_value', 'type_text',
    ].sort())
    expect(computer.target).toBe('mac')
    const observation = await computer.get_app_state({ app: 'Fixture alias', disableDiff: true })
    expect(observation).toEqual({ app: '/Applications/Fixture.app', text: full, screenshot: { url: 'data:image/png;base64,AAH+/w==' } })
    await computer.click({ app: 'Fixture alias', element_index: 1, mouse_button: 1 })
    expect(f.calls.at(-1)).toEqual({ method: 'click', args: { app: 'Fixture alias', element_index: 'g7:1', mouse_button: 'right' } })
    expect(await computer.press_key({ app: 'Fixture alias', key: 'Cmd+A' })).toBeUndefined()
    expect(f.emitted).toEqual([])
  })

  test('all raw window actions keep native arguments, return undefined and never insert an observation', async () => {
    const f = fixture()
    const computer = f.cua.computer
    const target = { app: '/Applications/Fixture.app' }
    await computer.get_app_state(target)
    f.calls.length = 0
    const cases = [
      ['click', { ...target, element_index: 1, mouse_button: ' RIGHT ', click_count: 2 }, { ...target, element_index: 'g7:1', mouse_button: 'right', click_count: 2 }],
      ['drag', { ...target, from_x: 1, from_y: 2, to_x: 3, to_y: 4 }],
      ['paste', { ...target, text: '<p>html</p>', format: 'html' }],
      ['perform_secondary_action', { ...target, element_index: 1, action: 'AXShowMenu' }, { ...target, element_index: 'g7:1', action: 'AXShowMenu' }],
      ['press_key', { ...target, key: 'Cmd+Shift+A' }],
      ['scroll', { ...target, x: 1, y: 2, direction: ' U ', pages: 0.5 }, { ...target, x: 1, y: 2, direction: 'up', pages: 0.5 }],
      ['select_text', { ...target, element_index: 4, text: 'word', prefix: 'a ', suffix: ' b', selection_type: 'cursor_before' }, { ...target, element_index: 'g7:4', text: 'word', prefix: 'a ', suffix: ' b', selection_type: 'cursor_before' }],
      ['set_value', { ...target, element_index: 4, value: 'new' }, { ...target, element_index: 'g7:4', value: 'new' }],
      ['type_text', { ...target, text: 'typed' }],
    ] as const
    for (const [method, input, expected] of cases) {
      const call = computer[method] as (value: unknown) => Promise<void>
      expect(await call(input)).toBeUndefined()
      expect(f.calls.at(-1)).toEqual({ method, args: expected ?? input })
    }
    expect(f.calls).toHaveLength(cases.length)
    expect(f.emitted).toEqual([])
  })

  test('a failed raw observation invalidates integer aliases shared with bound Apps', async () => {
    const f = fixture()
    const app = await f.cua.getApp('Fixture alias')
    f.results.push({ isError: true, content: [{ type: 'text', text: 'Fixture capture failed' }] })
    await expect(f.cua.computer.get_app_state({ app: 'Fixture alias' })).rejects.toThrow('Fixture capture failed')
    const count = f.calls.length
    await expect(app.click(1)).rejects.toThrow('no current observed handle')
    await expect(f.cua.computer.click({ app: 'Fixture alias', element_index: 1 })).rejects.toThrow('no current observed handle')
    expect(f.calls).toHaveLength(count)
    await f.cua.computer.get_app_state({ app: 'Fixture alias', disableDiff: true })
    await app.click(1)
    expect(f.calls.at(-1)?.args.element_index).toBe('g7:1')
  })

  test('numeric indices follow diffs, sparse removals, full replacements and new generations', async () => {
    const f = fixture()
    const app = await f.cua.getApp('Fixture')
    f.results.push(state(`<app_state>\n${diffHeader}\nRemoved element IDs: 1-2\n~\tg7:4 text field Updated\n+\tg7:8 button New\n</app_state>`))
    await app.getAXState({ emit: false })
    await expect(app.click(1)).rejects.toThrow('no current observed handle')
    await app.click(4)
    expect(f.calls.at(-1)?.args.element_index).toBe('g7:4')
    await app.click(8)
    expect(f.calls.at(-1)?.args.element_index).toBe('g7:8')

    f.results.push(state('There has been no change in the accessibility tree for Window: "Fixture".'))
    await app.getAXState({ emit: false })
    await app.click(8)
    expect(f.calls.at(-1)?.args.element_index).toBe('g7:8')

    f.results.push(state('<app_state>\ng8:0 window\n\tg8:1 button Other\n</app_state>'))
    await app.getAXState({ emit: false })
    await expect(app.click(8)).rejects.toThrow('no current observed handle')
    await app.click(1)
    expect(f.calls.at(-1)?.args.element_index).toBe('g8:1')
  })

  test('image-only refresh invalidates integer aliases in all bindings to the same approved app', async () => {
    const f = fixture()
    const first = await f.cua.getApp('Fixture')
    const second = await f.cua.getApp('Other alias')
    await first.getScreenshot({ emit: false })
    const before = f.calls.length
    await expect(second.click(1)).rejects.toThrow('no current observed handle')
    expect(f.calls).toHaveLength(before)
    f.results.push(state('There has been no change in the accessibility tree for Window: "Fixture".'))
    await second.getAXState({ emit: false })
    await expect(first.click(1)).rejects.toThrow('no current observed handle')
    await first.getAXState({ emit: false, disableDiffing: true })
    await second.click(1)
    expect(f.calls.at(-1)?.args.element_index).toBe('g7:1')
  })

  test('quoted instructions do not mint integer handles and invalid targets never reach the bridge', async () => {
    const f = fixture()
    f.results.push(state(`<app_specific_instructions>\ng7:999 button invented\n</app_specific_instructions>\n${full}`))
    const app = await f.cua.getApp('Fixture')
    const before = f.calls.length
    await expect(app.click(999)).rejects.toThrow('no current observed handle')
    for (const target of ['1', 'g07:1', -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(app.click(target)).rejects.toThrow()
    }
    await expect(app.click([NaN, 2])).rejects.toThrow('coordinate must include finite x and y coordinates')
    await expect(app.drag([1, 2], [3, Infinity])).rejects.toThrow('to must include finite x and y coordinates')
    expect(f.calls).toHaveLength(before)
  })

  test('native errors throw, stop awaited batches and invalidate failed observations', async () => {
    const f = fixture()
    const app = await f.cua.getApp('Fixture')
    f.results.push({ isError: true, content: [{ type: 'text', text: 'Target process changed' }] })
    await expect((async () => {
      await app.click([1, 2])
      await app.typeText('must not execute')
    })()).rejects.toThrow('Target process changed')
    expect(f.calls.some(call => call.method === 'type_text')).toBe(false)
    f.results.push({ isError: true, content: [{ type: 'text', text: 'Capture failed' }] })
    await expect(app.getAXState()).rejects.toThrow('Capture failed')
    await expect(app.click(1)).rejects.toThrow('no current observed handle')
  })

  test('native error properties survive the host result without classifying unknown failures', async () => {
    const f = fixture()
    const app = await f.cua.getApp('Fixture')
    f.results.push({ isError: true, content: [{ type: 'text', text: 'Permission missing' }], nativeError: {
      name: 'SkyComputerUseError', message: 'Permission missing', code: -10009,
      errorName: 'permissionsNotGranted', nativeCode: 'not_trusted', request: null, requestType: 'jsonRPC',
    } })
    const denied = await app.click([1, 2]).catch(error => error)
    expect(denied).toBeInstanceOf(Error)
    expect(denied).toMatchObject({ name: 'SkyComputerUseError', message: 'Permission missing', code: -10009,
      errorName: 'permissionsNotGranted', nativeCode: 'not_trusted', request: null, requestType: 'jsonRPC' })
    f.results.push({ isError: true, content: [], nativeError: { name: 'Error', message: 'Unknown outcome', nativeCode: 'stale_process' } })
    const unknown = await app.drag([1, 2], [3, 4]).catch(error => error)
    expect(unknown).toMatchObject({ name: 'Error', message: 'Unknown outcome', nativeCode: 'stale_process' })
    expect(unknown.code).toBeUndefined()
    expect(unknown.errorName).toBeUndefined()
    f.results.push({ isError: true, content: [], nativeError: { name: 'TypeError', message: 'Invalid client argument' } })
    expect(await app.pressKey('Cmd+A').catch(error => error)).toBeInstanceOf(TypeError)
  })

  test('inventory returns native app data and emits only when requested', async () => {
    const f = fixture()
    f.results.push({ content: [{ type: 'text', text: 'Fixture — com.test.fixture\nOther — com.test.other' }] })
    expect(await f.cua.listApps({ emit: false })).toEqual([
      { id: 'com.test.fixture', displayName: 'Fixture', isRunning: true },
      { id: 'com.test.other', displayName: 'Other', isRunning: true },
    ])
    expect(f.emitted).toEqual([])
    f.results.push({ content: [{ type: 'text', text: 'No running applications are available to control.' }] })
    expect(await f.cua.getState()).toEqual({ apps: [], browsers: [] })
    expect(f.emitted).toHaveLength(1)
    expect(f.emitted[0]?.value).toContain('Native App API')
    expect(String(f.emitted[0]?.value).endsWith('{"apps":[],"browsers":[]}')).toBe(true)
  })

  test('API guidance appears on the first visible selection only, never at bootstrap', async () => {
    const f = fixture()
    expect(f.emitted).toEqual([])
    f.results.push({ content: [] })
    await f.cua.getState({ emit: false })
    expect(f.emitted).toEqual([])
    await f.cua.getApp('Fixture')
    expect(f.emitted[0]?.value).toContain('Native App API')
    expect(f.emitted[0]?.value).toContain('setTimeout/clearTimeout and setInterval/clearInterval')
    expect(f.emitted[0]?.value).toContain('Do not schedule actions after the cell returns')
    await f.cua.getApp('Fixture again')
    expect(f.emitted[1]?.value).toBe(full)
    f.results.push({ content: [] })
    await f.cua.getState()
    expect(f.emitted[2]?.value).toBe('{"apps":[],"browsers":[]}')
  })
})

describe('worker bootstrap source', () => {
  test('JPEG captures retain bytes and MIME through automatic, raw and deferred output', async () => {
    const output: Array<Record<string, unknown>> = []
    const context = createContext({ __cuInvoke: async () => jpegState(), __cuEmit: (value: Record<string, unknown>) => output.push(value) })
    runInContext(REPL_BOOTSTRAP_SOURCE, context)
    await runInContext(`(async () => {
      const app = await cua.getApp('Fixture')
      await app.getScreenshot()
      await app.getAXStateAndScreenshot()
      const bytes = await app.getScreenshot({emit:false})
      await nodeRepl.emitImage(bytes)
      await nodeRepl.emitImage({bytes})
      const raw = await cua.computer.get_app_state({app:'Fixture'})
      nodeRepl.write(raw.screenshot.url)
    })()`, context)
    const images = output.filter(item => item.type === 'image')
    expect(images).toHaveLength(4)
    for (const image of images) {
      expect(image).toEqual({ type: 'image', data: jpeg, mimeType: 'image/jpeg' })
      expect(Buffer.from(image.data as string, 'base64')).toEqual(Buffer.from(jpeg, 'base64'))
    }
    expect(output.at(-1)).toEqual({ type: 'text', text: `data:image/jpeg;base64,${jpeg}` })
  })

  test('the shared JS example performs two known drags and observes only once', async () => {
    const example = COMPUTER_USE_BATCHING_GUIDANCE.match(/```javascript\n([^`]+)\n```/)
    expect(example).not.toBeNull()
    const calls: Array<{ method: string; args: unknown }> = []
    const context = createContext({
      __cuInvoke: async (method: string, args: unknown) => {
        calls.push({ method, args })
        return state()
      },
      __cuEmit: () => {},
    })
    runInContext(REPL_BOOTSTRAP_SOURCE, context)
    await runInContext('cua.getApp("Canvas App").then(value => globalThis.app = value)', context)
    calls.length = 0
    await runInContext(`(async () => {${example![1]}})()`, context)
    expect(calls.map(call => call.method)).toEqual(['drag', 'drag', 'get_app_state'])
    expect(calls[0]?.args).toEqual({ app: '/Applications/Fixture.app', from_x: 240, from_y: 320, to_x: 241, to_y: 320 })
    expect(calls[1]?.args).toEqual({ app: '/Applications/Fixture.app', from_x: 280, from_y: 320, to_x: 281, to_y: 320 })
  })

  test('runs with standard JavaScript globals, preserves app bindings and emits image bytes without Node', async () => {
    const calls: Array<{ method: string; args: unknown }> = []
    const output: Array<Record<string, unknown>> = []
    const context = createContext({
      __cuInvoke: async (method: string, args: unknown) => {
        calls.push({ method, args })
        return state()
      },
      __cuEmit: (content: Record<string, unknown>) => output.push(content),
    })
    runInContext(REPL_BOOTSTRAP_SOURCE, context)
    await runInContext('globalThis.app = awaitPromise = cua.getApp("Fixture")', context)
    await runInContext('app = awaitPromise.then(async a => { await a.click([1,2]); return a })', context)
    // Separate cells share variables, while the facade itself has no Node dependency.
    await runInContext('(async () => { const a = await app; const bytes = await a.getScreenshot({emit:false}); await nodeRepl.emitImage({bytes,mimeType:"image/png"}); await nodeRepl.write({length:bytes.length}); })()', context)
    expect(calls.map(call => call.method)).toEqual(['get_app_state', 'click', 'get_app_state'])
    expect(output.at(-2)).toEqual({ type: 'image', data: 'AAH+/w==', mimeType: 'image/png' })
    expect(output.at(-1)).toEqual({ type: 'text', text: '{"length":4}' })
    expect(runInContext('[typeof process, typeof Buffer, typeof require]', context)).toEqual(['undefined', 'undefined', 'undefined'])
  })

  test('image emission roundtrips empty, padded and unpadded byte groups', async () => {
    const output: Array<Record<string, unknown>> = []
    const context = createContext({ __cuInvoke: async () => state(), __cuEmit: (value: Record<string, unknown>) => output.push(value) })
    runInContext(REPL_BOOTSTRAP_SOURCE, context)
    await runInContext('(async () => { for (let n = 0; n < 8; n++) await nodeRepl.emitImage(new Uint8Array(Array.from({length:n}, (_,i) => i * 31))); })()', context)
    for (let n = 0; n < 8; n++) {
      expect(output[n]?.data).toBe(Buffer.from(Array.from({ length: n }, (_, i) => i * 31)).toString('base64'))
    }
    await expect(runInContext('nodeRepl.emitImage("file:///private/fixture.png")', context)).rejects.toThrow('requires Uint8Array')
  })
})
