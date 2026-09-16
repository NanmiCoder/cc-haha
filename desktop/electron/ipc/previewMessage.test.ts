import { describe, expect, it } from 'vitest'
import { parsePreviewAgentMessage } from './previewMessage'

describe('workspace browser zoom events', () => {
  it.each(['in', 'out', 'reset'])('accepts only the bounded %s action', action => {
    expect(parsePreviewAgentMessage(JSON.stringify({ v: 1, type: 'browser-zoom', action })))
      .toEqual({ v: 1, type: 'browser-zoom', action })
  })
  it.each(['navigate', 2, null, { zoom: 2 }])('rejects an invalid action %j', action => {
    expect(parsePreviewAgentMessage(JSON.stringify({ v: 1, type: 'browser-zoom', action }))).toBeNull()
  })
})

describe('selection capture ownership', () => {
  const selection = (captureId?: unknown) => JSON.stringify({ v: 1, type: 'selection',
    payload: { element: { tag: 'h1' }, screenshot: { kind: 'region', ...(captureId === undefined ? {} : { captureId }) } },
  })
  it('accepts an optional capture generation while retaining legacy selection messages', () => {
    expect(parsePreviewAgentMessage(selection(41))).toMatchObject({ payload: { screenshot: { captureId: 41 } } })
    expect(parsePreviewAgentMessage(selection())).toMatchObject({ type: 'selection' })
  })
  it.each([0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, '41', null])('rejects invalid capture generation %j', value => {
    expect(parsePreviewAgentMessage(selection(value))).toBeNull()
  })
})


it('preserves picker event ownership and accepts the optional capability handshake', () => {
  expect(parsePreviewAgentMessage('{"v":1,"type":"ready","supportsPickerGeneration":true}')).toEqual({ v: 1, type: 'ready', supportsPickerGeneration: true })
  for (const type of ['selection', 'picker-exited']) {
    const base = { v: 1, type, ...(type === 'selection' ? { payload: {} } : {}) }
    expect(parsePreviewAgentMessage(JSON.stringify({ ...base, generation: 42 }))).toMatchObject({ generation: 42 })
    for (const generation of [0, -1, 0.1, Number.MAX_SAFE_INTEGER + 1, '42', null]) {
      expect(parsePreviewAgentMessage(JSON.stringify({ ...base, generation }))).toBeNull()
    }
    expect(parsePreviewAgentMessage(JSON.stringify(base))).toMatchObject(base)
  }
})
