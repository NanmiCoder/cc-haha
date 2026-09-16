export const OUTPUT_BUDGET_SOURCE_HEADER = 'x-cc-haha-output-budget-source'
export type OutputBudgetSource = 'default' | 'explicit'

// Request-local metadata must never leak into the provider's JSON body or
// persisted conversation. Weak keys also release logging/retry probe requests.
const sources = new WeakMap<object, OutputBudgetSource>()

export function markOutputBudgetSource<T extends object>(params: T, source: OutputBudgetSource): T {
  sources.set(params, source)
  return params
}

export function isLocalProtocolProxy(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false
  try {
    const url = new URL(baseUrl)
    return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      && /^\/proxy(?:\/|$)/.test(url.pathname)
  } catch {
    return false
  }
}

export function getOutputBudgetHeaders(
  params: object,
  baseUrl = process.env.ANTHROPIC_BASE_URL,
): Record<string, string> {
  return isLocalProtocolProxy(baseUrl)
    ? { [OUTPUT_BUDGET_SOURCE_HEADER]: sources.get(params) ?? 'explicit' }
    : {}
}

export function getConfiguredProviderOutputBudget(env: NodeJS.ProcessEnv = process.env): number | undefined {
  if (!isLocalProtocolProxy(env.ANTHROPIC_BASE_URL)) return undefined
  const raw = env.CLAUDE_CODE_PROVIDER_MAX_OUTPUT_TOKENS
  if (!raw || !/^\d+$/.test(raw)) return undefined
  const value = Number(raw)
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}
