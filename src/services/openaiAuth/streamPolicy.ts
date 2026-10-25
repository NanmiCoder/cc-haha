import { getProviderRuntimeEnvironment } from '../api/providerRuntimeContext.js'
export const OPENAI_CODEX_STREAM_MARKER_HEADER = 'x-cc-haha-openai-codex-stream'
export const OPENAI_CODEX_FIRST_TOKEN_TIMEOUT_ENV = 'CC_HAHA_OPENAI_OAUTH_FIRST_TOKEN_TIMEOUT_MS'

const DEFAULT_OPENAI_CODEX_FIRST_TOKEN_TIMEOUT_MS = 300_000

export function resolveOpenAICodexFirstTokenTimeoutMs(
  response: Response | undefined,
  fallbackTimeoutMs: number,
  oauthTimeoutOverride = getProviderRuntimeEnvironment()[OPENAI_CODEX_FIRST_TOKEN_TIMEOUT_ENV],
): number {
  if (!isOpenAICodexStream(response)) {
    return fallbackTimeoutMs
  }

  const override = parsePositiveInteger(oauthTimeoutOverride)
  if (override !== null) return override

  return Math.max(fallbackTimeoutMs, DEFAULT_OPENAI_CODEX_FIRST_TOKEN_TIMEOUT_MS)
}

export function canRetryOpenAICodexStreamWithBufferedContent(
  response: Response | undefined,
  hasCrossedSideEffectBoundary: boolean,
): boolean {
  return isOpenAICodexStream(response) && !hasCrossedSideEffectBoundary
}

function isOpenAICodexStream(response: Response | undefined): boolean {
  return response?.headers.get(OPENAI_CODEX_STREAM_MARKER_HEADER) === '1'
}

function parsePositiveInteger(value: string | undefined): number | null {
  if (!value) return null
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}
