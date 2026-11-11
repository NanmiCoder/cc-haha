import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'

import { providersApi } from '@/api/providers'
import { modelsApi } from '@/api/models'
import { Button } from '@/components/ui/Button'
import { Spinner } from '@/components/ui/Spinner'
import { CLAUDE_OFFICIAL_PROVIDER_ID, OPENAI_OFFICIAL_PROVIDER_ID } from '@/constants/openaiOfficialProvider'
import { GROK_OFFICIAL_PROVIDER_ID } from '@/constants/grokOfficialProvider'
import { DEEPSEEK_ACCOUNT_PROVIDER_ID } from '@/constants/deepseekAccountProvider'
import { groupProviderModels } from '@/lib/providerModels'
import { useHahaOAuthStore } from '@/stores/hahaOAuthStore'
import { useHahaOpenAIOAuthStore } from '@/stores/hahaOpenAIOAuthStore'
import { useHahaGrokOAuthStore } from '@/stores/hahaGrokOAuthStore'
import { useHahaDeepSeekOAuthStore } from '@/stores/hahaDeepSeekOAuthStore'
import { useProviderStore } from '@/stores/providerStore'
import { useSettingsStore } from '@/stores/settingsStore'
import type { ModelMapping } from '@/types/provider'
import { useTranslation, type TranslationKey } from '@/i18n'
import { ModelIdCombobox } from './ModelIdCombobox'
import {
  OfficialModelContextWindows,
  getOfficialContextWindowError,
  toOfficialWindowInfo,
  type OfficialModelWindowInfo,
} from './OfficialModelContextWindows'
import { parseModelContextWindowsInput } from '@/lib/providerModelContext'

type ModelSlot = keyof ModelMapping

const MODEL_SLOTS: ModelSlot[] = ['main', 'fable', 'haiku', 'sonnet', 'opus']

const MODEL_SLOT_LABELS: Record<ModelSlot, TranslationKey> = {
  main: 'settings.providers.mainModel',
  fable: 'settings.providers.fableModel',
  haiku: 'settings.providers.haikuModel',
  sonnet: 'settings.providers.sonnetModel',
  opus: 'settings.providers.opusModel',
}

type OfficialProviderModelSettingsProps = {
  providerId: string
}

/** The mapping as saved: an empty alias follows the main model, an empty Fable slot stays unset. */
function normalizeMapping(models: ModelMapping): ModelMapping {
  const main = models.main.trim()
  return {
    main,
    ...(models.fable?.trim() ? { fable: models.fable.trim() } : {}),
    haiku: models.haiku.trim() || main,
    sonnet: models.sonnet.trim() || main,
    opus: models.opus.trim() || main,
  }
}

const windowsToInputs = (windows: Record<string, number> | undefined): Record<string, string> =>
  Object.fromEntries(Object.entries(windows ?? {}).map(([model, window]) => [model, String(window)]))

function useOfficialAccountKey(providerId: string): string {
  const claude = useHahaOAuthStore((state) => providerId === CLAUDE_OFFICIAL_PROVIDER_ID ? state.status : null)
  const openai = useHahaOpenAIOAuthStore((state) => providerId === OPENAI_OFFICIAL_PROVIDER_ID ? state.status : null)
  const grok = useHahaGrokOAuthStore((state) => providerId === GROK_OFFICIAL_PROVIDER_ID ? state.status : null)
  const deepseek = useHahaDeepSeekOAuthStore((state) => providerId === DEEPSEEK_ACCOUNT_PROVIDER_ID ? state.status : null)
  if (openai?.loggedIn) return JSON.stringify([openai.accountId, openai.email])
  if (grok?.loggedIn) return JSON.stringify(grok.email)
  if (deepseek?.loggedIn) return JSON.stringify([deepseek.contact, deepseek.name])
  if (claude?.loggedIn) return JSON.stringify(claude.subscriptionType)
  return 'logged-out'
}

