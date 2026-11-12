export type Detent = 'half' | 'full'
export type DetentOutcome = Detent | 'close'

/** Share of available height at half; full leaves a gap at the top so it reads as a sheet. */
export const detentFraction: Record<Detent, number> = { half: 0.62, full: 0.94 }

const DISTANCE = 56
const VELOCITY = 0.9

/**
 * Which detent the sheet rests at after the gesture is released.
 * dy positive downward; vy is the vertical velocity at release (positive downward, px/ms).
 * Fast flings follow the direction, slow drags switch detent only beyond a distance; with one detent (allowFull=false) dragging up has no effect.
 */
export function settleDetent({
  level,
  dy,
  vy,
  allowFull = true,
}: {
  level: Detent
  dy: number
  vy: number
  allowFull?: boolean
}): DetentOutcome {
  const down = dy > DISTANCE || vy > VELOCITY
  const up = dy < -DISTANCE || vy < -VELOCITY
  if (level === 'half') {
    if (down) return 'close'
    if (up && allowFull) return 'full'
    return 'half'
  }
  if (down) return 'half'
  return 'full'
}

/** Convert the detent into pixel height, not exceeding the available height. */
export function detentHeight(level: Detent, available: number): number {
  return Math.round(Math.max(0, available) * detentFraction[level])
}

/** Even at full height stay below the status bar, otherwise the sheet top is covered by it. */
export const SHEET_TOP_GAP = 8

/**
 * Height the sheet can use: the sheet's actual visible height minus the status bar and minimum top margin.
 * When the keyboard is up viewportHeight is already smaller, so the sheet gets shorter with it and never pushes off screen.
 */
export function sheetAvailable(viewportHeight: number, topInset: number): number {
  return Math.max(0, viewportHeight - Math.max(0, topInset) - SHEET_TOP_GAP)
}
