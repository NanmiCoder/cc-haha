import { useEffect, useMemo, useState } from 'react'

import { providersApi } from '@/api/providers'
import { modelsApi } from '@/api/models'
import { Button } from '@/components/ui/Button'
import { Spinner } from '@/components/ui/Spinner'
import { groupProviderModels } from '@/lib/providerModels'
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

export function OfficialProviderModelSettings({ providerId }: OfficialProviderModelSettingsProps) {
  const t = useTranslation()
  const [models, setModels] = useState<ModelMapping | null>(null)
  const [availableModelIds, setAvailableModelIds] = useState<string[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let cancelled = false
    setIsLoading(true)
    setError(null)

    void Promise.allSettled([
      providersApi.getOfficialModels(providerId),
      modelsApi.list(),
    ]).then(([mappingResult, catalogResult]) => {
      if (cancelled) return
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
      cancelled = true
    }
  }, [providerId, t])

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

    setIsSaving(true)
    setError(null)
    setSaved(false)
    try {
      const result = await providersApi.updateOfficialModels(providerId, normalized)
      setModels(result.models)
      await useSettingsStore.getState().fetchAll()
      setSaved(true)
    } catch {
      setError(t('settings.providers.officialModelsSaveError'))
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <section className="mt-3 border-t border-[var(--color-border-separator)] pt-3" aria-labelledby={`${providerId}-models-title`}>
      <div className="mb-3">
        <h4 id={`${providerId}-models-title`} className="text-sm font-semibold text-[var(--color-text-primary)]">
          {t('settings.providers.officialModelsTitle')}
        </h4>
        <p className="mt-1 text-xs text-[var(--color-text-tertiary)]">
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
              size="sm"
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
