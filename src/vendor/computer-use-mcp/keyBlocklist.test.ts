import { expect, test } from 'bun:test'
import { isSystemKeyCombo, normalizeKeySequence } from './keyBlocklist.js'

test('native left and right modifier aliases pass through the same shortcut grant gate', () => {
  for (const command of ['Super_L', 'Super_R', 'Meta_L', 'Meta_R']) {
    expect(isSystemKeyCombo(`${command}+q`, 'darwin')).toBe(true)
    expect(isSystemKeyCombo(`Control_R+${command}+q`, 'darwin')).toBe(true)
    expect(isSystemKeyCombo(`Shift_L+${command}+Tab`, 'darwin')).toBe(true)
    expect(isSystemKeyCombo(`${command}+Alt_R+Escape`, 'darwin')).toBe(true)
    expect(isSystemKeyCombo(`${command}+c`, 'darwin')).toBe(false)
  }
  expect(normalizeKeySequence('Control_L+Alt_L+Shift_R+Meta_R+a')).toBe('ctrl+alt+shift+meta+a')
})
