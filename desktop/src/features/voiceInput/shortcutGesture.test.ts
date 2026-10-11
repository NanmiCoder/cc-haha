import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VoiceShortcut } from './shortcut'
import { HOLD_THRESHOLD_MS, ShortcutGesture } from './shortcutGesture'

const NO_MODIFIERS = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, repeat: false }

function setup(shortcut: VoiceShortcut = { kind: 'modifier', code: 'ControlRight' }) {
  let active = false
  const actions = {
    isActive: () => active,
    start: vi.fn(() => { active = true }),
    stop: vi.fn(() => { active = false }),
    cancel: vi.fn(() => { active = false }),
  }
  return { gesture: new ShortcutGesture(shortcut, actions), actions }
}

const down = (code: string, extra: Partial<typeof NO_MODIFIERS> = {}) => ({ ...NO_MODIFIERS, code, ...extra })

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('lone modifier', () => {
  it('ignores key repeat while held', () => {
    const { gesture, actions } = setup()
    gesture.keyDown(down('ControlRight', { ctrlKey: true }))
    vi.advanceTimersByTime(HOLD_THRESHOLD_MS)
    gesture.keyDown(down('ControlRight', { ctrlKey: true, repeat: true }))
    gesture.keyDown(down('ControlRight', { ctrlKey: true, repeat: true }))
    expect(actions.start).toHaveBeenCalledTimes(1)
    expect(actions.stop).not.toHaveBeenCalled()
  })

  it('stops a hold when the window loses focus mid-press', () => {
    const { gesture, actions } = setup()
    gesture.keyDown(down('ControlRight', { ctrlKey: true }))
    vi.advanceTimersByTime(HOLD_THRESHOLD_MS)
    gesture.blur()
    expect(actions.stop).toHaveBeenCalledTimes(1)
    // The release that never came does not matter any more.
    gesture.keyUp({ code: 'ControlRight' })
    expect(actions.start).toHaveBeenCalledTimes(1)
  })

  it('forgets a press that lost focus before it could be a tap or a hold', () => {
    const { gesture, actions } = setup()
    gesture.keyDown(down('ControlRight', { ctrlKey: true }))
    gesture.blur()
    vi.advanceTimersByTime(HOLD_THRESHOLD_MS * 2)
    gesture.keyUp({ code: 'ControlRight' })
    expect(actions.start).not.toHaveBeenCalled()
  })

  it('treats a modifier-click as a click: no dictation', () => {
    const { gesture, actions } = setup()
    gesture.keyDown(down('ControlRight', { ctrlKey: true }))
    gesture.pointerDown()
    vi.advanceTimersByTime(HOLD_THRESHOLD_MS * 2)
    gesture.keyUp({ code: 'ControlRight' })
    expect(actions.start).not.toHaveBeenCalled()
  })

  it('leaves the other side’s key alone', () => {
    const { gesture, actions } = setup()
    gesture.keyDown(down('ControlLeft', { ctrlKey: true }))
    vi.advanceTimersByTime(HOLD_THRESHOLD_MS * 2)
    gesture.keyUp({ code: 'ControlLeft' })
    expect(actions.start).not.toHaveBeenCalled()
  })

  it('never prevents the default of a lone modifier', () => {
    const { gesture } = setup()
    expect(gesture.keyDown(down('ControlRight', { ctrlKey: true }))).toBe(false)
  })
})

describe('chord', () => {
  const shortcut: VoiceShortcut = { kind: 'chord', modifiers: ['ctrl', 'shift'], code: 'Space' }

  it('claims its press and starts on it', () => {
    const { gesture, actions } = setup(shortcut)
    expect(gesture.keyDown(down('Space', { ctrlKey: true, shiftKey: true }))).toBe(true)
    expect(actions.start).toHaveBeenCalledTimes(1)
  })

  it('a long press is hold-to-talk, ending when any of its keys is released', () => {
    const { gesture, actions } = setup(shortcut)
    gesture.keyDown(down('Space', { ctrlKey: true, shiftKey: true }))
    vi.advanceTimersByTime(HOLD_THRESHOLD_MS)
    gesture.keyUp({ code: 'ShiftLeft' })
    expect(actions.stop).toHaveBeenCalledTimes(1)
    gesture.keyUp({ code: 'Space' })
    expect(actions.stop).toHaveBeenCalledTimes(1)
  })

  it('does not match with an extra modifier held', () => {
    const { gesture, actions } = setup(shortcut)
    expect(gesture.keyDown(down('Space', { ctrlKey: true, shiftKey: true, altKey: true }))).toBe(false)
    expect(actions.start).not.toHaveBeenCalled()
  })
})
