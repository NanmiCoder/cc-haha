import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { createContext, runInContext } from 'node:vm'
import sharp from 'sharp'
import type { ToolUseContext } from '../../Tool.js'
import * as imageProcessor from '../../tools/FileReadTool/imageProcessor.js'
import { MCPTool } from '../../tools/MCPTool/MCPTool.js'
import { frameAppStateEnvelope } from '../../vendor/computer-use-mcp/toolCalls.js'
import { anthropicToOpenaiChat } from '../../server/proxy/transform/anthropicToOpenaiChat.js'
import { anthropicToOpenaiResponses } from '../../server/proxy/transform/anthropicToOpenaiResponses.js'
import type { AnthropicContentBlock, AnthropicRequest } from '../../server/proxy/transform/types.js'
import { dispatchComputerUseCall } from './wrapper.js'
import { REPL_BOOTSTRAP_SOURCE } from '../../vendor/computer-use-mcp/replApi.js'

// Opaque fixture bytes: an unreadable header must not prevent image delivery
// or cause the transport to resize or relabel the screenshot.
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0x4a, 0x46, 0xff, 0xd9]).toString('base64')

let restoreProcessor: (() => void) | undefined
beforeEach(() => {
  // The aggregate coverage lane shares a process with image-resizer tests
  // that mock this loader. Exercise real image headers and restore our spy.
  const loader = spyOn(imageProcessor, 'getImageProcessor').mockResolvedValue(sharp)
  restoreProcessor = () => loader.mockRestore()
})
afterEach(() => restoreProcessor?.())

test('a JPEG native screenshot keeps its bytes and MIME through the real CLI tool result and both model protocols', async () => {
  const nativeResult = frameAppStateEnvelope({
    pid: 42, elementCount: 1, truncated: false, durationMs: 1,
    axText: 'App=Fixture\nWindow: Canvas',
    screenshot: { base64: jpeg, width: 360, height: 280, mimeType: 'image/jpeg' },
  })
  const result = await dispatchComputerUseCall(async () => nativeResult, 'js', {
    code: 'await app.getAXStateAndScreenshot()',
  }, { abortController: new AbortController() } as ToolUseContext)
  const toolResult = MCPTool.mapToolResultToToolResultBlockParam(result.data as never, 'cu-shot')
  const image = (toolResult.content as AnthropicContentBlock[]).find(block => block.type === 'image')
  expect(image).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg } })

  const request: AnthropicRequest = {
    model: 'fixture', max_tokens: 100,
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'cu-shot', name: 'computer_use', input: {} }] },
      { role: 'user', content: [toolResult as AnthropicContentBlock] },
    ],
  }
  for (const converted of [anthropicToOpenaiChat(request), anthropicToOpenaiResponses(request)]) {
    const wire = JSON.stringify(converted)
    expect(wire).toContain(`data:image/jpeg;base64,${jpeg}`)
    expect(wire).not.toContain('data:image/png;')
  }
})

test('older native helpers without screenshot MIME retain their PNG transport contract', async () => {
  const nativeResult = frameAppStateEnvelope({
    pid: 42, elementCount: 0, truncated: false, durationMs: 1, axText: 'App=Fixture',
    screenshot: { base64: 'iVBORw==', width: 1, height: 1 },
  })
  const result = await dispatchComputerUseCall(async () => nativeResult, 'js', {}, {
    abortController: new AbortController(),
  } as ToolUseContext)
  expect(result.data).toContainEqual({
    type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw==' },
  })
})

async function screenshotFixture(width: number, height: number, format: 'jpeg' | 'png' = 'jpeg') {
  const image = sharp({ create: { width, height, channels: 3, background: { r: 255, g: 255, b: 255 } } })
  return (await image[format]().toBuffer()).toString('base64')
}

