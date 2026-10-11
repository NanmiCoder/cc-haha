import { describe, expect, it } from 'vitest'
import {
  chordFromKeyEvent,
  classifyVoiceShortcut,
  defaultVoiceShortcut,
  matchesChord,
  parseVoiceShortcut,
  shortcutKeyLabels,
  type ShortcutModifier,
  type ShortcutPlatform,
  type ShortcutVerdict,
  type VoiceShortcut,
} from './shortcut'

const chord = (modifiers: ShortcutModifier[], code: string): VoiceShortcut => ({ kind: 'chord', modifiers, code })
const PLATFORMS: ShortcutPlatform[] = ['mac', 'windows', 'linux']

describe('defaults', () => {
  it('uses right Option on the Mac and right Ctrl elsewhere, never right Alt (AltGr)', () => {
    expect(defaultVoiceShortcut('mac')).toEqual({ kind: 'modifier', code: 'AltRight' })
    expect(defaultVoiceShortcut('windows')).toEqual({ kind: 'modifier', code: 'ControlRight' })
    expect(defaultVoiceShortcut('linux')).toEqual({ kind: 'modifier', code: 'ControlRight' })
  })

  it.each(PLATFORMS)('has no known conflict on %s', (platform) => {
    expect(classifyVoiceShortcut(defaultVoiceShortcut(platform), platform)).toEqual({ level: 'ok' })
  })

  it('returns the same object every time, so store selectors stay stable', () => {
    expect(defaultVoiceShortcut('mac')).toBe(defaultVoiceShortcut('mac'))
  })
})

describe('classifyVoiceShortcut', () => {
  it.each<[string, VoiceShortcut, ShortcutPlatform, ShortcutVerdict]>([
    // cc-haha's own keys, including the ones only the workspace and zoom matchers know.
    ['⌘K global search', chord(['meta'], 'KeyK'), 'mac', { level: 'blocked', reason: 'app' }],
    ['Ctrl+K global search', chord(['ctrl'], 'KeyK'), 'windows', { level: 'blocked', reason: 'app' }],
    ['⌘P quick open (workspace matcher)', chord(['meta'], 'KeyP'), 'mac', { level: 'blocked', reason: 'app' }],
    ['⌥⌘B workspace (workspace matcher)', chord(['alt', 'meta'], 'KeyB'), 'mac', { level: 'blocked', reason: 'app' }],
    ['Ctrl+` terminal', chord(['ctrl'], 'Backquote'), 'linux', { level: 'blocked', reason: 'app' }],
    ['⌘= zoom (zoom matcher)', chord(['meta'], 'Equal'), 'mac', { level: 'blocked', reason: 'app' }],
    ['F11 full screen', chord([], 'F11'), 'windows', { level: 'blocked', reason: 'app' }],
    // The system's.
    ['⌘Space Spotlight', chord(['meta'], 'Space'), 'mac', { level: 'blocked', reason: 'system' }],
    ['⌃⌘Space emoji', chord(['ctrl', 'meta'], 'Space'), 'mac', { level: 'blocked', reason: 'system' }],
    ['Win+H voice typing', chord(['meta'], 'KeyH'), 'windows', { level: 'blocked', reason: 'system' }],
    ['Alt+Space window menu', chord(['alt'], 'Space'), 'windows', { level: 'blocked', reason: 'system' }],
    ['Super+Space input source', chord(['meta'], 'Space'), 'linux', { level: 'blocked', reason: 'system' }],
    ['Ctrl+Alt+T terminal', chord(['ctrl', 'alt'], 'KeyT'), 'linux', { level: 'blocked', reason: 'system' }],
    ['Win alone', { kind: 'modifier', code: 'MetaLeft' }, 'windows', { level: 'blocked', reason: 'system' }],
    // Typing and editing.
    ['a bare letter', chord([], 'KeyA'), 'mac', { level: 'blocked', reason: 'typing' }],
    ['a bare Space', chord([], 'Space'), 'windows', { level: 'blocked', reason: 'typing' }],
    ['Shift+letter', chord(['shift'], 'KeyA'), 'linux', { level: 'blocked', reason: 'typing' }],
    ['⌥E (dead key)', chord(['alt'], 'KeyE'), 'mac', { level: 'blocked', reason: 'typing' }],
    ['Esc', chord([], 'Escape'), 'mac', { level: 'blocked', reason: 'typing' }],
    ['⌘Enter', chord(['meta'], 'Enter'), 'mac', { level: 'blocked', reason: 'editing' }],
    ['⌘C copy', chord(['meta'], 'KeyC'), 'mac', { level: 'blocked', reason: 'editing' }],
    ['Ctrl+Shift+Z redo', chord(['ctrl', 'shift'], 'KeyZ'), 'windows', { level: 'blocked', reason: 'editing' }],
    ['⌃A line start', chord(['ctrl'], 'KeyA'), 'mac', { level: 'blocked', reason: 'editing' }],
    ['Caps Lock', chord([], 'CapsLock'), 'mac', { level: 'blocked', reason: 'unsupported' }],
    // Allowed, with a warning.
    ['⌃Space input source', chord(['ctrl'], 'Space'), 'mac', { level: 'warning', reason: 'inputMethod' }],
    ['Ctrl+Space IME toggle', chord(['ctrl'], 'Space'), 'windows', { level: 'warning', reason: 'inputMethod' }],
    ['⌥Space launchers', chord(['alt'], 'Space'), 'mac', { level: 'warning', reason: 'launcher' }],
    ['right Alt (AltGr)', { kind: 'modifier', code: 'AltRight' }, 'windows', { level: 'warning', reason: 'altGr' }],
    ['right Alt (AltGr)', { kind: 'modifier', code: 'AltRight' }, 'linux', { level: 'warning', reason: 'altGr' }],
    ['Ctrl+Alt+letter (AltGr)', chord(['ctrl', 'alt'], 'KeyV'), 'windows', { level: 'warning', reason: 'altGr' }],
    ['Shift alone', { kind: 'modifier', code: 'ShiftLeft' }, 'mac', { level: 'warning', reason: 'inputMethod' }],
    ['left Alt alone', { kind: 'modifier', code: 'AltLeft' }, 'windows', { level: 'warning', reason: 'menuBar' }],
    ['Super+letter', chord(['meta'], 'KeyV'), 'linux', { level: 'warning', reason: 'desktopShortcut' }],
    // Free.
    ['⇧⌘Space', chord(['shift', 'meta'], 'Space'), 'mac', { level: 'ok' }],
    ['Ctrl+Shift+Space', chord(['ctrl', 'shift'], 'Space'), 'windows', { level: 'ok' }],
    ['F13', chord([], 'F13'), 'mac', { level: 'ok' }],
    ['right ⌘ alone', { kind: 'modifier', code: 'MetaRight' }, 'mac', { level: 'ok' }],
    ['left Ctrl alone', { kind: 'modifier', code: 'ControlLeft' }, 'linux', { level: 'ok' }],
  ])('%s on %s', (_name, shortcut, platform, verdict) => {
    expect(classifyVoiceShortcut(shortcut, platform)).toEqual(verdict)
  })
})

