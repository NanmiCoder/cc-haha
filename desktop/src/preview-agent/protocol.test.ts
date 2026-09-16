import { describe, expect, it } from 'vitest'
import { parseHostMessage, serializeAgentMessage } from './protocol'

describe('preview-agent protocol', () => {
  it('bounds and localizes native browser control configuration', () => {
    const config = {
      v: 1, type: 'browser-controls', zoomFactor: 0.8, appZoom: 1,
      copy: { zoom: '缩放', zoomOut: '缩小', zoomIn: '放大', zoomReset: '恢复' },
      colors: { background: 'white', foreground: 'black', muted: 'gray', border: 'gray', hover: 'white', focus: 'blue', shadow: 'none' },
    }
    expect(parseHostMessage(JSON.stringify(config))).toMatchObject({ type: 'browser-controls', copy: config.copy, zoomFactor: 0.8 })
    expect(parseHostMessage(JSON.stringify({ ...config, zoomFactor: 2.5 }))).toMatchObject({ zoomFactor: 2.5 })
    for (const invalid of [{ zoomFactor: 0 }, { zoomFactor: 11 }, { appZoom: null }, { copy: { zoom: 'x' } }, { colors: [] }]) {
      expect(parseHostMessage(JSON.stringify({ ...config, ...invalid }))).toBeNull()
    }
    expect(JSON.parse(serializeAgentMessage({ type: 'browser-zoom', action: 'reset' }))).toEqual({ v: 1, type: 'browser-zoom', action: 'reset' })
  })
  it('serializes agent→host messages to a stable envelope', () => {
    expect(JSON.parse(serializeAgentMessage({ type: 'ready' }))).toEqual({ v: 1, type: 'ready' })
    expect(JSON.parse(serializeAgentMessage({ type: 'navigated', url: 'http://x/', title: 'T' })))
      .toEqual({ v: 1, type: 'navigated', url: 'http://x/', title: 'T' })
  })
  it('parses host→agent messages and rejects unknown/garbage', () => {
    expect(parseHostMessage('{"v":1,"type":"enter-picker"}')).toEqual({ type: 'enter-picker' })
    expect(parseHostMessage('not json')).toBeNull()
    expect(parseHostMessage('{"v":1,"type":"nope"}')).toBeNull()
  })

  it('validates batch picker context and draft commands', () => {
    const copy = {
      cancel: 'Cancel',
      send: 'Send',
      queueAndContinue: 'Add & continue',
      add: 'Add',
      descriptionPlaceholder: 'Describe changes…',
    }
    expect(parseHostMessage(JSON.stringify({ v: 1, type: 'enter-picker', mode: 'batch', label: 4, copy })))
      .toEqual({ type: 'enter-picker', mode: 'batch', label: 4, copy })
    expect(parseHostMessage('{"v":1,"type":"undo-selection","itemId":"item-4"}'))
      .toEqual({ type: 'undo-selection', itemId: 'item-4' })
    expect(parseHostMessage('{"v":1,"type":"enter-picker","mode":"forever"}')).toBeNull()
    expect(parseHostMessage('{"v":1,"type":"undo-selection","itemId":""}')).toBeNull()
  })
})


it('supports opt-in persistent picking while preserving legacy v1 single-shot messages', () => {
  expect(parseHostMessage('{"v":1,"type":"enter-picker","persistent":true}')).toEqual({ type: 'enter-picker', persistent: true })
  expect(parseHostMessage('{"v":1,"type":"enter-picker","persistent":"yes"}')).toBeNull()
  expect(parseHostMessage('{"v":1,"type":"enter-picker"}')).toEqual({ type: 'enter-picker' })
})


it('validates optional picker generations on both enter and exit, preserving old v1', () => {
  for (const type of ['enter-picker', 'exit-picker']) {
    expect(parseHostMessage(JSON.stringify({ v: 1, type, generation: 42 }))).toEqual({ type, generation: 42 })
    for (const generation of [0, -1, 0.1, Number.MAX_SAFE_INTEGER + 1, '42', null]) {
      expect(parseHostMessage(JSON.stringify({ v: 1, type, generation }))).toBeNull()
    }
    expect(parseHostMessage(JSON.stringify({ v: 1, type }))).toEqual({ type })
  }
})
