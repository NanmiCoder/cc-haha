/**
 * Per-model protocol routing for gateways that bind the wire format to the URL
 * path instead of translating between formats.
 *
 * OpenCode Go (`https://opencode.ai/zen/go/v1`) is the motivating case: a single
 * provider record serves `/chat/completions`, `/messages` and `/responses`, and
 * the gateway hard-rejects a model sent to the wrong one. A provider record only
 * carries one `apiFormat`, so presets declare ordered prefix rules here and the
 * proxy resolves the effective format from the model in the request body.
 *
 * Unmatched models fall back to the provider's own `apiFormat`, which is why the
 * rules only ever need to list the exceptions: families that *must* use a
 * non-default endpoint. Guessing a positive capability for an unknown model
 * would be worse than the safe default.
 */

export type ModelApiFormatRule<TFormat extends string = string> = {
  /** Case-insensitive prefixes; the first matching rule wins. */
  prefixes: readonly string[]
  apiFormat: TFormat
  /**
   * Where this family is served when it is not under the provider's base URL —
   * OpenCode Go only serves Gemini at `/inference/go/google/v1beta`. Resolved as a
   * URL reference against the provider's base URL, so an origin-relative path
   * follows a host the user pointed the provider at.
   */
  baseUrl?: string
}

export function resolveModelApiRule<TFormat extends string>(
  rules: readonly ModelApiFormatRule<TFormat>[] | undefined,
  modelId: string | null | undefined,
): ModelApiFormatRule<TFormat> | undefined {
  if (!rules || rules.length === 0) return undefined
  const model = modelId?.trim().toLowerCase()
  if (!model) return undefined

  for (const rule of rules) {
    for (const prefix of rule.prefixes) {
      const needle = prefix.trim().toLowerCase()
      if (needle && model.startsWith(needle)) return rule
    }
  }
  return undefined
}

export function resolveModelApiFormat<TFormat extends string>(
  rules: readonly ModelApiFormatRule<TFormat>[] | undefined,
  modelId: string | null | undefined,
): TFormat | undefined {
  return resolveModelApiRule(rules, modelId)?.apiFormat
}

/** The base URL a request for this rule goes to; the provider's own without an override. */
export function resolveModelApiBaseUrl(
  providerBaseUrl: string,
  rule: Pick<ModelApiFormatRule, 'baseUrl'> | undefined,
): string {
  const base = providerBaseUrl.replace(/\/+$/, '')
  if (!rule?.baseUrl) return base
  return new URL(rule.baseUrl, `${base}/`).toString().replace(/\/+$/, '')
}