describe('key events', () => {
  it('reads a chord from a press, by physical key', () => {
    expect(chordFromKeyEvent({ code: 'Space', ctrlKey: true, altKey: false, shiftKey: true, metaKey: false }))
      .toEqual(chord(['ctrl', 'shift'], 'Space'))
    expect(chordFromKeyEvent({ code: 'ShiftLeft', ctrlKey: false, altKey: false, shiftKey: true, metaKey: false })).toBeNull()
  })

  it('matches the exact modifier set only', () => {
    const shortcut = chord(['shift', 'meta'], 'Space')
    const event = { code: 'Space', ctrlKey: false, altKey: false, shiftKey: true, metaKey: true }
    expect(matchesChord(shortcut, event)).toBe(true)
    expect(matchesChord(shortcut, { ...event, altKey: true })).toBe(false)
    expect(matchesChord(shortcut, { ...event, shiftKey: false })).toBe(false)
  })
})

describe('labels', () => {
  it('uses each platform’s own names and order', () => {
    expect(shortcutKeyLabels(chord(['shift', 'meta'], 'Space'), 'mac')).toEqual([{ text: '⇧' }, { text: '⌘' }, { text: 'Space' }])
    expect(shortcutKeyLabels(chord(['ctrl', 'meta'], 'KeyD'), 'windows')).toEqual([{ text: 'Ctrl' }, { text: 'Win' }, { text: 'D' }])
    expect(shortcutKeyLabels(chord(['meta'], 'Digit1'), 'linux')).toEqual([{ text: 'Super' }, { text: '1' }])
    expect(shortcutKeyLabels({ kind: 'modifier', code: 'AltRight' }, 'mac')).toEqual([{ text: '⌥', side: 'right' }])
    expect(shortcutKeyLabels({ kind: 'modifier', code: 'ControlRight' }, 'windows')).toEqual([{ text: 'Ctrl', side: 'right' }])
  })
})

describe('parseVoiceShortcut', () => {
  it('keeps well-formed values and orders modifiers', () => {
    expect(parseVoiceShortcut({ kind: 'modifier', code: 'AltRight' })).toEqual({ kind: 'modifier', code: 'AltRight' })
    expect(parseVoiceShortcut({ kind: 'chord', modifiers: ['meta', 'shift'], code: 'Space' })).toEqual(chord(['shift', 'meta'], 'Space'))
  })

  it.each([
    null,
    'AltRight',
    { kind: 'modifier', code: 'KeyA' },
    { kind: 'modifier', code: 'CapsLock' },
    { kind: 'chord', modifiers: ['hyper'], code: 'Space' },
    { kind: 'chord', modifiers: 'meta', code: 'Space' },
    { kind: 'chord', modifiers: [], code: 'ShiftLeft' },
    { kind: 'chord', modifiers: [] },
    { kind: 'gesture', code: 'AltRight' },
  ])('rejects %j', (value) => {
    expect(parseVoiceShortcut(value)).toBeNull()
  })
})
