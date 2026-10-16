import {
  DEEPSEEK_ANTHROPIC_BASE_URL,
  DEEPSEEK_AUTH_HEADER,
  DEEPSEEK_OAUTH_DUMMY_KEY,
} from '../../services/deepseekAuth/client.js'
import {
  DEEPSEEK_ACCOUNT_MODEL_CATALOG,
  getDeepSeekAccountModelCatalog,
  type DeepSeekAccountModel,
} from '../../services/deepseekAuth/modelCatalog.js'
import {
  DEEPSEEK_OAUTH_FILE_ENV_KEY,
  isInferenceEligibleGrant,
} from '../../services/deepseekAuth/storage.js'
import { PROVIDER_PRESETS } from '../config/providerPresets.js'
import {
  DEEPSEEK_ACCOUNT_PROVIDER_ID,
  type ModelMapping,
  type SavedProvider,
} from '../types/provider.js'
import {
  getHahaDeepSeekOAuthFilePath,
  hahaDeepSeekOAuthService,
} from './hahaDeepSeekOAuthService.js'

export { DEEPSEEK_ACCOUNT_PROVIDER_ID, DEEPSEEK_OAUTH_FILE_ENV_KEY }
export const DEEPSEEK_ACCOUNT_PROVIDER_NAME = 'DeepSeek Account'
export const DEEPSEEK_OAUTH_PROVIDER_ENV_KEY = 'CC_HAHA_DEEPSEEK_OAUTH_PROVIDER'

export function isDeepSeekAccountProviderId(id: string | null | undefined): boolean {
  return id === DEEPSEEK_ACCOUNT_PROVIDER_ID
}

// The account route keeps the DeepSeek preset's request shape (endpoint
// format, capability flags), but its `/models` listing names its own models:
// V4.1 Flash is `deepseek-flash`, and the API-key route's `deepseek-v4-flash`
// (V4 Flash) is not listed. The default mapping therefore names listed ids,
// and the account catalog adds its context windows over the preset's.
const deepseekPreset = PROVIDER_PRESETS.find((preset) => preset.id === 'deepseek')
if (!deepseekPreset) {
  throw new Error('DeepSeek account provider requires the bundled deepseek preset')
}

export const DEEPSEEK_ACCOUNT_FLASH_MODEL = 'deepseek-flash'
const DEEPSEEK_ACCOUNT_PRO_MODEL = 'deepseek-v4-pro[1m]'

export const DEEPSEEK_ACCOUNT_DEFAULT_MODELS: ModelMapping = {
  main: DEEPSEEK_ACCOUNT_PRO_MODEL,
  haiku: DEEPSEEK_ACCOUNT_FLASH_MODEL,
  sonnet: DEEPSEEK_ACCOUNT_PRO_MODEL,
  opus: DEEPSEEK_ACCOUNT_PRO_MODEL,
}

export const DEEPSEEK_ACCOUNT_PROVIDER: SavedProvider = {
  id: DEEPSEEK_ACCOUNT_PROVIDER_ID,
  presetId: deepseekPreset.id,
  name: DEEPSEEK_ACCOUNT_PROVIDER_NAME,
  apiKey: '',
  authStrategy: 'api_key',
  baseUrl: DEEPSEEK_ANTHROPIC_BASE_URL,
  apiFormat: 'anthropic',
  runtimeKind: 'deepseek_oauth',
  models: { ...DEEPSEEK_ACCOUNT_DEFAULT_MODELS },
  modelContextWindows: {
    ...deepseekPreset.modelContextWindows,
    ...Object.fromEntries(DEEPSEEK_ACCOUNT_MODEL_CATALOG.flatMap((model) =>
      model.contextWindow ? [[model.id, model.contextWindow]] : [])),
  },
}

const LEGACY_DEEPSEEK_ACCOUNT_FLASH_MODEL = 'deepseek-v4-flash'

/**
 * Index files before PROVIDER_DEEPSEEK_ACCOUNT_MODEL_IDS_SCHEMA_VERSION saved
 * the account mapping with the API route's `deepseek-v4-flash`: the only flash
 * id the settings card offered then, not a choice of V4 over V4.1. The account
 * listing offers V4.1 Flash instead, so point those slots at it. Other values,
 * and unknown fields, are kept as they are.
 */
export function migrateLegacyDeepSeekAccountModels<T extends Record<string, unknown>>(models: T): T {
  let changed = false
  const migrated: Record<string, unknown> = { ...models }
  for (const [slot, value] of Object.entries(models)) {
    if (typeof value === 'string' && value.trim() === LEGACY_DEEPSEEK_ACCOUNT_FLASH_MODEL) {
      migrated[slot] = DEEPSEEK_ACCOUNT_FLASH_MODEL
      changed = true
    }
  }
  return changed ? migrated as T : models
}

/**
 * Layer the account markers over the env an Anthropic-compatible DeepSeek
 * provider would get. The CLI keeps the normal request shape (model mapping,
 * capability flags, context windows) and only its credential changes: a dummy
 * API key that `buildDeepSeekFetch` replaces with the stored account token on
 * each request. No bearer token is exported, so a logged-out account can never
 * fall through to another credential.
 */
export function applyDeepSeekAccountRuntimeEnv(
  baseEnv: Record<string, string>,
): Record<string, string> {
  const { ANTHROPIC_AUTH_TOKEN: _authToken, ...env } = baseEnv
  return {
    ...env,
    ANTHROPIC_API_KEY: DEEPSEEK_OAUTH_DUMMY_KEY,
    [DEEPSEEK_OAUTH_PROVIDER_ENV_KEY]: '1',
    [DEEPSEEK_OAUTH_FILE_ENV_KEY]: getHahaDeepSeekOAuthFilePath(),
  }
}

/**
 * Headers for the server's own small Anthropic-format calls (session titles,
 * auto-answered questions) made with the account grant. Null while signed out,
 * so callers skip the call instead of sending an unauthenticated request.
 */
export async function resolveDeepSeekAccountRequestHeaders(): Promise<
  Record<string, string> | null
> {
  const tokens = await hahaDeepSeekOAuthService.loadTokens()
  if (!tokens || !isInferenceEligibleGrant(tokens)) return null
  return {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    [DEEPSEEK_AUTH_HEADER]: tokens.token,
  }
}

/**
 * Models the signed-in account offers, read from the account `/models`
 * listing; the bundled catalog while signed out or before a listing succeeds.
 * `forceRefresh` waits for a fresh listing (the settings card); without it the
 * cached listing answers at once, since `/api/models` gates the first paint.
 */
export async function listDeepSeekAccountModels(
  options?: { forceRefresh?: boolean },
): Promise<readonly DeepSeekAccountModel[]> {
  const tokens = await hahaDeepSeekOAuthService.loadTokens()
  return getDeepSeekAccountModelCatalog({
    token: tokens && isInferenceEligibleGrant(tokens) ? tokens.token : null,
    ...(options?.forceRefresh && { forceRefresh: true }),
    // Same network proxy as the account's sign-in and status requests.
    resolveProxyUrl: async () => (await hahaDeepSeekOAuthService.getRequestOptions()).proxyUrl,
  })
}
