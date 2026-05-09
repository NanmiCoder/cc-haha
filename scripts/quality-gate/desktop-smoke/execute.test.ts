import { describe, expect, test } from 'bun:test'
import { resolveDesktopSmokeRuntimeSelection } from './execute'

describe('desktop smoke runtime selection', () => {
  test('lets current-runtime use the desktop default active provider', () => {
    expect(resolveDesktopSmokeRuntimeSelection({
      providerId: null,
      modelId: 'current',
      label: 'current-runtime',
    })).toBeNull()
  })

  test('keeps explicit official and saved provider selections scoped to the session', () => {
    expect(resolveDesktopSmokeRuntimeSelection({
      providerId: null,
      modelId: 'claude-sonnet-4-6',
      label: 'official-sonnet',
    })).toEqual({
      providerId: null,
      modelId: 'claude-sonnet-4-6',
    })

    expect(resolveDesktopSmokeRuntimeSelection({
      providerId: 'provider-a',
      modelId: 'model-a',
      label: 'provider-a-main',
    })).toEqual({
      providerId: 'provider-a',
      modelId: 'model-a',
    })
  })
})