test('every visible native observation carries the actual image pixel grid through the model protocols', async () => {
  const data = await screenshotFixture(1084, 752)
  const nativeResult = frameAppStateEnvelope({
    pid: 42, elementCount: 0, truncated: false, durationMs: 1, axText: 'App=Fixture',
    screenshot: { base64: data, width: 1084, height: 752, mimeType: 'image/jpeg' },
  })
  for (const code of [
    'await app.getAXStateAndScreenshot()',
    'await app.getScreenshot()',
    'const bytes = await app.getScreenshot({emit:false}); await nodeRepl.emitImage(bytes)',
  ]) {
    const emitted: typeof nativeResult.content = []
    const realm = createContext({
      __cuInvoke: async () => nativeResult,
      __cuEmit: (block: typeof emitted[number]) => emitted.push(block),
    })
    runInContext(REPL_BOOTSTRAP_SOURCE, realm)
    await runInContext('cua.getApp("Fixture").then(value => { globalThis.app = value })', realm)
    emitted.length = 0
    await runInContext(`(async () => { ${code} })()`, realm)
    const result = await dispatchComputerUseCall(async () => ({ content: emitted }), 'js', { code }, {
      abortController: new AbortController(),
    } as ToolUseContext)
    const imageIndex = result.data.findIndex(block => block.type === 'image')
    const caption = result.data[imageIndex - 1]
    expect(caption?.type).toBe('text')
    const captionText = caption?.type === 'text' ? caption.text : ''
    expect(captionText).toContain('Image 1: 1084×752 pixels')
    expect(captionText).toContain('top-left (0,0), bottom-right (1083,751)')
    expect(result.data[imageIndex]).toEqual({
      type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data },
    })
    const toolResult = MCPTool.mapToolResultToToolResultBlockParam(result.data as never, 'cu-shot')
    const request: AnthropicRequest = {
      model: 'fixture', max_tokens: 100,
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'cu-shot', name: 'computer_use', input: {} }] },
        { role: 'user', content: [toolResult as AnthropicContentBlock] },
      ],
    }
    for (const converted of [anthropicToOpenaiChat(request), anthropicToOpenaiResponses(request)]) {
      const wire = JSON.stringify(converted)
      expect(wire).toContain('Image 1: 1084×752 pixels')
      expect(wire).toContain(`data:image/jpeg;base64,${data}`)
    }

    emitted.length = 0
    await runInContext('app.getScreenshot({emit:false})', realm)
    const silent = await dispatchComputerUseCall(async () => ({ content: emitted }), 'js', {}, {
      abortController: new AbortController(),
    } as ToolUseContext)
    expect(silent.data).toEqual([])
  }
})

test('multiple images have independent numbered dimensions without changing their bytes', async () => {
  const first = await screenshotFixture(1084, 752)
  const second = await screenshotFixture(80, 120, 'png')
  const result = await dispatchComputerUseCall(async () => ({ content: [
    { type: 'image', data: first, mimeType: 'image/jpeg' },
    { type: 'text', text: 'A second observation follows.\n' },
    { type: 'image', data: second, mimeType: 'image/png' },
  ] }), 'js', {}, { abortController: new AbortController() } as ToolUseContext)
  expect(result.data).toHaveLength(5)
  const captions = result.data.filter(block => block.type === 'text').map(block => block.text)
  expect(captions[0]).toContain('Image 1: 1084×752 pixels')
  expect(captions[2]).toContain('Image 2: 80×120 pixels')
  expect(captions[2]).toContain('bottom-right (79,119)')
  expect(result.data[1]).toMatchObject({ source: { data: first } })
  expect(result.data[4]).toMatchObject({ source: { data: second, media_type: 'image/png' } })
  const toolResult = MCPTool.mapToolResultToToolResultBlockParam(result.data as never, 'cu-multi')
  const request: AnthropicRequest = {
    model: 'fixture', max_tokens: 100,
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'cu-multi', name: 'computer_use', input: {} }] },
      { role: 'user', content: [toolResult as AnthropicContentBlock] },
    ],
  }
  for (const converted of [anthropicToOpenaiChat(request), anthropicToOpenaiResponses(request)]) {
    const wire = JSON.stringify(converted)
    expect(wire).toContain('Image 1: 1084×752 pixels')
    expect(wire).toContain('Image 2: 80×120 pixels')
    expect(wire.indexOf(first)).toBeLessThan(wire.indexOf(second))
  }
})

test('Windows screenshot hints describe image pixels without changing action units, and zoom keeps full-screen coordinates', async () => {
  const data = await screenshotFixture(200, 100)
  for (const toolName of ['screenshot', 'zoom']) {
    const args = toolName === 'zoom' ? { region: [10, 20, 110, 70] } : {}
    const result = await dispatchComputerUseCall(async (name, input) => {
      expect(name).toBe(toolName)
      expect(input).toBe(args)
      return { content: [{ type: 'image', data, mimeType: 'image/jpeg' }] }
    }, toolName, args, { abortController: new AbortController() } as ToolUseContext)
    const caption = result.data[0]
    const text = caption?.type === 'text' ? caption.text : ''
    expect(text).toContain('Image 1: 200×100 pixels')
    expect(text).toContain('Image pixel bounds: top-left (0,0), bottom-right (199,99)')
    expect(text).not.toContain('Click')
    expect(text.endsWith('\n')).toBe(true)
    if (toolName === 'zoom') expect(text).toContain('action coordinates still refer to the full-screen screenshot')
  }
})

test('unreadable image dimensions preserve the receipt and do not invent a pixel grid', async () => {
  const result = await dispatchComputerUseCall(async () => ({ content: [
    { type: 'text', text: 'Action completed.' },
    { type: 'image', data: jpeg, mimeType: 'image/jpeg' },
  ] }), 'js', {}, { abortController: new AbortController() } as ToolUseContext)
  expect(result.data).toEqual([
    { type: 'text', text: 'Action completed.' },
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg } },
  ])
})
