import { Input } from '@/components/ui/Input'
import { SettingsBlock, SettingsGroup, SettingsSwitchRow } from '@/components/settings/SettingsSection'
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
    <SettingsGroup>
      <SettingsSwitchRow
        title={t('settings.providers.imageGenerationEnabled')}
        description={t('settings.providers.imageGenerationEnabledDesc')}
        checked={value.enabled}
        onChange={(enabled) => update({ enabled })}
      />

      {value.enabled ? (
        <SettingsBlock className="grid gap-3 sm:grid-cols-2">
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
        </SettingsBlock>
      ) : null}
    </SettingsGroup>
  )
}
