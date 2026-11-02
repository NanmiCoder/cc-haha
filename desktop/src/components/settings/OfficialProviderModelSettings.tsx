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
      } else {
        setError(t('settings.providers.officialModelsLoadError'))
      }
      if (catalogResult.status === 'fulfilled') {
        setAvailableModelIds(catalogResult.value.models.map((model) => model.id))
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
      setRefreshedCount(result.models.length)
    } catch {
      if (generation === requestGeneration.current) setCatalogError(true)
    } finally {
      if (generation === requestGeneration.current) setIsRefreshing(false)
    }
  }

  const handleSave = async () => {
    if (!models) return
    const main = models.main.trim()
    if (!main) return
    const normalized: ModelMapping = {
      main,
      ...(models.fable?.trim() ? { fable: models.fable.trim() } : {}),
      haiku: models.haiku.trim() || main,
      sonnet: models.sonnet.trim() || main,
      opus: models.opus.trim() || main,
    }

    const generation = requestGeneration.current
    setIsSaving(true)
    setError(null)
    setSaved(false)
    try {
      const result = await providersApi.updateOfficialModels(providerId, normalized)
      if (generation !== requestGeneration.current) return
      setModels(result.models)
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

          <div className="flex items-center gap-3">
            <Button
              size="base"
              onClick={handleSave}
              loading={isSaving}
              disabled={!models.main.trim()}
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
