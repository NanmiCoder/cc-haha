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
}

export function resolveModelApiFormat<TFormat extends string>(
  rules: readonly ModelApiFormatRule<TFormat>[] | undefined,
  modelId: string | null | undefined,
): TFormat | undefined {
  if (!rules || rules.length === 0) return undefined
  const model = modelId?.trim().toLowerCase()
  if (!model) return undefined

  for (const rule of rules) {
    for (const prefix of rule.prefixes) {
      const needle = prefix.trim().toLowerCase()
      if (needle && model.startsWith(needle)) return rule.apiFormat
    }
  }
  return undefined
}
