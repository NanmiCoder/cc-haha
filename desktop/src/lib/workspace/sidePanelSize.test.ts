import { describe, expect, it } from 'vitest'
import { clampWorkspaceSideWidth, constrainWorkspaceSideWidth, measureWorkspaceSidePanel, workspaceSideBounds } from './sidePanelSize'

describe('workspace side panel size', () => {
  it('protects chat on narrow rows while allowing wide panes to reach 70%', () => {
    expect(workspaceSideBounds(840)).toEqual({ min: 420, max: 439 })
    expect(workspaceSideBounds(1160)).toEqual({ min: 420, max: 759 })
    expect(workspaceSideBounds(2400)).toEqual({ min: 420, max: 1680 })
    expect(constrainWorkspaceSideWidth(1600, workspaceSideBounds(900))).toBe(499)
    expect(clampWorkspaceSideWidth(1600)).toBe(1600)
    expect(clampWorkspaceSideWidth(Number.NaN)).toBe(860)
    expect(clampWorkspaceSideWidth(0)).toBe(420)
    expect(workspaceSideBounds(0)).toBeNull()
  })

  it.each([1, 1.2])('converts rendered measurements into layout pixels at scale %s', (scale) => {
    const row = document.createElement('div')
    const panel = document.createElement('aside')
    row.appendChild(panel)
    Object.defineProperty(row, 'offsetWidth', { value: 2400 })
    Object.defineProperty(panel, 'offsetWidth', { value: 860 })
    panel.getBoundingClientRect = () => ({ width: 860 * scale } as DOMRect)
    expect(measureWorkspaceSidePanel(panel, 700)).toEqual({
      width: 860, scale, bounds: { min: 420, max: 1680 },
    })
  })
})
