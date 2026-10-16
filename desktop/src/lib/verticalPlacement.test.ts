import { describe, expect, it } from 'vitest'
import { resolveVerticalPlacement } from './verticalPlacement'

const options = { viewportHeight: 620, preferredHeight: 380, gap: 6, margin: 12 }

describe('resolveVerticalPlacement', () => {
  it('opens downward and caps at the room below when the preferred height fits', () => {
    const placement = resolveVerticalPlacement({ top: 100, bottom: 130 }, options)

    expect(placement).toEqual({ direction: 'down', edge: 136, maxHeight: 472 })
  })

  it('opens upward when the room below is too short and the room above is larger', () => {
    const placement = resolveVerticalPlacement({ top: 500, bottom: 530 }, options)

    expect(placement).toEqual({ direction: 'up', edge: 494, maxHeight: 482 })
  })

  it('caps the height at the room below when neither side fits the preferred height', () => {
    // More room below than above, but less than the menu wants. Without a cap
    // it ran off the bottom of a short window.
    const placement = resolveVerticalPlacement({ top: 260, bottom: 290 }, options)

    expect(placement.direction).toBe('down')
    expect(placement.maxHeight).toBe(620 - 290 - 6 - 12)
    expect(placement.edge + placement.maxHeight).toBeLessThanOrEqual(620 - 12)
  })

  it('never goes below the floor in a window too short to leave any room', () => {
    const placement = resolveVerticalPlacement(
      { top: 40, bottom: 70 },
      { ...options, viewportHeight: 100, minHeight: 160 },
    )

    expect(placement.maxHeight).toBe(160)
  })
})
