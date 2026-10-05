import { describe, expect, it } from 'vitest'

import { TAB_CHIP_ACTIVE, TAB_CHIP_IDLE, tabChipClass, tabChipLabelClass } from './tabChip'

describe('tab chip', () => {
  it('lifts the active tab with the full edge ring and a shadow', () => {
    expect(TAB_CHIP_ACTIVE).toContain('bg-[var(--color-surface)]')
    expect(TAB_CHIP_ACTIVE).toContain('0_0_0_1px_var(--color-tab-edge)')
    expect(TAB_CHIP_ACTIVE).toContain('var(--shadow-raised)')
  })

  it('keeps hover strictly weaker than selection on every theme', () => {
    // Hover shares paper with the active tab and only the faint ring; it never
    // uses surface-hover, which is brighter than paper on the ink themes.
    expect(TAB_CHIP_IDLE).toContain('hover:bg-[var(--color-surface)]')
    expect(TAB_CHIP_IDLE).toContain('hover:shadow-[0_0_0_1px_var(--color-tab-separator)]')
    expect(TAB_CHIP_IDLE).not.toContain('surface-hover')
    expect(TAB_CHIP_IDLE).not.toContain('--color-tab-edge')
    expect(TAB_CHIP_IDLE).not.toMatch(/(?:^|\s)bg-/)
  })

  it('draws rings as shadows so changing tier never moves the label', () => {
    expect(tabChipClass(true)).not.toMatch(/(?:^|\s)border(?:-|\s|$)/)
    expect(tabChipClass(false)).not.toMatch(/(?:^|\s)border(?:-|\s|$)/)
    expect(tabChipClass(true)).toContain('h-7')
    expect(tabChipClass(false)).toContain('h-7')
  })

  it('gives only the active title the medium weight', () => {
    expect(tabChipLabelClass(true)).toContain('font-medium')
    expect(tabChipLabelClass(false)).not.toContain('font-medium')
  })
})
