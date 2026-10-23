import type { SessionUltracodeState } from '@/api/sessions'
import { Switch } from '@/components/ui/Switch'
import { ErrorState } from '@/components/ui/ErrorState'
import { useTranslation } from '@/i18n'

type Props = {
  state: SessionUltracodeState | null
  pending: boolean
  error: string | null
  modelSupported: boolean
  onChange(enabled: boolean): void
}

export function UltracodeControl({ state, pending, error, modelSupported, onChange }: Props) {
  const t = useTranslation()
  const reason = !modelSupported ? 'model' : state?.reason
  const unavailable = reason === 'model' ? t('model.ultracodeUnavailableModel')
    : reason === 'workflows-disabled' ? t('model.ultracodeWorkflowsDisabled')
      : reason === 'session' ? t('model.ultracodeUnavailableSession') : undefined
  return (
    <div className="space-y-2 border-t border-[var(--color-border)] px-2 py-2">
      <Switch
        size="sm"
        label={t('model.ultracode')}
        checked={state?.enabled === true}
        disabled={pending || (!state?.enabled && Boolean(unavailable)) || !state}
        onChange={onChange}
        description={unavailable || t('model.ultracodeDescription')}
      />
      {state?.envOverride && <p className="text-xs text-[var(--color-text-secondary)]">{t('model.ultracodeEnvOverride', { value: state.envOverride })}</p>}
      {error && <ErrorState size="sm" title={t('model.ultracodeError')} detail={error} />}
    </div>
  )
}
