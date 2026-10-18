import { useState } from 'react'
import { SettingsBlock } from '@/components/settings/SettingsSection'
import { Switch } from '@/components/ui/Switch'
import { useTranslation } from '@/i18n'
import { useSettingsStore } from '@/stores/settingsStore'

export function LeanModeSettings() {
  const t = useTranslation()
  const enabled = useSettingsStore(state => state.leanModeEnabled)
  const setEnabled = useSettingsStore(state => state.setLeanModeEnabled)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)

  async function changeEnabled(next: boolean) {
    setFailed(false)
    setSaving(true)
    try {
      await setEnabled(next)
    } catch {
      setFailed(true)
    } finally {
      setSaving(false)
    }
  }

  return (
    <SettingsBlock>
      <Switch
        label={t('settings.general.leanModeEnabled')}
        checked={enabled}
        disabled={saving}
        onChange={next => void changeEnabled(next)}
        description={(
          <span className="block max-w-[68ch] space-y-1 leading-relaxed">
            <span className="block" role="status" aria-live="polite">
              {t(saving ? 'settings.general.leanModeSaving' : enabled ? 'settings.general.leanModeOn' : 'settings.general.leanModeOff')}
            </span>
            <span className="block text-[var(--color-text-tertiary)]">
              {t('settings.general.leanModeDescription')}
            </span>
            {failed && (
              <span role="alert" className="block text-[var(--color-error)]">
                {t('settings.general.leanModeSaveFailed')}
              </span>
            )}
          </span>
        )}
      />
    </SettingsBlock>
  )
}
