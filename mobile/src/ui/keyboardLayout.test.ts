import { describe, expect, test } from 'bun:test'
import {
  IOS_KEYBOARD_EVENTS,
  iosKeyboardInset,
  keyboardOverlap,
  type IosKeyboardEventName,
  type IosKeyboardFrameEvent,
} from './keyboardLayout'

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

type Step = [IosKeyboardEventName, IosKeyboardFrameEvent]

// iPhone 16 Pro: 874pt window. WeChat input method keyboard is 371pt tall.
const WINDOW = 874
const frame = (height: number, isEventFromThisApp = true): IosKeyboardFrameEvent => ({
  endCoordinates: { screenY: WINDOW - height, height },
  isEventFromThisApp,
})

/** Same fold as IosKeyboardViewport: only subscribed events, null keeps the inset. */
function replay(steps: Step[]): number {
  return steps.reduce((inset, [name, event]) => {
    if (!(IOS_KEYBOARD_EVENTS as readonly string[]).includes(name)) return inset
    return iosKeyboardInset(name, event, WINDOW) ?? inset
  }, 0)
}

describe('iOS keyboard inset', () => {
  test('settles on the keyboard frame after an input method returns from its dictation app', () => {
    // Back from the dictation app the keyboard first reappears at a transitional
    // height, then shrinks without another WillShow.
    expect(replay([
      ['keyboardWillShow', frame(371)],
      ['keyboardWillShow', frame(602)],
      ['keyboardWillChangeFrame', frame(371)],
      ['keyboardDidChangeFrame', frame(371)],
    ])).toBe(371)
    expect(replay([
      ['keyboardWillShow', frame(371)],
      ['keyboardWillShow', frame(737)],
      ['keyboardDidShow', frame(371)],
    ])).toBe(371)
  })

  test("ignores another app's keyboard reported while switching apps", () => {
    expect(replay([
      ['keyboardWillShow', frame(371)],
      ['keyboardWillShow', frame(602, false)],
      ['keyboardDidChangeFrame', frame(291, false)],
    ])).toBe(371)
  })

  test('hides to zero even when the hide comes from the switch', () => {
    expect(replay([['keyboardWillShow', frame(371)], ['keyboardWillHide', frame(371, false)]])).toBe(0)
    expect(replay([['keyboardDidShow', frame(371)], ['keyboardDidHide', frame(0)]])).toBe(0)
  })

  test('does not depend on the viewport frame inside a native page sheet', () => {
    // iPhone 17 Pro simulator: native sheet 812pt, keyboard top 538pt.
    expect(iosKeyboardInset('keyboardWillShow', frame(336), WINDOW)).toBe(336)
  })

  test('uses the keyboard height when cross-fade transitions report screenY 0', () => {
    expect(iosKeyboardInset('keyboardWillShow', { endCoordinates: { screenY: 0, height: 336 } }, WINDOW)).toBe(336)
  })

  test('counts only the visible part of a keyboard sliding off screen', () => {
    expect(iosKeyboardInset('keyboardWillChangeFrame', { endCoordinates: { screenY: 774, height: 336 } }, WINDOW)).toBe(100)
    expect(iosKeyboardInset('keyboardWillChangeFrame', { endCoordinates: { screenY: WINDOW, height: 336 } }, WINDOW)).toBe(0)
  })
})
