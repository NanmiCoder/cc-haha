import { beforeAll, beforeEach, afterEach, describe, expect, spyOn, test } from 'bun:test'

describe('isMaxTokensCapEnabled resolution chain', () => {
  let isMaxTokensCapEnabled: typeof import('./claude.js').isMaxTokensCapEnabled
  let getMaxOutputTokensForModel: typeof import('./claude.js').getMaxOutputTokensForModel
  let growthbook: typeof import('../analytics/growthbook.js')
  let settings: typeof import('../../utils/settings/settings.js')
  let growthbookGate: ReturnType<typeof spyOn>
  let settingsSpy: ReturnType<typeof spyOn>
  const envKeys = ['ANTHROPIC_BASE_URL', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS', 'CLAUDE_CODE_PROVIDER_MAX_OUTPUT_TOKENS', 'CC_HAHA_OPENAI_OAUTH_PROVIDER', 'CC_HAHA_GROK_OAUTH_PROVIDER', 'CC_HAHA_DEEPSEEK_OAUTH_PROVIDER']
  let previousEnv: Array<string | undefined>

  beforeAll(async () => {
    growthbook = await import('../analytics/growthbook.js')
    settings = await import('../../utils/settings/settings.js')
    const claude = await import('./claude.js')
    isMaxTokensCapEnabled = claude.isMaxTokensCapEnabled
    getMaxOutputTokensForModel = claude.getMaxOutputTokensForModel
  }, 120_000)

  beforeEach(() => {
    previousEnv = envKeys.map(key => process.env[key])
    for (const key of envKeys) delete process.env[key]
    growthbookGate = spyOn(growthbook, 'getFeatureValue_CACHED_MAY_BE_STALE').mockReturnValue(false)
    settingsSpy = spyOn(settings, 'getSettings_DEPRECATED').mockReturnValue({})
  })

  afterEach(() => {
    envKeys.forEach((key, index) => {
      if (previousEnv[index] === undefined) delete process.env[key]
      else process.env[key] = previousEnv[index]
    })
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

  test('caps native requests without exceeding a smaller model limit', () => {
    settingsSpy.mockReturnValue({ maxOutputTokensEscalationMode: 'enabled' })
    expect(getMaxOutputTokensForModel('claude-opus-4-1')).toBe(8_000)
    expect(getMaxOutputTokensForModel('claude-3-opus')).toBe(4_096)
  })

  test('keeps proxy and dedicated OAuth budgets instead of capping a transformed request', () => {
    settingsSpy.mockReturnValue({ maxOutputTokensEscalationMode: 'enabled' })
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:3456/proxy/providers/fixture'
    expect(getMaxOutputTokensForModel('fixture-model')).toBe(32_000)
    delete process.env.ANTHROPIC_BASE_URL
    for (const key of ['CC_HAHA_OPENAI_OAUTH_PROVIDER', 'CC_HAHA_GROK_OAUTH_PROVIDER', 'CC_HAHA_DEEPSEEK_OAUTH_PROVIDER']) {
      process.env[key] = '1'
      expect(getMaxOutputTokensForModel('fixture-model')).toBe(32_000)
      delete process.env[key]
    }
  })

  test('preserves configured output budgets above and below the adaptive default', () => {
    settingsSpy.mockReturnValue({ maxOutputTokensEscalationMode: 'enabled' })
    process.env.CLAUDE_CODE_PROVIDER_MAX_OUTPUT_TOKENS = '96000'
    expect(getMaxOutputTokensForModel('fixture-model')).toBe(96_000)
    process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = '12000'
    expect(getMaxOutputTokensForModel('fixture-model')).toBe(12_000)
    process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = '1024'
    expect(getMaxOutputTokensForModel('fixture-model')).toBe(1_024)
  })
})
