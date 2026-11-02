import { BUNDLED_PROVIDER_PRESETS } from '../config/providerPresets'
import type { ModelMapping, SavedProvider } from '../types/provider'

export const DEEPSEEK_ACCOUNT_PROVIDER_ID = 'deepseek-account'
export const DEEPSEEK_ACCOUNT_PROVIDER_NAME = 'DeepSeek Account'

// The account provider keeps the bundled `deepseek` preset's endpoint shape
// and capability rules. Both routes use V4.1 Flash as `deepseek-flash`.
// Keep this mapping in step with DEEPSEEK_ACCOUNT_DEFAULT_MODELS on the server.
const DEEPSEEK_PRESET_ID = 'deepseek'
const deepSeekPreset = BUNDLED_PROVIDER_PRESETS.find((preset) => preset.id === DEEPSEEK_PRESET_ID)

export const DEEPSEEK_ACCOUNT_MODEL_MAPPING: ModelMapping = {
  main: 'deepseek-flash[1m]',
  fable: 'deepseek-flash[1m]',
  haiku: 'deepseek-flash[1m]',
  sonnet: 'deepseek-flash[1m]',
  opus: 'deepseek-flash[1m]',
}

export const DEEPSEEK_ACCOUNT_DEFAULT_MODEL_ID = DEEPSEEK_ACCOUNT_MODEL_MAPPING.main

/**
 * What the account offers before its `/models` listing is in hand: the
 * server's bundled account catalog. Once the account provider is active, the
 * server's `/api/models` answer carries the live listing instead.
 */
export const DEEPSEEK_ACCOUNT_CATALOG_MODELS: ReadonlyArray<{ id: string; name: string }> = [
  { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' },
  { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
]

/**
 * A saved-provider-shaped view of the built-in account provider. The model
 * picker builds its rows (slot labels, reasoning options) from saved providers,
 * and an account login has to look the same there as the API-key provider.
 */
export function buildDeepSeekAccountProvider(
  models: ModelMapping = DEEPSEEK_ACCOUNT_MODEL_MAPPING,
): SavedProvider {
  return {
    id: DEEPSEEK_ACCOUNT_PROVIDER_ID,
    presetId: DEEPSEEK_PRESET_ID,
    name: DEEPSEEK_ACCOUNT_PROVIDER_NAME,
    apiKey: '',
    baseUrl: deepSeekPreset?.baseUrl ?? '',
    apiFormat: 'anthropic',
    runtimeKind: 'deepseek_oauth',
    models: { ...models },
  }
}
