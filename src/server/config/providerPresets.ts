// Provider presets inspired by cc-switch (https://github.com/farion1231/cc-switch)
// Original work by Jason Young, MIT License

import { z } from 'zod'

import providerPresetsJson from './providerPresets.json'
import { ApiFormatSchema, ProviderAuthStrategySchema } from '../types/provider.js'
import type { ModelReasoningProviderKind } from '../../shared/modelReasoning.js'

const ModelMappingSchema = z.object({
  main: z.string(),
  fable: z.string().optional(),
  haiku: z.string(),
  sonnet: z.string(),
  opus: z.string(),
})

const ProviderRegionalEndpointSchema = z.object({
  region: z.string().min(1),
  baseUrl: z.string().url(),
})

const ProviderPresetSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  baseUrl: z.string(),
  regionalEndpoints: z.array(ProviderRegionalEndpointSchema).min(1).optional(),
  apiFormat: ApiFormatSchema,
  reasoningProviderKind: z.enum([
    'zhipu_standard_api',
    'zhipu_coding_plan',
  ] satisfies readonly ModelReasoningProviderKind[]).optional(),
  defaultModels: ModelMappingSchema,
  defaultImageGeneration: z.object({ model: z.string().min(1) }).optional(),
  needsApiKey: z.boolean(),
  websiteUrl: z.string(),
  apiKeyUrl: z.string().optional(),
  promoText: z.string().optional(),
  featured: z.boolean().optional(),
  // Retired sponsor/provider: filtered out of the "add provider" choices, but the entry
  // MUST stay in this list — deleting it silently degrades providers already saved
  // against it, because three things are resolved from the preset, never from the
  // provider record:
  //   1. defaultEnv — never persisted per provider, re-resolved on every run
  //   2. getManagedEnvKeys() — builds the settings.json erase list from every preset's
  //      defaultEnv keys, so dropping a preset leaks its keys into other providers
  //   3. the provider card badge, which renders the preset's name
  // Older records may also lack authStrategy / modelContextWindows entirely and fall
  // back to the preset for those too.
  deprecated: z.boolean().optional(),
  authStrategy: ProviderAuthStrategySchema.optional(),
  defaultEnv: z.record(z.string(), z.string()).optional(),
  modelContextWindows: z.record(
    z.string().min(1),
    z.number().int().min(16000).max(10000000),
  ).optional(),
})

const ProviderPresetsSchema = z.array(ProviderPresetSchema)

export type ModelMapping = z.infer<typeof ModelMappingSchema>
export type ProviderPreset = z.infer<typeof ProviderPresetSchema>

/** Every preset, including retired ones — use this to resolve a saved provider's presetId. */
export const PROVIDER_PRESETS = ProviderPresetsSchema.parse(providerPresetsJson)
