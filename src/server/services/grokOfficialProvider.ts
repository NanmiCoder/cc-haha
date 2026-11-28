import {
  GROK_DEFAULT_HAIKU_MODEL,
  GROK_DEFAULT_MAIN_MODEL,
  GROK_DEFAULT_SONNET_MODEL,
  GROK_MODEL_CATALOG,
  GROK_MODEL_CATALOG_ENV_KEY,
  getGrokContextWindowForModel,
  type GrokModelCatalogEntry,
} from '../../services/grokAuth/models.js'
import { GROK_OAUTH_FILE_ENV_KEY } from '../../services/grokAuth/storage.js'
import {
  MODEL_CONTEXT_WINDOW_MAX,
  MODEL_CONTEXT_WINDOW_MIN,
  MODEL_CONTEXT_WINDOWS_ENV_KEY,
} from '../../utils/model/modelContextWindows.js'
import {
  GROK_IMAGE_DEFAULT_MODEL,
  IMAGE_GENERATION_MODEL_ENV_KEY,
  IMAGE_GENERATION_PROVIDER_ID_ENV_KEY,
  IMAGE_GENERATION_PROVIDER_KIND_ENV_KEY,
} from '../../services/imageGeneration/config.js'
import {
  GROK_OFFICIAL_PROVIDER_ID,
  type SavedProvider,
} from '../types/provider.js'
import { getHahaGrokOAuthFilePath } from './hahaGrokOAuthService.js'

export { GROK_OFFICIAL_PROVIDER_ID, GROK_OAUTH_FILE_ENV_KEY, GROK_MODEL_CATALOG_ENV_KEY }
export const GROK_OFFICIAL_PROVIDER_NAME = 'Grok Official'
export const GROK_OAUTH_PROVIDER_ENV_KEY = 'CC_HAHA_GROK_OAUTH_PROVIDER'

export function isGrokOfficialProviderId(id: string | null | undefined): boolean {
  return id === GROK_OFFICIAL_PROVIDER_ID
}

const modelContextWindows = Object.fromEntries(
  GROK_MODEL_CATALOG
    .map(({ value }) => [value, getGrokContextWindowForModel(value)] as const)
    .filter((entry): entry is readonly [string, number] => entry[1] !== null),
)

export const GROK_OFFICIAL_PROVIDER: SavedProvider = {
  id: GROK_OFFICIAL_PROVIDER_ID,
  presetId: GROK_OFFICIAL_PROVIDER_ID,
  name: GROK_OFFICIAL_PROVIDER_NAME,
  apiKey: '',
  authStrategy: 'dual_dummy',
  baseUrl: 'https://cli-chat-proxy.grok.com/v1',
  apiFormat: 'openai_chat',
  runtimeKind: 'grok_oauth',
  models: {
    main: GROK_DEFAULT_MAIN_MODEL,
    haiku: GROK_DEFAULT_HAIKU_MODEL,
    sonnet: GROK_DEFAULT_SONNET_MODEL,
    opus: GROK_DEFAULT_MAIN_MODEL,
  },
  modelContextWindows,
}

/**
 * Use the account's default windows when available. Saved overrides take precedence.
 * Callers with an authenticated account pass its catalog explicitly; omitting it
 * keeps the bundled catalog so account-specific listings never leak across logout
 * or persisted settings.
 */
export function buildGrokOfficialRuntimeEnv(
  models: SavedProvider['models'] = GROK_OFFICIAL_PROVIDER.models,
  windowOverrides?: Record<string, number>,
  catalog: readonly GrokModelCatalogEntry[] = GROK_MODEL_CATALOG,
): Record<string, string> {
  const catalogWindows = Object.fromEntries(
    catalog.flatMap((model) =>
      typeof model.contextWindow === 'number' &&
      Number.isInteger(model.contextWindow) &&
      model.contextWindow >= MODEL_CONTEXT_WINDOW_MIN &&
      model.contextWindow <= MODEL_CONTEXT_WINDOW_MAX
        ? [[model.value, model.contextWindow] as const]
        : [],
    ),
  )
  const runtimeModelContextWindows = {
    ...modelContextWindows,
    ...catalogWindows,
    ...windowOverrides,
  }
  return {
    [GROK_OAUTH_PROVIDER_ENV_KEY]: '1',
    [GROK_OAUTH_FILE_ENV_KEY]: getHahaGrokOAuthFilePath(),
    [GROK_MODEL_CATALOG_ENV_KEY]: JSON.stringify(catalog),
    [IMAGE_GENERATION_PROVIDER_KIND_ENV_KEY]: 'grok_oauth',
    [IMAGE_GENERATION_PROVIDER_ID_ENV_KEY]: GROK_OFFICIAL_PROVIDER_ID,
    [IMAGE_GENERATION_MODEL_ENV_KEY]: GROK_IMAGE_DEFAULT_MODEL,
    [MODEL_CONTEXT_WINDOWS_ENV_KEY]: JSON.stringify(runtimeModelContextWindows),
    ANTHROPIC_MODEL: models.main,
    ...(models.fable && { ANTHROPIC_DEFAULT_FABLE_MODEL: models.fable }),
    ANTHROPIC_DEFAULT_HAIKU_MODEL: models.haiku,
    ANTHROPIC_DEFAULT_SONNET_MODEL: models.sonnet,
    ANTHROPIC_DEFAULT_OPUS_MODEL: models.opus,
  }
}
