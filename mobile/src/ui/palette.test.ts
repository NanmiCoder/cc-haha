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

const { dark, darkShadows, light, lightShadows, radius, shadowsFor } = await import(
  './palette'
)

function expectPureNeutralHex(hex: string) {
  expect(hex).toMatch(/^#[0-9A-Fa-f]{6}$/)
  const r = hex.slice(1, 3).toUpperCase()
  const g = hex.slice(3, 5).toUpperCase()
  const b = hex.slice(5, 7).toUpperCase()
  expect(r).toBe(g)
  expect(g).toBe(b)
}

describe('Codex Pure Neutral V6C unified palette (H5 / iOS / Android)', () => {
  test('light palette matches canonical V6C Pure Neutral Light tokens', () => {
    expect(light.bg).toBe('#FFFFFF')
    expect(light.card).toBe('#FAFAFA')
    expect(light.cardRaised).toBe('#FFFFFF')
    expect(light.fill).toBe('#EFEFEF')
    expect(light.bubble).toBe('#F4F4F4')
    expect(light.sheet).toBe('#F6F6F6')
    expect(light.code).toBe('#F3F3F3')
    expect(light.ink).toBe('#1A1C1F')
    expect(light.ink2).toBe('#4E4E4E')
    expect(light.ink3).toBe('#666666')
    expect(light.faint).toBe('#9A9A9A')
    expect(light.chevron).toBe('#B0B0B0')
    expect(light.hair).toBe('#E8E8E8')
    expect(light.borderStrong).toBe('#D4D4D4')
    expect(light.brand).toBe('#0169CC')
    expect(light.brandPressed).toBe('#0055A6')
    expect(light.brandSoft).toBe('#EBF5FF')
    expect(light.brandBorder).toBe('#B3D7FF')
    expect(light.brandInk).toBe('#0157AD')
    expect(light.onBrand).toBe('#FFFFFF')
    expect(light.ok).toBe('#008A36')
    expect(light.okSoft).toBe('#EBF7F0')
    expect(light.okInk).toBe('#00692A')
    expect(light.attn).toBe('#B8470B')
    expect(light.attnDot).toBe('#B8470B')
    expect(light.attnSoft).toBe('#FDF2EB')
    expect(light.attnInk).toBe('#923B0F')
    expect(light.err).toBe('#BA2623')
    expect(light.errSoft).toBe('#FDF0F0')
    expect(light.errInk).toBe('#911E1B')
    expect(light.onErr).toBe('#FFFFFF')
    expect(light.run).toBe('#0169CC')
    expect(light.runSoft).toBe('#D9ECFF')
    expect(light.runTint).toBe('#EBF5FF')
    expect(light.sel).toBe('#EBF5FF')
    expect(light.btn).toBe('#1A1C1F')
    expect(light.btnInk).toBe('#FFFFFF')
    expect(light.glass).toBe('rgba(255,255,255,0.98)')
    expect(light.glassBorder).toBe('rgba(0,0,0,0.08)')
    expect(light.ringRunning).toBe('rgba(1,105,204,0.34)')
    expect(light.ringWaiting).toBe('rgba(184,71,11,0.36)')
    expect(light.kw).toBe('#0157AD')
    expect(light.str).toBe('#00692A')
    expect(light.ty).toBe('#6819C4')
    expect(light.cm).toBe('#666666')
  })

  test('dark palette matches canonical V6C Pure Neutral Dark tokens', () => {
    expect(dark.bg).toBe('#181818')
    expect(dark.card).toBe('#212121')
    expect(dark.cardRaised).toBe('#282828')
    expect(dark.fill).toBe('#282828')
    expect(dark.bubble).toBe('#242424')
    expect(dark.sheet).toBe('#131313')
    expect(dark.code).toBe('#222222')
    expect(dark.ink).toBe('#DFDFDF')
    expect(dark.ink2).toBe('#B4B4B4')
    expect(dark.ink3).toBe('#969696')
    expect(dark.faint).toBe('#6E6E6E')
    expect(dark.chevron).toBe('#666666')
    expect(dark.hair).toBe('#2B2B2B')
    expect(dark.borderStrong).toBe('#3D3D3D')
    expect(dark.brand).toBe('#339CFF')
    expect(dark.brandPressed).toBe('#66B5FF')
    expect(dark.brandSoft).toBe('#16273A')
    expect(dark.brandBorder).toBe('#2B4E73')
    expect(dark.brandInk).toBe('#83C3FF')
    expect(dark.onBrand).toBe('#141414')
    expect(dark.ok).toBe('#40C977')
    expect(dark.okSoft).toBe('#16291E')
    expect(dark.okInk).toBe('#5DD68D')
    expect(dark.attn).toBe('#FF8549')
    expect(dark.attnDot).toBe('#FF8549')
    expect(dark.attnSoft).toBe('#2E1F16')
    expect(dark.attnInk).toBe('#FFA06E')
    expect(dark.err).toBe('#FA423E')
    expect(dark.errSoft).toBe('#2F1919')
    expect(dark.errInk).toBe('#FF807D')
    expect(dark.onErr).toBe('#141414')
    expect(dark.run).toBe('#66B5FF')
    expect(dark.runSoft).toBe('#1E344D')
    expect(dark.runTint).toBe('#16273A')
    expect(dark.sel).toBe('#16273A')
    expect(dark.btn).toBe('#FFFFFF')
    expect(dark.btnInk).toBe('#141414')
    expect(dark.glass).toBe('rgba(33,33,33,0.98)')
    expect(dark.glassBorder).toBe('rgba(255,255,255,0.09)')
    expect(dark.ringRunning).toBe('rgba(102,181,255,0.36)')
    expect(dark.ringWaiting).toBe('rgba(255,133,73,0.38)')
    expect(dark.kw).toBe('#66B5FF')
    expect(dark.str).toBe('#5DD68D')
    expect(dark.ty).toBe('#C18CFF')
    expect(dark.cm).toBe('#969696')
  })

  test('neutral gray surfaces, borders, and secondary inks have strictly equal RGB channels', () => {
    for (const hex of [
      light.bg,
      light.card,
      light.cardRaised,
      light.fill,
      light.bubble,
      light.sheet,
      light.code,
      light.ink2,
      light.ink3,
      light.faint,
      light.chevron,
      light.hair,
      light.borderStrong,
      light.hunk,
      light.switchOff,
      light.cm,
    ]) {
      expectPureNeutralHex(hex)
    }
    for (const hex of [
      dark.bg,
      dark.card,
      dark.cardRaised,
      dark.fill,
      dark.bubble,
      dark.sheet,
      dark.code,
      dark.ink,
      dark.ink2,
      dark.ink3,
      dark.faint,
      dark.chevron,
      dark.hair,
      dark.borderStrong,
      dark.hunk,
      dark.switchOff,
      dark.btn,
      dark.btnInk,
      dark.onBrand,
      dark.onErr,
      dark.cm,
    ]) {
      expectPureNeutralHex(hex)
    }
  })

  test('radius scale matches V6C contract', () => {
    expect(radius).toEqual({
      xs: 4,
      sm: 6,
      md: 8,
      control: 10,
      key: 11,
      inner: 12,
      button: 12,
      card: 14,
      group: 14,
      composer: 18,
      sheet: 20,
      full: 9999,
    })
  })

  test('shadowsFor returns pure neutral shadows with zero legacy warm brown channels', () => {
    expect(shadowsFor('light')).toBe(lightShadows)
    expect(shadowsFor('dark')).toBe(darkShadows)
    const keys = [
      'card',
      'floating',
      'composer',
      'menu',
      'popover',
      'segment',
      'sheetUp',
      'toast',
      'thumb',
      'capsule',
      'capsuleWaiting',
    ] as const
    for (const scheme of ['light', 'dark'] as const) {
      const set = shadowsFor(scheme)
      for (const key of keys) {
        const value = set[key]
        expect(typeof value).toBe('string')
        expect(value.length).toBeGreaterThan(0)
        expect(value).not.toMatch(/rgba\(\s*28\s*,\s*25\s*,\s*23/)
        expect(value).not.toMatch(/rgba\(\s*20\s*,\s*19\s*,\s*17/)
      }
    }
    for (const key of keys) {
      if (key === 'capsuleWaiting') continue
      expect(darkShadows[key]).toContain('rgba(255,255,255,')
    }
  })

  test('mobile icon registry contains no AI-cliche sparkle icons', () => {
    const iconsSource = readFileSync(join(import.meta.dir, 'icons.tsx'), 'utf8')
    expect(iconsSource).not.toMatch(/\bsparkle\b/i)
  })
})
