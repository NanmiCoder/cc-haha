export type KeyboardViewportFrame = { screenY: number; height: number }

/** Only avoid the overlap left after any native window resize, in screen coordinates. */
export function keyboardOverlap(
  viewport: KeyboardViewportFrame,
  keyboardTop: number | null,
): number {
  if (keyboardTop === null) return 0
  return Math.min(viewport.height, Math.max(0, viewport.screenY + viewport.height - keyboardTop))
}

/** Native iOS modal layout is window-relative, but keyboard frames are screen-relative. */
export function bottomAlignedKeyboardOffset(
  windowHeight: number,
  frame: { y: number; height: number },
): number {
  return Math.max(0, windowHeight - frame.y - frame.height)
}
