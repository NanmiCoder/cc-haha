/**
 * Provider types — preset-based provider configuration.
 *
 * Providers are stored in ~/.claude/cc-haha/providers.json as a lightweight index.
 * The active provider's env vars are written to ~/.claude/settings.json.
 */

import { z } from 'zod'

export const ApiFormatSchema = z.enum([
  'anthropic',         // Native Anthropic Messages API (passthrough, no proxy)
  'openai_chat',       // OpenAI Chat Completions /v1/chat/completions
  'openai_responses',  // OpenAI Responses API /v1/responses
])
export type ApiFormat = z.infer<typeof ApiFormatSchema>

export const ProviderAuthStrategySchema = z.enum([
  'api_key',
  'auth_token',
  'auth_token_empty_api_key',
  'dual_same_token',
  'dual_dummy',
])
export type ProviderAuthStrategy = z.infer<typeof ProviderAuthStrategySchema>

export const ProviderRuntimeKindSchema = z.enum([
  'anthropic_compatible',
  'openai_oauth',
])
export type ProviderRuntimeKind = z.infer<typeof ProviderRuntimeKindSchema>

export const ModelMappingSchema = z.object({
  main: z.string(),
  haiku: z.string(),
  sonnet: z.string(),
  opus: z.string(),
})

export const AutoCompactWindowSchema = z.number().int().min(16000).max(10000000)
export const ModelContextWindowsSchema = z.record(
  z.string().min(1),
  z.number().int().min(16000).max(10000000),
)

export const SavedProviderSchema = z.object({
  id: z.string(),
  presetId: z.string(),
  name: z.string().min(1),
  apiKey: z.string(),
  authStrategy: ProviderAuthStrategySchema.optional(),
  baseUrl: z.string(),
  apiFormat: ApiFormatSchema.default('anthropic'),
  runtimeKind: ProviderRuntimeKindSchema.default('anthropic_compatible'),
  models: ModelMappingSchema,
  autoCompactWindow: AutoCompactWindowSchema.optional(),
  modelContextWindows: ModelContextWindowsSchema.optional(),
  notes: z.string().optional(),
  /**
   * Sticky compatibility marker: set to true when cc-haha observes this
   * provider rejecting Anthropic's `thinking` field via a 4xx like
   * "additionalModelRequestFields not supported" (typical for Bedrock
   * proxies that wrap unknown Anthropic params into AWS's
   * additionalModelRequestFields). When true, `buildProviderManagedEnv`
   * injects `CLAUDE_CODE_DISABLE_THINKING=1` so subsequent sidecar
   * launches stop sending thinking entirely. Cleared automatically on
   * any updateProvider() so users get a fresh chance after editing
   * config — matches the desktop providerCompatStore re-arm semantics
   * for fake tool_use detection.
   */
  thinkingIncompatible: z.boolean().optional(),
  /**
   * Optional last-seen 4xx message from the provider, surfaced in the
   * Settings tooltip so the user understands WHY the badge appeared.
   * Truncated to 500 chars on persist so a chatty proxy can't blow the
   * providers.json file.
   */
  thinkingIncompatibleReason: z.string().max(500).optional(),
  /**
   * Monotonically-increasing counter bumped on every {@link updateProvider}.
   * The runtime layer captures this value alongside the per-session
   * `runtimeOverride` at session start, and the next `set_runtime_config`
   * compares revisions to decide whether to force a CLI restart even when
   * the (providerId, modelId, effort, thinkingEnabled) tuple is unchanged.
   *
   * This catches "user changed baseUrl / apiKey / apiFormat / model mapping
   * but the override tuple still matches" — without it, the CLI keeps its
   * spawn-time `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` env until the
   * subprocess is killed for some other reason, which makes provider
   * config edits feel "stuck".
   *
   * Optional for backwards compatibility with providers.json files written
   * before this field existed; absent reads as 0.
   */
  revision: z.number().int().nonnegative().optional(),
})

export const ProvidersIndexSchema = z.object({
  schemaVersion: z.number().int().positive().optional(),
  activeId: z.string().nullable(),
  providers: z.array(SavedProviderSchema),
})

export const CreateProviderSchema = z.object({
  presetId: z.string().min(1),
  name: z.string().min(1),
  apiKey: z.string(),
  authStrategy: ProviderAuthStrategySchema.optional(),
  baseUrl: z.string(),
  apiFormat: ApiFormatSchema.default('anthropic'),
  runtimeKind: ProviderRuntimeKindSchema.default('anthropic_compatible'),
  models: ModelMappingSchema,
  autoCompactWindow: AutoCompactWindowSchema.optional(),
  modelContextWindows: ModelContextWindowsSchema.optional(),
  notes: z.string().optional(),
})

export const UpdateProviderSchema = z.object({
  name: z.string().min(1).optional(),
  apiKey: z.string().optional(),
  authStrategy: ProviderAuthStrategySchema.optional(),
  baseUrl: z.string().optional(),
  apiFormat: ApiFormatSchema.optional(),
  runtimeKind: ProviderRuntimeKindSchema.optional(),
  models: ModelMappingSchema.optional(),
  autoCompactWindow: AutoCompactWindowSchema.nullable().optional(),
  modelContextWindows: ModelContextWindowsSchema.nullable().optional(),
  notes: z.string().optional(),
})

export const TestProviderSchema = z.object({
  baseUrl: z.string().url(),
  apiKey: z.string().min(1),
  modelId: z.string().min(1),
  authStrategy: ProviderAuthStrategySchema.optional(),
  apiFormat: ApiFormatSchema.default('anthropic'),
})

/**
 * Input for `POST /api/providers/fetch-models`. The model list is fetched
 * server-side to bypass the renderer's secure-context restrictions — most
 * webviews block plain `http://` requests as mixed content (the desktop
 * UI runs at `tauri://localhost` / `https://...`), and many self-hosted
 * relay providers also do not return `Access-Control-Allow-Origin` for
 * `/v1/models`. Either failure mode kills the previous browser-side
 * `fetch()`. Server-side has neither restriction.
 */
export const FetchModelsSchema = z.object({
  baseUrl: z.string().url(),
  apiKey: z.string().min(1),
  apiFormat: ApiFormatSchema.default('anthropic'),
})

// TypeScript types
export type ModelMapping = z.infer<typeof ModelMappingSchema>
export type SavedProvider = z.infer<typeof SavedProviderSchema>
export type ProvidersIndex = z.infer<typeof ProvidersIndexSchema>
export type CreateProviderInput = z.infer<typeof CreateProviderSchema>
export type UpdateProviderInput = z.infer<typeof UpdateProviderSchema>
export type TestProviderInput = z.infer<typeof TestProviderSchema>
export type FetchModelsInput = z.infer<typeof FetchModelsSchema>

export interface ProviderTestStepResult {
  success: boolean
  latencyMs: number
  error?: string
  modelUsed?: string
  httpStatus?: number
}

export interface ProviderTestResult {
  /** Step 1: Basic connectivity — API reachable, key valid, model exists */
  connectivity: ProviderTestStepResult
  /** Step 2: Proxy pipeline — full Anthropic→OpenAI→Anthropic round-trip (only for openai_* formats) */
  proxy?: ProviderTestStepResult
}
