import type { Options, Query } from '@anthropic-ai/claude-agent-sdk'
import { officialAgentSdkProviderSettings } from './officialAgentSdkConfiguration.js'

const networkKeys = new Set([
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'API_TIMEOUT_MS', 'CLAUDE_STREAM_FIRST_TOKEN_TIMEOUT_MS',
  'CLAUDE_STREAM_MAX_DURATION_MS', 'CLAUDE_STREAM_TOOL_INPUT_MAX_DURATION_MS',
])

/** Session-only updates: never rewrite user settings or change the provider route. */
export function createOfficialAgentSdkNetwork(
  env: NodeJS.ProcessEnv,
  options: Options,
  runtime: Pick<Query, 'applyFlagSettings'>,
  updateSettingsEnv?: (variables: Record<string, string>) => void,
): { update(variables: unknown): Promise<void>; updateCredentials(apiKey: unknown): Promise<void> } {
  let pending = Promise.resolve()
  let current = Object.fromEntries([...networkKeys].map(key => [key, env[key] ?? '']))
  let provider = officialAgentSdkProviderSettings(env).env ?? {}
  function apply(patch: Record<string, string>, credentials = false): Promise<void> {
    const update = pending.then(async () => {
      const next = credentials ? current : { ...current, ...patch }
      const nextProvider = credentials ? { ...provider, ...patch } : provider
      // Flag settings replace the entire env map. Serialize credential and
      // network writes so neither can restore an older key or proxy route.
      await runtime.applyFlagSettings({ env: { ...nextProvider, ...next } })
      updateSettingsEnv?.(patch)
      current = next
      provider = nextProvider
      Object.assign(env, patch)
      options.env ??= {}
      Object.assign(options.env, patch)
    })
    pending = update.catch(() => undefined)
    return update
  }
  return {
    update(variables) {
      if (!variables || typeof variables !== 'object' || Array.isArray(variables) ||
        Object.entries(variables).some(([key, value]) => !networkKeys.has(key) || typeof value !== 'string')) {
        return Promise.reject(new Error('Invalid SDK network environment update'))
      }
      return apply({ ...variables as Record<string, string> })
    },
    updateCredentials(apiKey) {
      if (typeof apiKey !== 'string' || !apiKey.trim()) {
        return Promise.reject(new Error('Invalid SDK provider credential update'))
      }
      return apply({ ANTHROPIC_API_KEY: apiKey, ANTHROPIC_AUTH_TOKEN: '' }, true)
    },
  }
}
