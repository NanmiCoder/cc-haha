import { describe, expect, test } from 'bun:test'
import { MODEL_CONTEXT_WINDOWS_ENV_KEY } from '../../utils/model/modelContextWindows.js'
import { buildOpenAIOfficialRuntimeEnv } from './openaiOfficialProvider.js'

describe('ChatGPT Official runtime environment', () => {
  test('includes the Astra effective context window without changing the default model', () => {
    const env = buildOpenAIOfficialRuntimeEnv()
    const windows = JSON.parse(env[MODEL_CONTEXT_WINDOWS_ENV_KEY]!) as Record<string, number>

    expect(windows['gpt-6-astra']).toBe(997_500)
    expect(windows['gpt-5.6-sol']).toBe(353_400)
    expect(env.ANTHROPIC_MODEL).toBe('gpt-5.6-sol')
  })
})
