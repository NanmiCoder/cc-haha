import { describe, expect, test } from 'bun:test'
import { MODEL_CONTEXT_WINDOWS_ENV_KEY } from '../../utils/model/modelContextWindows.js'
import { buildOpenAIOfficialRuntimeEnv } from './openaiOfficialProvider.js'

describe('ChatGPT Official runtime environment', () => {
  test('includes current Codex OAuth windows and defaults', () => {
    const env = buildOpenAIOfficialRuntimeEnv()
    const windows = JSON.parse(env[MODEL_CONTEXT_WINDOWS_ENV_KEY]!) as Record<string, number>

    expect(windows['gpt-6-astra']).toBe(258_400)
    expect(windows['gpt-6-sol']).toBe(258_400)
    expect(windows['gpt-6-luna']).toBe(258_400)
    expect(windows['gpt-5.6-sol']).toBe(353_400)
    expect(env.ANTHROPIC_MODEL).toBe('gpt-6-sol')
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('gpt-6-sol')
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('gpt-6-luna')
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('gpt-6-astra')
  })
})
