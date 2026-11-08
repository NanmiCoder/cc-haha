import { describe, expect, test } from 'bun:test'
import { createTraceRequestSemantic, createTraceBodySnapshot, TRACE_CAPTURE_NODE_LIMIT, TRACE_CAPTURE_CHAR_LIMIT, TRACE_CAPTURE_DEPTH_LIMIT } from './traceCapture.js'

describe('createTraceRequestSemantic', () => {
  test('keeps proxy request structure while replacing Computer Use image data with metadata', () => {
    const imageData = 'AQID'.repeat(4)
    const semantic = createTraceRequestSemantic({
      anthropic: {
        model: 'deepseek-v4-flash-vision-exp',
        system: [{ type: 'text', text: 'You are Claude Code.' }],
        messages: [{
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'computer_1',
            content: [{
              type: 'image',
              source: { type: 'base64', media_type: 'image/jpeg', data: imageData },
            }],
          }],
        }],
      },
      upstream: { messages: [{ role: 'tool', content: `data:image/jpeg;base64,${imageData}` }] },
    }, 'proxy')

    expect(semantic).toMatchObject({
      version: 1,
      request: {
        model: 'deepseek-v4-flash-vision-exp',
        system: [{ type: 'text', text: 'You are Claude Code.' }],
        messages: [{
          content: [{
            type: 'tool_result',
            tool_use_id: 'computer_1',
            content: [{
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/jpeg',
                bytes: 12,
                sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
              },
            }],
          }],
        }],
      },
    })
    expect(JSON.stringify(semantic)).not.toContain(imageData)
    expect(JSON.stringify(semantic)).not.toContain('upstream')
  })

  test('keeps the proxy envelope when its upstream request repeats a screenshot', () => {
    const data = 'AQID'.repeat(TRACE_CAPTURE_CHAR_LIMIT / 4 + 1)
    const dataUrl = `data:image/png;base64,${data}`
    const anthropic = { messages: [{ role: 'user', content: 'Read the screenshot.' }], tools: [{ name: 'Read' }] }
    const body = {
      anthropic,
      upstream: {
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: dataUrl, detail: 'high' } }] }],
        input: [{ role: 'user', content: [{ type: 'input_image', image_url: dataUrl }] }],
        contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data } }] }],
        token: 'fixture-token',
      },
    }
    const snapshot = createTraceBodySnapshot(body, { compactRequestImages: true })
    const omittedUrl = `[image/png data omitted (${data.length} encoded characters)]`

    expect(snapshot.truncated).toBe(true)
    expect(snapshot.captureOmitted).toBeUndefined()
    expect(JSON.parse(snapshot.preview)).toEqual({
      anthropic,
      upstream: {
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: omittedUrl, detail: 'high' } }] }],
        input: [{ role: 'user', content: [{ type: 'input_image', image_url: omittedUrl }] }],
        contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/png', encodedChars: data.length } }] }],
        token: '[redacted]',
      },
    })
    expect(createTraceRequestSemantic(body, 'proxy')?.request).toEqual(anthropic)
    expect(body.upstream.messages[0]!.content[0]!.image_url.url).toBe(dataUrl)
  })
})


test('capture budgets omit oversized trees without evaluating getters or array elements', () => {
  let visited = 0
  const hugeMessages = new Proxy(new Array(TRACE_CAPTURE_NODE_LIMIT + 1), {
    getOwnPropertyDescriptor(target, key) {
      visited += 1
      return Reflect.getOwnPropertyDescriptor(target, key)
    },
  })
  const body = { model: 'unchanged', messages: hugeMessages }
  const semantic = createTraceRequestSemantic(body, 'anthropic')
  expect(semantic?.request).toMatchObject({ traceCaptureOmitted: { reason: 'node-budget' } })
  expect(visited).toBe(0)
  expect(body.messages).toBe(hugeMessages)
  let getterCalls = 0
  const metadata = { get expensive() { getterCalls += 1; return 'unreachable' } }
  expect(createTraceBodySnapshot(metadata).captureOmitted).toBe('accessor')
  expect(getterCalls).toBe(0)
  let toJsonCalls = 0
  const withSerializer = { toJSON() { toJsonCalls += 1; return 'unreachable' } }
  expect(createTraceBodySnapshot(withSerializer).captureOmitted).toBe('unsupported-value')
  expect(toJsonCalls).toBe(0)
  const wide = createTraceBodySnapshot({ text: 'x'.repeat(TRACE_CAPTURE_CHAR_LIMIT + 1) })
  expect(wide.captureOmitted).toBe('string-budget')
  expect(wide.truncated).toBe(true)
  expect(wide.preview.length).toBeLessThan(1024)
  let nested: unknown = { value: 'end' }
  for (let i = 0; i < TRACE_CAPTURE_DEPTH_LIMIT + 2; i++) nested = { nested }
  expect(createTraceBodySnapshot(nested).captureOmitted).toBe('depth-budget')
})

test('the request image path does not run getters or exempt other oversized data', () => {
  let getterCalls = 0
  const image = { type: 'image', source: {
    type: 'base64',
    get data() { getterCalls += 1; return 'unreachable' },
  } }
  expect(createTraceBodySnapshot({ messages: [{ content: [image] }] }, { compactRequestImages: true }).captureOmitted).toBe('accessor')
  expect(getterCalls).toBe(0)

  const data = 'x'.repeat(TRACE_CAPTURE_CHAR_LIMIT + 1)
  const toolInput = { type: 'tool_use', name: 'Write', input: { data } }
  expect(createTraceRequestSemantic({ messages: [{ content: [toolInput] }] }, 'anthropic')?.request)
    .toMatchObject({ traceCaptureOmitted: { reason: 'string-budget' } })
})
