import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, spyOn, test } from 'bun:test'

describe('isMaxTokensCapEnabled resolution chain', () => {
  let isMaxTokensCapEnabled: typeof import('./claude.js').isMaxTokensCapEnabled
  let growthbook: typeof import('../analytics/growthbook.js')
  let settings: typeof import('../../utils/settings/settings.js')
  let growthbookGate: ReturnType<typeof spyOn>
  let settingsSpy: ReturnType<typeof spyOn>

  beforeAll(async () => {
    growthbook = await import('../analytics/growthbook.js')
    settings = await import('../../utils/settings/settings.js')
    const claude = await import('./claude.js')
    isMaxTokensCapEnabled = claude.isMaxTokensCapEnabled
  }, 120_000)

  beforeEach(() => {
    growthbookGate = spyOn(growthbook, 'getFeatureValue_CACHED_MAY_BE_STALE').mockReturnValue(false)
    settingsSpy = spyOn(settings, 'getSettings_DEPRECATED').mockReturnValue({})
  })

  afterEach(() => {
    growthbookGate.mockRestore()
    settingsSpy.mockRestore()
  })

  test('settings enabled overrides GrowthBook off', () => {
    settingsSpy.mockReturnValue({ maxOutputTokensEscalationMode: 'enabled' })
    growthbookGate.mockReturnValue(false)
    expect(isMaxTokensCapEnabled()).toBe(true)
    expect(growthbookGate).not.toHaveBeenCalled()
  })

  test('settings disabled overrides GrowthBook on', () => {
    settingsSpy.mockReturnValue({ maxOutputTokensEscalationMode: 'disabled' })
    growthbookGate.mockReturnValue(true)
    expect(isMaxTokensCapEnabled()).toBe(false)
    expect(growthbookGate).not.toHaveBeenCalled()
  })

  test('settings auto falls through to GrowthBook', () => {
    settingsSpy.mockReturnValue({ maxOutputTokensEscalationMode: 'auto' })
    growthbookGate.mockReturnValue(true)
    expect(isMaxTokensCapEnabled()).toBe(true)
    expect(growthbookGate).toHaveBeenCalledWith('tengu_otk_slot_v1', false)

    growthbookGate.mockReturnValue(false)
    expect(isMaxTokensCapEnabled()).toBe(false)
  })

  test('missing setting falls through to GrowthBook', () => {
    growthbookGate.mockReturnValue(true)
    expect(isMaxTokensCapEnabled()).toBe(true)
    expect(growthbookGate).toHaveBeenCalledWith('tengu_otk_slot_v1', false)
  })

  test('GrowthBook default is false when unset', () => {
    expect(isMaxTokensCapEnabled()).toBe(false)
  })
})
