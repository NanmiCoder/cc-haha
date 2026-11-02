export type KeyboardViewportFrame = { screenY: number; height: number }

/** Only avoid the overlap left after any native window resize, in screen coordinates. */
export function keyboardOverlap(
  viewport: KeyboardViewportFrame,
  keyboardTop: number | null,
): number {
  if (keyboardTop === null) return 0
  return Math.min(viewport.height, Math.max(0, viewport.screenY + viewport.height - keyboardTop))
}

/**
 * Third-party keyboards resize without another WillShow, and switching apps (an input
 * method opening its own app for dictation) can deliver a transitional frame first.
 * Follow every event so the latest frame wins and the Did events settle it.
 */
export const IOS_KEYBOARD_EVENTS = [
  'keyboardWillShow',
  'keyboardWillChangeFrame',
  'keyboardWillHide',
  'keyboardDidShow',
  'keyboardDidChangeFrame',
  'keyboardDidHide',
] as const

export type IosKeyboardEventName = (typeof IOS_KEYBOARD_EVENTS)[number]

export type IosKeyboardFrameEvent = {
  endCoordinates: { screenY: number; height: number }
  isEventFromThisApp?: boolean
}

/**
 * Bottom inset for a viewport that reaches the bottom of the window, as every caller
 * does (native iOS page sheets included): the part of the keyboard inside the window.
 * `null` means the event must not move the viewport.
 */
export function iosKeyboardInset(
  name: IosKeyboardEventName,
  event: IosKeyboardFrameEvent,
  windowHeight: number,
): number | null {
  if (name === 'keyboardWillHide' || name === 'keyboardDidHide') return 0
  // iOS also reports another app's keyboard while this app switches out and back.
  if (event.isEventFromThisApp === false) return null
  const { screenY, height } = event.endCoordinates
  // Bounded by the keyboard's own height: with Prefer Cross-Fade Transitions iOS
  // reports screenY 0 for a docked keyboard.
  return Math.max(0, Math.min(height, windowHeight - screenY))
}
