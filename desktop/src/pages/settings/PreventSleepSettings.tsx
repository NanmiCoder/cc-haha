import { SettingsGroup, SettingsSection, SettingsSwitchRow } from '@/components/settings/SettingsSection'
import { useTranslation } from '@/i18n'
import { getDesktopHost } from '@/lib/desktopHost'
import { usePowerSettingsStore } from '@/stores/powerSettingsStore'

export function PreventSleepSettings() {
  const t = useTranslation()
  const { preventSleepWhileRunning, saving, error, setPreventSleepWhileRunning } = usePowerSettingsStore()
  if (!getDesktopHost().isDesktop) return null

  return (
    <SettingsSection title={t('settings.general.preventSleepTitle')}>
      <SettingsGroup>
        <SettingsSwitchRow
          title={t('settings.general.preventSleepEnabled')}
          description={t('settings.general.preventSleepDescription')}
          checked={preventSleepWhileRunning}
          disabled={saving}
          onChange={enabled => void setPreventSleepWhileRunning(enabled).catch(() => {})}
        />
      </SettingsGroup>
      {error && <p role="alert" className="mt-2 text-xs text-[var(--color-error)]">{t('settings.general.preventSleepSaveFailed')}</p>}
    </SettingsSection>
  )
}
