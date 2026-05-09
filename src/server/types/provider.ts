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
  models: ModelMappingSchema,
  autoCompactWindow: AutoCompactWindowSchema.optional(),
  modelContextWindows: ModelContextWindowsSchema.optional(),
  notes: z.string().optional(),
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

// TypeScript types
export type ModelMapping = z.infer<typeof ModelMappingSchema>
export type SavedProvider = z.infer<typeof SavedProviderSchema>
export type ProvidersIndex = z.infer<typeof ProvidersIndexSchema>
export type CreateProviderInput = z.infer<typeof CreateProviderSchema>
export type UpdateProviderInput = z.infer<typeof UpdateProviderSchema>
export type TestProviderInput = z.infer<typeof TestProviderSchema>

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
