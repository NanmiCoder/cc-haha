import { OPENAI_CODEX_API_ENDPOINT } from '../../services/openaiAuth/client.js'
import {
  OPENAI_CODEX_MODEL_CATALOG,
  OPENAI_DEFAULT_HAIKU_MODEL,
  OPENAI_DEFAULT_MAIN_MODEL,
  OPENAI_DEFAULT_SONNET_MODEL,
  getOpenAICodexContextWindowForModel,
} from '../../services/openaiAuth/models.js'
import { MODEL_CONTEXT_WINDOWS_ENV_KEY } from '../../utils/model/modelContextWindows.js'
import { getHahaOpenAIOAuthFilePath } from './hahaOpenAIOAuthService.js'
import {
  OPENAI_OFFICIAL_PROVIDER_ID,
  type SavedProvider,
} from '../types/provider.js'

export { OPENAI_OFFICIAL_PROVIDER_ID }
export const OPENAI_OFFICIAL_PROVIDER_NAME = 'ChatGPT Official'
export const OPENAI_OAUTH_PROVIDER_ENV_KEY = 'CC_HAHA_OPENAI_OAUTH_PROVIDER'
export const OPENAI_CODEX_OAUTH_FILE_ENV_KEY = 'OPENAI_CODEX_OAUTH_FILE'

export function isOpenAIOfficialProviderId(
  id: string | null | undefined,
): boolean {
  return id === OPENAI_OFFICIAL_PROVIDER_ID
}

const openAIModels: SavedProvider['models'] = {
  main: OPENAI_DEFAULT_MAIN_MODEL,
  haiku: OPENAI_DEFAULT_HAIKU_MODEL,
  sonnet: OPENAI_DEFAULT_SONNET_MODEL,
  opus: OPENAI_DEFAULT_MAIN_MODEL,
}

const modelContextWindows = Object.fromEntries(
  OPENAI_CODEX_MODEL_CATALOG.map(
    ({ value }) =>
      [value, getOpenAICodexContextWindowForModel(value)] as const,
  )
    .filter((entry): entry is readonly [string, number] => entry[1] !== null),
)

export const OPENAI_OFFICIAL_PROVIDER: SavedProvider = {
  id: OPENAI_OFFICIAL_PROVIDER_ID,
  presetId: OPENAI_OFFICIAL_PROVIDER_ID,
  name: OPENAI_OFFICIAL_PROVIDER_NAME,
  apiKey: '',
  authStrategy: 'dual_dummy',
  baseUrl: new URL('/backend-api/codex', OPENAI_CODEX_API_ENDPOINT)
    .toString()
    .replace(/\/+$/, ''),
  apiFormat: 'openai_responses',
  runtimeKind: 'openai_oauth',
  models: openAIModels,
  modelContextWindows,
}

export function buildOpenAIOfficialRuntimeEnv(): Record<string, string> {
  const modelContextWindows = OPENAI_OFFICIAL_PROVIDER.modelContextWindows ?? {}
  return {
    [OPENAI_OAUTH_PROVIDER_ENV_KEY]: '1',
    [OPENAI_CODEX_OAUTH_FILE_ENV_KEY]: getHahaOpenAIOAuthFilePath(),
    ...(Object.keys(modelContextWindows).length > 0 && {
      [MODEL_CONTEXT_WINDOWS_ENV_KEY]: JSON.stringify(modelContextWindows),
    }),
    ANTHROPIC_MODEL: OPENAI_OFFICIAL_PROVIDER.models.main,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: OPENAI_OFFICIAL_PROVIDER.models.haiku,
    ANTHROPIC_DEFAULT_SONNET_MODEL: OPENAI_OFFICIAL_PROVIDER.models.sonnet,
    ANTHROPIC_DEFAULT_OPUS_MODEL: OPENAI_OFFICIAL_PROVIDER.models.opus,
  }
}
