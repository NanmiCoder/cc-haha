import { useId, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { SelectField } from '@/components/ui/SelectField'
import { useTranslation } from '@/i18n'
import { compatibilityForm, invalidCompatibilityNumber, type RequestCompatibilityForm } from '@/lib/providerRequestCompatibility'
import type { ApiFormat, RequestCompatibility } from '@/types/provider'

export function ProviderRequestCompatibilityFields({ value, apiFormat, onChange }: {
  value: RequestCompatibilityForm
  apiFormat: ApiFormat
  onChange: (value: RequestCompatibilityForm) => void
}) {
  const t = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const detailsId = useId()
  const capabilityOptions = [
    { value: 'auto' as const, label: t('settings.providers.compatibilityAuto') },
    { value: 'supported' as const, label: t('settings.providers.compatibilitySupported') },
    { value: 'unsupported' as const, label: t('settings.providers.compatibilityUnsupported') },
  ]
  const capabilities = [
    ['sampling', 'settings.providers.compatibilitySampling'],
    ['reasoning', 'settings.providers.compatibilityReasoning'],
    ['parallelTools', 'settings.providers.compatibilityParallelTools'],
    ['structuredOutput', 'settings.providers.compatibilityStructuredOutput'],
  ] as const
  const updateOption = <K extends keyof RequestCompatibility>(key: K, next: RequestCompatibility[K]) => {
    const options = { ...value.options }
    if (next === 'auto') delete options[key]
    else options[key] = next
    onChange({ ...value, options })
  }
  if (apiFormat === 'anthropic') return null
  return (
    <section className="space-y-3 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] p-3">
      <Input
        label={t('settings.providers.compatibilityBudget')}
        value={value.maxOutputTokens}
        inputMode="numeric"
        onChange={event => onChange({ ...value, maxOutputTokens: event.target.value })}
        placeholder={t('settings.providers.compatibilityAuto')}
        hint={t('settings.providers.compatibilityBudgetHint')}
        error={invalidCompatibilityNumber(value.maxOutputTokens) ? t('settings.providers.compatibilityNumberError') : undefined}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="ghost" size="sm" aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpanded(!expanded)}>
          {t('settings.providers.compatibilityAdvanced')}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => onChange(compatibilityForm())}>
          {t('settings.providers.compatibilityReset')}
        </Button>
      </div>
      {expanded && <div id={detailsId} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Input
          label={t('settings.providers.compatibilityLimit')}
          value={value.outputTokenLimit}
          inputMode="numeric"
          onChange={event => onChange({ ...value, outputTokenLimit: event.target.value })}
          placeholder={t('settings.providers.compatibilityUnknown')}
          hint={t('settings.providers.compatibilityLimitHint')}
          error={invalidCompatibilityNumber(value.outputTokenLimit) ? t('settings.providers.compatibilityNumberError') : undefined}
        />
        {apiFormat === 'openai_chat' && <SelectField<NonNullable<RequestCompatibility['outputTokenField']>>
          label={t('settings.providers.compatibilityTokenField')}
          value={value.options.outputTokenField ?? 'auto'}
          onChange={next => updateOption('outputTokenField', next)}
          options={[
            { value: 'auto', label: t('settings.providers.compatibilityAuto') },
            { value: 'max_tokens', label: 'max_tokens' },
            { value: 'max_completion_tokens', label: 'max_completion_tokens' },
            { value: 'omit', label: t('settings.providers.compatibilityOmit') },
          ]}
        />}
        {capabilities.map(([key, label]) => <SelectField
          key={key}
          label={t(label)}
          value={value.options[key] ?? 'auto'}
          options={capabilityOptions}
          onChange={next => updateOption(key, next)}
        />)}
      </div>}
    </section>
  )
}
