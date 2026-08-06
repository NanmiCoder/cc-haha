import { Input } from '@/components/ui/Input'
import { Switch } from '@/components/ui/Switch'
import { useTranslation } from '@/i18n'

export type ImageGenerationFormValue = {
  enabled: boolean
  model: string
  baseUrl: string
  apiKey: string
}

type Props = {
  value: ImageGenerationFormValue
  onChange: (value: ImageGenerationFormValue) => void
}

export function ProviderImageGenerationFields({ value, onChange }: Props) {
  const t = useTranslation()
  const update = (patch: Partial<ImageGenerationFormValue>) => {
    onChange({ ...value, ...patch })
  }

  return (
    <div className="overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)]">
      <div className="px-3 py-3">
        <Switch
          checked={value.enabled}
          onChange={(enabled) => update({ enabled })}
          label={t('settings.providers.imageGenerationEnabled')}
          description={t('settings.providers.imageGenerationEnabledDesc')}
          size="sm"
        />
      </div>

      {value.enabled ? (
        <div className="grid gap-3 border-t border-[var(--color-border)] px-3 py-3 sm:grid-cols-2">
          <Input
            label={t('settings.providers.imageGenerationModel')}
            required
            value={value.model}
            onChange={(event) => update({ model: event.target.value })}
            placeholder={t('settings.providers.imageGenerationModelPlaceholder')}
            hint={t('settings.providers.imageGenerationModelHint')}
            className="font-mono text-[13px]"
            containerClassName="sm:col-span-2"
          />
          <Input
            label={t('settings.providers.imageGenerationBaseUrl')}
            value={value.baseUrl}
            onChange={(event) => update({ baseUrl: event.target.value })}
            placeholder={t('settings.providers.imageGenerationBaseUrlPlaceholder')}
            hint={t('settings.providers.imageGenerationBaseUrlHint')}
            className="font-mono text-[13px]"
          />
          <Input
            type="password"
            autoComplete="new-password"
            label={t('settings.providers.imageGenerationApiKey')}
            value={value.apiKey}
            onChange={(event) => update({ apiKey: event.target.value })}
            placeholder="sk-..."
            hint={t('settings.providers.imageGenerationApiKeyHint')}
            className="font-mono text-[13px]"
          />
        </div>
      ) : null}
    </div>
  )
}
