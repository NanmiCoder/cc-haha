import { describe, expect, test } from 'bun:test'
import { getAgentProviderModel, getBuiltInAgentProviderId } from './agentProviderModel.js'
import { GENERAL_PURPOSE_AGENT } from './built-in/generalPurposeAgent.js'
import { runWithProviderRuntime, type ProviderRuntimeContext } from '../../services/api/providerRuntimeContext.js'

const runtime: ProviderRuntimeContext = {
  providerId: 'provider-b', runtimeKind: 'anthropic_compatible',
  env: { ANTHROPIC_BASE_URL: 'https://b.invalid', ANTHROPIC_MODEL: 'b-main', ANTHROPIC_DEFAULT_OPUS_MODEL: 'b-opus' },
}

describe('Agent provider model selection', () => {
  test('provider-only override selects the target default instead of the invoker model', () => {
    expect(getAgentProviderModel({ ...GENERAL_PURPOSE_AGENT, providerId: 'provider-b' },
      'a-main', undefined, 'default', runtime)).toBe('b-main')
  })

  test('nested agents without an override keep the nearest invoker model', () => {
    runWithProviderRuntime(runtime, () => {
      expect(getAgentProviderModel(GENERAL_PURPOSE_AGENT, 'b-child-model', undefined, 'default')).toBe('b-child-model')
    })
  })

  test('a resumed agent keeps its recorded model after the provider default changes', () => {
    expect(getAgentProviderModel({ ...GENERAL_PURPOSE_AGENT, providerId: 'provider-b' },
      'a-main', undefined, 'default', runtime, 'b-recorded-model')).toBe('b-recorded-model')
  })

  test('custom definitions do not acquire the built-in provider override surface', () => {
    expect(getBuiltInAgentProviderId({ ...GENERAL_PURPOSE_AGENT, source: 'projectSettings', providerId: 'ignored' } as never)).toBeUndefined()
  })
})
