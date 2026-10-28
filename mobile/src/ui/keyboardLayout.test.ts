import { describe, expect, test } from 'bun:test'
import { bottomAlignedKeyboardOffset, keyboardOverlap } from './keyboardLayout'

describe('keyboard viewport', () => {
  test('moves the composer and sheet footer above an overlay keyboard', () => {
    const viewport = { screenY: 80, height: 760 }
    const keyboardTop = 520
    const inset = keyboardOverlap(viewport, keyboardTop)
    expect(inset).toBe(320)
    expect(viewport.screenY + viewport.height - inset).toBe(keyboardTop)
  })

  test('does not subtract the keyboard twice when Android already resized the window', () => {
    expect(keyboardOverlap({ screenY: 80, height: 440 }, 520)).toBe(0)
    expect(keyboardOverlap({ screenY: 80, height: 430 }, 520)).toBe(0)
  })

  test('recomputes when the keyboard changes height and restores the full viewport on hide', () => {
    const viewport = { screenY: 24, height: 816 }
    expect([620, 480, null].map((top) => keyboardOverlap(viewport, top))).toEqual([220, 360, 0])
  })

  test('uses the screen position of a nested viewport, not its parent-relative y', () => {
    expect(keyboardOverlap({ screenY: 136, height: 704 }, 520)).toBe(320)
    expect(keyboardOverlap({ screenY: 0, height: 840 }, 520)).toBe(320)
  })

  test('never produces negative content height while the keyboard covers a small viewport', () => {
    expect(keyboardOverlap({ screenY: 600, height: 200 }, 520)).toBe(200)
  })
})

describe('iOS bottom-aligned modal keyboard coordinates', () => {
  test('keeps the new-task footer above the keyboard inside the measured native page sheet', () => {
    // iPhone 17 Pro simulator: native sheet 812pt, screen 874pt, keyboard top 538pt.
    const frame = { y: 0, height: 812 }
    const offset = bottomAlignedKeyboardOffset(874, frame)
    const avoided = keyboardOverlap({ screenY: frame.y, height: frame.height }, 538 - offset)
    expect(avoided).toBe(336)
    expect(62 + frame.height - avoided).toBe(538)
  })

  test('accounts for a nested header without adding its height twice', () => {
    expect(bottomAlignedKeyboardOffset(874, { y: 56, height: 756 })).toBe(62)
  })

  test('leaves a full-screen sheet at zero and never returns a negative offset', () => {
    expect(bottomAlignedKeyboardOffset(874, { y: 0, height: 874 })).toBe(0)
    expect(bottomAlignedKeyboardOffset(874, { y: 56, height: 818 })).toBe(0)
    expect(bottomAlignedKeyboardOffset(874, { y: 0, height: 900 })).toBe(0)
  })
})
