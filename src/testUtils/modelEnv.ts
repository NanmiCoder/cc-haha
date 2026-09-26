import { afterAll } from 'bun:test'

/**
 * Model default resolution and model-capability lookup read several ANTHROPIC
 * and CLAUDE_CODE vars from process env (src/utils/model/model.ts, modelOptions.ts,
 * context.ts, effort.ts). Desktop dev shells export those (e.g.
 * ANTHROPIC_DEFAULT_SONNET_MODEL=zxsv-ai, ANTHROPIC_BASE_URL pointing at a
 * local proxy), which breaks tests asserting built-in defaults. Clearing them
 * at import time is not enough on its own — we also restore the original
 * values when the test file finishes, so the ambient env is left exactly as
 * the desktop process set it.
 */
const MODEL_ENV_VARS = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_ATTRIBUTION_HEADER',
  'CLAUDE_CODE_MODEL_CONTEXT_WINDOWS',
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  // Client-credential vars the desktop shell also exports (read as defaults in
  // src/services/api/client.ts): without clearing them, proxy-token resolution
  // picks up the host-local H5 token and the SDK client picks up a bearer
  // token from the ambient shell.
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'CC_HAHA_LOCAL_ACCESS_TOKEN',
] as const

/**
 * Clear ambient model-override env vars for this test file and register an
 * afterAll hook that restores them. Call once at module top level, after
 * imports.
 */
export function isolateModelDefaultsEnv(): void {
  const saved: Record<string, string | undefined> = {}
  for (const key of MODEL_ENV_VARS) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
  afterAll(() => {
    for (const key of MODEL_ENV_VARS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  })
}
