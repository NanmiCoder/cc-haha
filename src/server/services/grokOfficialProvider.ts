import {
  GROK_DEFAULT_HAIKU_MODEL,
  GROK_DEFAULT_MAIN_MODEL,
  GROK_DEFAULT_SONNET_MODEL,
  GROK_MODEL_CATALOG,
  getGrokContextWindowForModel,
} from '../../services/grokAuth/models.js'
import { GROK_OAUTH_FILE_ENV_KEY } from '../../services/grokAuth/storage.js'
import { MODEL_CONTEXT_WINDOWS_ENV_KEY } from '../../utils/model/modelContextWindows.js'
import {
  GROK_OFFICIAL_PROVIDER_ID,
  type SavedProvider,
} from '../types/provider.js'
import { getHahaGrokOAuthFilePath } from './hahaGrokOAuthService.js'

export { GROK_OFFICIAL_PROVIDER_ID, GROK_OAUTH_FILE_ENV_KEY }
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

export function buildGrokOfficialRuntimeEnv(): Record<string, string> {
  return {
    [GROK_OAUTH_PROVIDER_ENV_KEY]: '1',
    [GROK_OAUTH_FILE_ENV_KEY]: getHahaGrokOAuthFilePath(),
    [MODEL_CONTEXT_WINDOWS_ENV_KEY]: JSON.stringify(modelContextWindows),
    ANTHROPIC_MODEL: GROK_DEFAULT_MAIN_MODEL,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: GROK_DEFAULT_HAIKU_MODEL,
    ANTHROPIC_DEFAULT_SONNET_MODEL: GROK_DEFAULT_SONNET_MODEL,
    ANTHROPIC_DEFAULT_OPUS_MODEL: GROK_DEFAULT_MAIN_MODEL,
  }
}
