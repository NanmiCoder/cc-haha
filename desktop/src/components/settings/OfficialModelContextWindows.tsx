import { useId } from 'react'

import { Input } from '@/components/ui/Input'
import { useTranslation } from '@/i18n'
import { getModelContextWindowErrorKey, parseModelContextWindowsInput } from '@/lib/providerModelContext'
import type { ModelInfo } from '@/types/settings'

/** What the account's catalog says about one model's window, in tokens. */
export type OfficialModelWindowInfo = { context?: number; maxContext?: number }

/** Why a typed window cannot be saved, or null when it is fine. An empty field means the default applies. */
export function getOfficialContextWindowError(
  value: string,
  max?: number,
): 'number' | 'range' | 'max' | null {
  const invalid = getModelContextWindowErrorKey(value)
  if (invalid) return invalid
  const parsed = parseModelContextWindowsInput(value)
  return parsed !== undefined && max !== undefined && parsed > max ? 'max' : null
}

function positiveNumber(value: string | undefined): number | undefined {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

export function toOfficialWindowInfo(models: ModelInfo[]): Record<string, OfficialModelWindowInfo> {
  return Object.fromEntries(models.map((model) => [
    model.id,
    { context: positiveNumber(model.context), maxContext: positiveNumber(model.maxContext) },
  ]))
}

function formatTokens(value: number): string {
  return value.toLocaleString('en-US')
}

type OfficialModelContextWindowsProps = {
  modelIds: string[]
  /** What the user typed, by model id. */
  values: Record<string, string>
  info: Record<string, OfficialModelWindowInfo>
  onChange: (modelId: string, value: string) => void
}

/** One optional window field per mapped model; an empty field keeps the model's default. */
export function OfficialModelContextWindows({
  modelIds,
  values,
  info,
  onChange,
}: OfficialModelContextWindowsProps) {
  const t = useTranslation()
  const titleId = useId()
  if (modelIds.length === 0) return null

  return (
    <div role="group" aria-labelledby={titleId} className="flex flex-col gap-3">
      <div>
        <h5 id={titleId} className="text-[13px] font-semibold text-[var(--color-text-secondary)]">
          {t('settings.providers.officialContextTitle')}
        </h5>
        <p className="mt-0.5 text-xs leading-[1.5] text-[var(--color-text-tertiary)]">
          {t('settings.providers.officialContextDesc')}
        </p>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {modelIds.map((modelId) => {
          const { context, maxContext } = info[modelId] ?? {}
          const value = values[modelId] ?? ''
          const errorKey = getOfficialContextWindowError(value, maxContext)
          const tokens = { default: context === undefined ? '' : formatTokens(context), max: maxContext === undefined ? '' : formatTokens(maxContext) }
          const hint = context !== undefined && maxContext !== undefined
            ? t('settings.providers.officialContextHintBoth', tokens)
            : context !== undefined
              ? t('settings.providers.officialContextHintDefault', tokens)
              : maxContext !== undefined
                ? t('settings.providers.officialContextHintMax', tokens)
                : undefined
          return (
            <Input
              key={modelId}
              label={modelId}
              size="lg"
              inputMode="numeric"
              value={value}
              placeholder={context === undefined ? '' : formatTokens(context)}
              onChange={(event) => onChange(modelId, event.target.value)}
              hint={hint}
              error={errorKey === null
                ? undefined
                : errorKey === 'number'
                  ? t('settings.providers.modelContextWindowNumberError')
                  : errorKey === 'range'
                    ? t('settings.providers.modelContextWindowRangeError')
                    : t('settings.providers.officialContextOverMax', tokens)}
            />
          )
        })}
      </div>
    </div>
  )
}
