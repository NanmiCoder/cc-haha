import { useEffect, useId } from 'react'
import { RotateCw } from 'lucide-react'
import { SettingsGroup, SettingsRow, SettingsSection } from '@/components/settings/SettingsSection'
import { Button } from '@/components/ui/Button'
import { SelectField } from '@/components/ui/SelectField'
import { useTranslation } from '@/i18n'
import { getDesktopHost } from '@/lib/desktopHost'
import { DEFAULT_IDLE_POWER_SETTINGS, IDLE_POWER_ACTIONS, type IdlePowerSettings as PowerSettings } from '@/lib/idlePower'
import { useIdlePowerStore } from '@/stores/idlePowerStore'

export function IdlePowerSettings() {
  const t = useTranslation()
  const errorId = useId()
  const { snapshot, loading, saving, error, refresh, configure } = useIdlePowerStore()
  const desktop = getDesktopHost().isDesktop
  useEffect(() => {
    if (desktop) void refresh().catch(() => {})
  }, [desktop, refresh])
  if (!desktop) return null

  const settings = snapshot?.settings ?? DEFAULT_IDLE_POWER_SETTINGS
  const disabled = loading || saving || !snapshot
  const unavailable = snapshot && settings.action !== 'none' && !snapshot.capabilities[settings.action]
  const errorText = error === 'save'
    ? t('settings.general.idlePowerSaveFailed')
    : error === 'load' ? t('settings.general.idlePowerLoadFailed') : null
  function save(patch: Partial<PowerSettings>) {
    if (!disabled) void configure({ ...settings, ...patch }).catch(() => {})
  }

  return (
    <SettingsSection
      title={t('settings.general.idlePowerTitle')}
      description={t('settings.general.idlePowerDescription')}
      action={(
        <Button
          variant="ghost"
          size="sm"
          icon={<RotateCw size={14} strokeWidth={1.75} aria-hidden="true" />}
          loading={loading}
          disabled={saving}
          onClick={() => void refresh().catch(() => {})}
        >
          {t('settings.general.idlePowerRefresh')}
        </Button>
      )}
    >
      <SettingsGroup>
        <SettingsRow title={t('settings.general.idlePowerAction')}>
          <SelectField<PowerSettings['action']>
            label={t('settings.general.idlePowerAction')}
            labelHidden
            size="md"
            value={settings.action}
            disabled={disabled}
            aria-describedby={errorText ? errorId : undefined}
            options={[
              { value: 'none', label: t('power.action.none') },
              ...IDLE_POWER_ACTIONS.map(action => ({
                value: action,
                label: snapshot?.capabilities[action]
                  ? t(`power.action.${action}`)
                  : t('settings.general.idlePowerUnavailableOption', { action: t(`power.action.${action}`) }),
                disabled: !snapshot?.capabilities[action],
              })),
            ]}
            onChange={action => {
              if (action === 'none' || snapshot?.capabilities[action]) save({ action })
            }}
          />
        </SettingsRow>
        <SettingsRow title={t('settings.general.idlePowerScope')} description={t('settings.general.idlePowerScopeDescription')}>
          <SelectField<PowerSettings['scope']>
            label={t('settings.general.idlePowerScope')}
            labelHidden
            size="md"
            value={settings.scope}
            disabled={disabled || settings.action === 'none'}
            aria-describedby={errorText ? errorId : undefined}
            options={[
              { value: 'any', label: t('settings.general.idlePowerScopeAny') },
              { value: 'scheduled', label: t('settings.general.idlePowerScopeScheduled') },
            ]}
            onChange={scope => save({ scope })}
          />
        </SettingsRow>
        <SettingsRow title={t('settings.general.idlePowerCountdown')} description={t('settings.general.idlePowerCountdownDescription')}>
          <SelectField
            label={t('settings.general.idlePowerCountdown')}
            labelHidden
            size="md"
            value={String(settings.countdownSeconds)}
            disabled={disabled || settings.action === 'none'}
            aria-describedby={errorText ? errorId : undefined}
            options={([0, 30, 60, 300] as const).map(seconds => ({
              value: String(seconds), label: t(`settings.general.idlePowerCountdown.${seconds}`),
            }))}
            onChange={seconds => save({ countdownSeconds: Number(seconds) as PowerSettings['countdownSeconds'] })}
          />
        </SettingsRow>
      </SettingsGroup>
      {unavailable && <p className="mt-2 text-xs text-[var(--color-text-secondary)]">{t('settings.general.idlePowerUnavailable')}</p>}
      {errorText && <p id={errorId} role="alert" className="mt-2 text-xs text-[var(--color-error)]">{errorText}</p>}
    </SettingsSection>
  )
}