export function OfficialProviderModelSettings({ providerId }: OfficialProviderModelSettingsProps) {
  const t = useTranslation()
  const accountKey = useOfficialAccountKey(providerId)
  const [models, setModels] = useState<ModelMapping | null>(null)
  const [availableModelIds, setAvailableModelIds] = useState<string[]>([])
  // Only ChatGPT Official runs on a window the user can set; the other
  // accounts take theirs from their own catalogs.
  const supportsContextWindows = providerId === OPENAI_OFFICIAL_PROVIDER_ID
  const [windowInfo, setWindowInfo] = useState<Record<string, OfficialModelWindowInfo>>({})
  const [contextInputs, setContextInputs] = useState<Record<string, string>>({})
  const [savedModelIds, setSavedModelIds] = useState<string[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [catalogError, setCatalogError] = useState(false)
  const [refreshedCount, setRefreshedCount] = useState<number | null>(null)
  const [saved, setSaved] = useState(false)
  const requestGeneration = useRef(0)
  const catalogErrorId = useId()

  useEffect(() => {
    const generation = ++requestGeneration.current
    setModels(null)
    setAvailableModelIds([])
    setWindowInfo({})
    setContextInputs({})
    setSavedModelIds([])
    setIsLoading(true)
    setIsSaving(false)
    setIsRefreshing(false)
    setError(null)
    setCatalogError(false)
    setRefreshedCount(null)
    setSaved(false)

    void Promise.allSettled([
      providersApi.getOfficialModels(providerId),
      modelsApi.catalog(providerId),
    ]).then(([mappingResult, catalogResult]) => {
      if (generation !== requestGeneration.current) return
      if (mappingResult.status === 'fulfilled') {
        setModels(mappingResult.value.models)
        setSavedModelIds(Object.values(mappingResult.value.models))
        setContextInputs(windowsToInputs(mappingResult.value.modelContextWindows))
      } else {
        setError(t('settings.providers.officialModelsLoadError'))
      }
      if (catalogResult.status === 'fulfilled') {
        setAvailableModelIds(catalogResult.value.models.map((model) => model.id))
        setWindowInfo(toOfficialWindowInfo(catalogResult.value.models))
      }
      setIsLoading(false)
    })

    return () => {
      requestGeneration.current += 1
    }
  }, [providerId, accountKey, t])

  const groups = useMemo(
    () => groupProviderModels(
      availableModelIds.map((id) => ({ id })),
      t('settings.providers.officialModelsAvailableGroup'),
    ),
    [availableModelIds, t],
  )

  const updateModel = (slot: ModelSlot, value: string) => {
    setSaved(false)
    setModels((current) => current ? { ...current, [slot]: value } : current)
  }

  const handleRefresh = async () => {
    const generation = requestGeneration.current
    setIsRefreshing(true)
    setCatalogError(false)
    setRefreshedCount(null)
    try {
      const result = await modelsApi.catalog(providerId, { forceRefresh: true })
      if (generation !== requestGeneration.current) return
      if (!result.models.length) throw new Error('Empty model catalog')
      // Reload the active provider through its own endpoint; an inactive card's
      // catalog must never replace the current chat's available models.
      await useSettingsStore.getState().fetchAll()
      if (generation !== requestGeneration.current) return
      setAvailableModelIds(result.models.map((model) => model.id))
      setWindowInfo(toOfficialWindowInfo(result.models))
      setRefreshedCount(result.models.length)
    } catch {
      if (generation === requestGeneration.current) setCatalogError(true)
    } finally {
      if (generation === requestGeneration.current) setIsRefreshing(false)
    }
  }

  // One row per model the mapping uses. A half-typed ID gets no row of its
  // own: only models the account lists, the saved mapping uses, or that
  // already carry a value, so rows do not flicker while the user types.
  const contextRows = useMemo(() => {
    if (!supportsContextWindows || !models) return []
    const mapped = Object.values(normalizeMapping(models)).filter(Boolean)
    return [...new Set(mapped)].filter((id) =>
      windowInfo[id] !== undefined || savedModelIds.includes(id) || contextInputs[id] !== undefined)
  }, [supportsContextWindows, models, windowInfo, savedModelIds, contextInputs])
  const hasContextError = contextRows.some((id) =>
    getOfficialContextWindowError(contextInputs[id] ?? '', windowInfo[id]?.maxContext) !== null)

  const updateContextWindow = (modelId: string, value: string) => {
    setSaved(false)
    setContextInputs((current) => ({ ...current, [modelId]: value }))
  }

  const handleSave = async () => {
    if (!models) return
    if (!models.main.trim()) return
    if (hasContextError) return
    const normalized = normalizeMapping(models)
    // Values for models the mapping no longer shows are kept as saved.
    const windows = supportsContextWindows
      ? Object.fromEntries(Object.entries(contextInputs).flatMap(([model, value]) => {
          const parsed = parseModelContextWindowsInput(value)
          return parsed === undefined ? [] : [[model, parsed] as const]
        }))
      : undefined

    const generation = requestGeneration.current
    setIsSaving(true)
    setError(null)
    setSaved(false)
    try {
      const result = await providersApi.updateOfficialModels(providerId, normalized, windows)
      if (generation !== requestGeneration.current) return
      setModels(result.models)
      setSavedModelIds(Object.values(result.models))
      if (supportsContextWindows) setContextInputs(windowsToInputs(result.modelContextWindows))
      // The model picker reads saved alias mappings from the provider store.
      await Promise.all([
        useSettingsStore.getState().fetchAll(),
        useProviderStore.getState().fetchProviders(),
      ])
      if (generation === requestGeneration.current) setSaved(true)
    } catch {
      if (generation === requestGeneration.current) setError(t('settings.providers.officialModelsSaveError'))
    } finally {
      if (generation === requestGeneration.current) setIsSaving(false)
    }
  }

  return (
    <section className="mt-3 border-t border-[var(--color-border)] pt-3" aria-labelledby={`${providerId}-models-title`}>
      <div className="mb-3">
        <h4 id={`${providerId}-models-title`} className="text-[13px] font-semibold text-[var(--color-text-secondary)]">
          {t('settings.providers.officialModelsTitle')}
        </h4>
        <p className="mt-0.5 text-xs leading-[1.5] text-[var(--color-text-tertiary)]">
          {t('settings.providers.officialModelsDesc')}
        </p>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-xs text-[var(--color-text-tertiary)]">
          <Spinner size={14} />
          {t('common.loading')}
        </div>
      ) : models ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="secondary"
              size="base"
              icon={<RefreshCw size={14} aria-hidden="true" />}
              onClick={handleRefresh}
              loading={isRefreshing}
              aria-describedby={catalogError ? catalogErrorId : undefined}
            >
              {t('settings.providers.officialModelsRefresh')}
            </Button>
            {refreshedCount !== null && (
              <span role="status" className="text-xs text-[var(--color-success)]">
                {t('settings.providers.officialModelsRefreshed', { count: refreshedCount })}
              </span>
            )}
          </div>
          {catalogError && (
            <p id={catalogErrorId} role="alert" className="text-xs text-[var(--color-error)]">
              {t('settings.providers.officialModelsRefreshError')}
            </p>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {MODEL_SLOTS.map((slot) => {
              const label = t(MODEL_SLOT_LABELS[slot])
              return (
                <ModelIdCombobox
                  key={slot}
                  label={label}
                  value={models[slot] ?? ''}
                  onChange={(value) => updateModel(slot, value)}
                  placeholder={slot === 'fable'
                    ? t('settings.providers.fableModelPlaceholder')
                    : t('settings.providers.modelIdPlaceholder')}
                  groups={groups}
                  pickerLabel={t('settings.providers.officialModelsPick', { label })}
                  noMatchesLabel={t('settings.providers.officialModelsNoMatches')}
                  moreResultsLabel={t('settings.providers.fetchModelsMoreResults')}
                  required={slot === 'main'}
                />
              )
            })}
          </div>

          {supportsContextWindows && (
            <OfficialModelContextWindows
              modelIds={contextRows}
              values={contextInputs}
              info={windowInfo}
              onChange={updateContextWindow}
            />
          )}

          <div className="flex items-center gap-3">
            <Button
              size="base"
              onClick={handleSave}
              loading={isSaving}
              disabled={!models.main.trim() || hasContextError}
            >
              {t('settings.providers.officialModelsSave')}
            </Button>
            {saved && (
              <span role="status" className="text-xs text-[var(--color-success)]">
                {t('settings.providers.officialModelsSaved')}
              </span>
            )}
          </div>
        </div>
      ) : null}

      {error && (
        <p role="alert" className="mt-2 text-xs text-[var(--color-error)]">
          {error}
        </p>
      )}
    </section>
  )
}
