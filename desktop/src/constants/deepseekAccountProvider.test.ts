import { describe, expect, it } from 'vitest'
import { buildDeepSeekAccountProvider, DEEPSEEK_ACCOUNT_DEFAULT_MODEL_ID } from './deepseekAccountProvider'

describe('DeepSeek account defaults', () => {
  it('uses Flash with 1M context for every model slot', () => {
    expect(buildDeepSeekAccountProvider().models).toEqual({
      main: 'deepseek-flash[1m]',
      fable: 'deepseek-flash[1m]',
      haiku: 'deepseek-flash[1m]',
      sonnet: 'deepseek-flash[1m]',
      opus: 'deepseek-flash[1m]',
    })
    expect(DEEPSEEK_ACCOUNT_DEFAULT_MODEL_ID).toBe('deepseek-flash[1m]')
  })

  it('preserves the saved mapping when building a provider', () => {
    const saved = {
      main: 'deepseek-v4-pro[1m]',
      haiku: 'deepseek-flash',
      sonnet: 'deepseek-v4-pro',
      opus: 'deepseek-v4-pro',
    }
    expect(buildDeepSeekAccountProvider(saved).models).toEqual(saved)
  })
})
