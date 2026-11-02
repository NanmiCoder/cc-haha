import type { SavedProvider } from '../../../types/provider.js'
import type {
  ProviderTextCompletionRequest,
  ProviderTextCompletionResult,
} from '../../providerTextCompletion.js'
import type { CorrectionTargetResolver, ResolvedCorrectionTarget } from '../correction/target.js'

/** A saved provider record with fake credentials; never reaches a network. */
export function fakeProviderRecord(id: string, overrides: Partial<SavedProvider> = {}): SavedProvider {
  return {
    id,
    presetId: 'custom',
    name: overrides.name ?? `Provider ${id}`,
    apiKey: 'fake-key',
    baseUrl: 'http://127.0.0.1:9/anthropic',
    apiFormat: 'anthropic',
    runtimeKind: 'anthropic_compatible',
    models: { main: `${id}-main`, haiku: `${id}-fast`, sonnet: `${id}-main`, opus: `${id}-main` },
    ...overrides,
  } as SavedProvider
}

export function resolvedTarget(provider: SavedProvider, modelId = provider.models.haiku || provider.models.main): ResolvedCorrectionTarget {
  return { provider, target: { providerId: provider.id, providerName: provider.name, modelId } }
}

/** Default target is `defaultProvider`'s fast model; fixed targets resolve for any provider in `providers`. */
export function fakeTargets(options: {
  defaultProvider?: SavedProvider | null
  providers?: SavedProvider[]
} = {}): CorrectionTargetResolver & { fixedCalls: Array<[string, string]> } {
  const providers = new Map((options.providers ?? []).map(provider => [provider.id, provider]))
  if (options.defaultProvider) providers.set(options.defaultProvider.id, options.defaultProvider)
  const resolver = {
    fixedCalls: [] as Array<[string, string]>,
    async resolveDefault() {
      return options.defaultProvider ? resolvedTarget(options.defaultProvider) : null
    },
    async resolveFixed(providerId: string, modelId: string) {
      resolver.fixedCalls.push([providerId, modelId])
      const provider = providers.get(providerId)
      return provider ? resolvedTarget(provider, modelId) : null
    },
  }
  return resolver
}

type Reply = ProviderTextCompletionResult | ((request: ProviderTextCompletionRequest) => Promise<ProviderTextCompletionResult> | ProviderTextCompletionResult)

/** Answers each call with the next scripted reply (the last one repeats) and records the requests. */
export function scriptedCompletion(...replies: Reply[]) {
  const requests: ProviderTextCompletionRequest[] = []
  const complete = async (request: ProviderTextCompletionRequest): Promise<ProviderTextCompletionResult> => {
    requests.push(request)
    const reply = replies[Math.min(requests.length - 1, replies.length - 1)]
    if (!reply) throw new Error('no scripted reply')
    return typeof reply === 'function' ? reply(request) : reply
  }
  return { complete, requests }
}

export const text = (value: string): ProviderTextCompletionResult => ({ ok: true, text: value })
