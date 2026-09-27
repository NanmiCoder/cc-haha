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
