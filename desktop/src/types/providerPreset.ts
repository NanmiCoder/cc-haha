import type { ApiFormat, ProviderAuthStrategy } from './provider'
import type { ModelReasoningProviderKind } from '../../../src/shared/modelReasoning'

export type ModelMapping = {
  main: string
  fable?: string
  haiku: string
  sonnet: string
  opus: string
}

export type ProviderRegionalEndpoint = {
  region: string
  baseUrl: string
}

export type ProviderPreset = {
  id: string
  name: string
  baseUrl: string
  regionalEndpoints?: ProviderRegionalEndpoint[]
  apiFormat: ApiFormat
  reasoningProviderKind?: ModelReasoningProviderKind
  defaultModels: ModelMapping
  defaultImageGeneration?: { model: string }
  needsApiKey: boolean
  websiteUrl: string
  apiKeyUrl?: string
  promoText?: string
  featured?: boolean
  /** Retired preset: hidden from the "add provider" choices, still resolves saved providers. */
  deprecated?: boolean
  authStrategy?: ProviderAuthStrategy
  defaultEnv?: Record<string, string>
  modelContextWindows?: Record<string, number>
}
