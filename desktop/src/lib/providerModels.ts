// desktop/src/lib/providerModels.ts

import type { TranslationKey } from '../i18n'
import type { ProviderModelInfo, ProviderModelsErrorCode } from '../types/provider'

export type ProviderModelGroup = {
  /** `ownedBy` when the provider reports one, otherwise the caller's fallback. */
  group: string
  models: ProviderModelInfo[]
}

/**
 * Buckets a fetched model list by `ownedBy`.
 *
 * Groups are sorted alphabetically (case-insensitively, so `OpenAI` and
 * `openai` do not end up on opposite ends of the list); models keep the order
 * the provider returned them in, which is usually newest-first.
 *
 * Duplicate ids are dropped — a repeated id would collide as a React key, and
 * several gateways list the same model under more than one page of results.
 */
export function groupProviderModels(
  models: ProviderModelInfo[],
  fallbackGroup: string,
): ProviderModelGroup[] {
  const seen = new Set<string>()
  const groups = new Map<string, ProviderModelInfo[]>()

  for (const model of models) {
    const id = model.id?.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)

    const group = model.ownedBy?.trim() || fallbackGroup
    const bucket = groups.get(group)
    if (bucket) bucket.push({ ...model, id })
    else groups.set(group, [{ ...model, id }])
  }

  // 'en' (not the host default) so ASCII and CJK group names sort the same on
  // every OS — the host locale is often zh, which orders CJK before Latin and
  // puts the "其他" fallback above the real provider names.
  return [...groups.entries()]
    .map(([group, groupModels]) => ({ group, models: groupModels }))
    .sort((a, b) => a.group.localeCompare(b.group, 'en', { sensitivity: 'base' }))
}

/**
 * One message per `errorCode`.
 *
 * The server's `message` is free text that changes with the upstream response,
 * so matching on it is how a working error path silently stops matching. The
 * code is the contract.
 */
export const PROVIDER_MODELS_ERROR_KEYS: Record<ProviderModelsErrorCode, TranslationKey> = {
  'missing-config': 'settings.providers.fetchModelsErrorMissingConfig',
  'auth-failed': 'settings.providers.fetchModelsErrorAuthFailed',
  'endpoint-not-found': 'settings.providers.fetchModelsErrorEndpointNotFound',
  timeout: 'settings.providers.fetchModelsErrorTimeout',
  'not-supported': 'settings.providers.fetchModelsErrorNotSupported',
  network: 'settings.providers.fetchModelsErrorNetwork',
  unknown: 'settings.providers.fetchModelsErrorUnknown',
}

/** Falls back to the generic message for a code the server added after us. */
export function providerModelsErrorKey(code: ProviderModelsErrorCode): TranslationKey {
  return PROVIDER_MODELS_ERROR_KEYS[code] ?? PROVIDER_MODELS_ERROR_KEYS.unknown
}
