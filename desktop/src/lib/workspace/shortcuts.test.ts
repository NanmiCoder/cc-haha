import { describe, expect, it } from 'vitest'
import {
  formatWorkspaceShortcut,
  matchWorkspaceShortcut,
  type WorkspaceKeyEvent,
} from './shortcuts'

function key(partial: Partial<WorkspaceKeyEvent> & { key: string }): WorkspaceKeyEvent {
  return {
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...partial,
  }
}

describe('matchWorkspaceShortcut', () => {
  it('supports the reference side-panel chord without stealing extra-modifier keys', () => {
    const mac = { platform: 'mac' as const, context: 'chat' as const }
    expect(matchWorkspaceShortcut(key({ key: 'b', metaKey: true, altKey: true }), mac)).toBe('toggle-workspace')
    expect(matchWorkspaceShortcut(key({ key: '∫', code: 'KeyB', metaKey: true, altKey: true }), mac)).toBe('toggle-workspace')
    expect(matchWorkspaceShortcut(key({ key: 'b', metaKey: true, altKey: true, shiftKey: true }), mac)).toBeNull()
    expect(matchWorkspaceShortcut(key({ key: 'j', metaKey: true }), mac)).toBe('toggle-bottom-panel')
  })
  it('maps the documented mac bindings', () => {
    const mac = { platform: 'mac' as const, context: 'chat' as const }
    expect(matchWorkspaceShortcut(key({ key: 'p', metaKey: true }), mac)).toBe('quick-open-file')
    expect(matchWorkspaceShortcut(key({ key: 't', metaKey: true }), mac)).toBe('new-browser-tab')
    expect(matchWorkspaceShortcut(key({ key: '`', ctrlKey: true }), mac)).toBe('toggle-terminal')
    expect(matchWorkspaceShortcut(key({ key: 'b', metaKey: true, shiftKey: true }), mac)).toBe('toggle-workspace')
    expect(matchWorkspaceShortcut(key({ key: 'f', metaKey: true, shiftKey: true }), mac)).toBe('toggle-fullscreen')
    expect(matchWorkspaceShortcut(key({ key: 'g', ctrlKey: true, shiftKey: true }), mac)).toBe('open-review')
  })

  it('uses Ctrl as the primary modifier off mac', () => {
    const other = { platform: 'other' as const, context: 'chat' as const }
    expect(matchWorkspaceShortcut(key({ key: 'p', ctrlKey: true }), other)).toBe('quick-open-file')
    // Cmd is not a modifier there, so a stray metaKey must not fire the action.
    expect(matchWorkspaceShortcut(key({ key: 'p', metaKey: true }), other)).toBeNull()
  })

  it('reads the terminal key from `code` when the layout gives a dead key', () => {
    expect(matchWorkspaceShortcut(
      key({ key: 'Dead', code: 'Backquote', ctrlKey: true }),
      { platform: 'mac', context: 'chat' },
    )).toBe('toggle-terminal')
  })

  it('leaves close and new-terminal to a focused terminal', () => {
    const terminal = { platform: 'mac' as const, context: 'terminal' as const }
    // Ctrl+W is word-erase at a shell; stealing it makes the terminal unusable.
    expect(matchWorkspaceShortcut(key({ key: 'w', metaKey: true }), terminal)).toBeNull()
    expect(matchWorkspaceShortcut(key({ key: '`', ctrlKey: true, shiftKey: true }), terminal)).toBeNull()
    // Navigation keys still work from inside a terminal.
    expect(matchWorkspaceShortcut(key({ key: 'p', metaKey: true }), terminal)).toBe('quick-open-file')
  })

  it('ignores keystrokes that are not ours', () => {
    const mac = { platform: 'mac' as const, context: 'chat' as const }
    expect(matchWorkspaceShortcut(key({ key: 'p' }), mac)).toBeNull()
    expect(matchWorkspaceShortcut(key({ key: 'p', metaKey: true, altKey: true }), mac)).toBeNull()
    expect(matchWorkspaceShortcut(key({ key: 'z', metaKey: true }), mac)).toBeNull()
  })

  it('distinguishes shifted variants that share a key', () => {
    const mac = { platform: 'mac' as const, context: 'chat' as const }
    expect(matchWorkspaceShortcut(key({ key: 't', metaKey: true }), mac)).toBe('new-browser-tab')
    expect(matchWorkspaceShortcut(key({ key: 't', metaKey: true, shiftKey: true }), mac)).toBe('reopen-closed-tab')
    expect(matchWorkspaceShortcut(key({ key: '`', ctrlKey: true }), mac)).toBe('toggle-terminal')
    expect(matchWorkspaceShortcut(key({ key: '`', ctrlKey: true, shiftKey: true }), mac)).toBe('new-terminal')
  })
})

describe('formatWorkspaceShortcut', () => {
  it('uses platform glyphs', () => {
    expect(formatWorkspaceShortcut('quick-open-file', 'mac')).toBe('⌘P')
    expect(formatWorkspaceShortcut('quick-open-file', 'other')).toBe('Ctrl+P')
    expect(formatWorkspaceShortcut('open-review', 'mac')).toBe('⌃⇧G')
    expect(formatWorkspaceShortcut('toggle-bottom-panel', 'mac')).toBe('⌘J')
    expect(formatWorkspaceShortcut('toggle-terminal', 'mac')).toBe('⌃`')
    expect(formatWorkspaceShortcut('toggle-workspace', 'mac')).toBe('⌥⌘B')
  })

  it('returns nothing for actions with no advertised binding', () => {
    expect(formatWorkspaceShortcut('next-tab', 'mac')).toBeNull()
  })
})
