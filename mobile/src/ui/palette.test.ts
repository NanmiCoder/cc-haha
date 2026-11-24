import { describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

mock.module('react-native', () => ({
  Platform: {
    OS: 'ios',
    select: <T,>(values: { ios?: T; android?: T; default?: T }) =>
      values.ios ?? values.default,
  },
}))

const { dark, light } = await import('./palette')

describe('Direction C unified palette (H5 / iOS / Android)', () => {
  test('light palette matches canonical Warm Editorial Studio pure-white tokens', () => {
    expect(light.bg).toBe('#FFFFFF')
    expect(light.sheet).toBe('#F7F6F3')
    expect(light.fill).toBe('#EEECE7')
    expect(light.card).toBe('#FAF9F7')
    expect(light.hair).toBe('#E8E5DF')
    expect(light.borderStrong).toBe('#D6D1C7')
    expect(light.ink).toBe('#1A1918')
    expect(light.ink2).toBe('#57534E')
    expect(light.ink3).toBe('#6E6962')
    expect(light.brand).toBe('#C25934')
    expect(light.brandPressed).toBe('#A94A28')
    expect(light.brandSoft).toBe('#FAF0EC')
    expect(light.brandBorder).toBe('#EAC9BC')
    expect(light.onBrand).toBe('#FFFFFF')
    expect(light.ok).toBe('#2D7A4D')
    expect(light.attn).toBe('#B06A14')
    expect(light.err).toBe('#C43232')
  })

  test('dark palette matches canonical Warm Editorial Studio matte-charcoal tokens', () => {
    expect(dark.bg).toBe('#1B1A18')
    expect(dark.sheet).toBe('#141413')
    expect(dark.fill).toBe('#272522')
    expect(dark.card).toBe('#22211F')
    expect(dark.hair).toBe('#2E2C29')
    expect(dark.borderStrong).toBe('#413E39')
    expect(dark.ink).toBe('#EDEAE4')
    expect(dark.ink2).toBe('#B5AFA5')
    expect(dark.ink3).toBe('#969087')
    expect(dark.brand).toBe('#E07A52')
    expect(dark.brandPressed).toBe('#EB8C67')
    expect(dark.brandSoft).toBe('#31231C')
    expect(dark.brandBorder).toBe('#55392C')
    expect(dark.onBrand).toBe('#181614')
    expect(dark.ok).toBe('#6AC18C')
    expect(dark.attn).toBe('#E2B055')
    expect(dark.err).toBe('#EA736A')
  })

  test('mobile icon registry contains no AI-cliche sparkle icons', () => {
    const iconsSource = readFileSync(join(import.meta.dir, 'icons.tsx'), 'utf8')
    expect(iconsSource).not.toMatch(/\bsparkle\b/i)
  })
})
