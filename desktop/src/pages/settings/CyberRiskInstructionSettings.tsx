import { useState } from 'react'
import { SettingsBlock } from '@/components/settings/SettingsSection'
import { Switch } from '@/components/ui/Switch'
import { useTranslation } from '@/i18n'
import { useSettingsStore } from '@/stores/settingsStore'

export function CyberRiskInstructionSettings() {
  const t = useTranslation()
  const included = useSettingsStore(state => state.includeCyberRiskInstruction)
  const setIncluded = useSettingsStore(state => state.setIncludeCyberRiskInstruction)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)

  const omittedForThirdParty = !included

  async function changeOmitted(nextOmitted: boolean) {
    setFailed(false)
    setSaving(true)
    try {
      await setIncluded(!nextOmitted)
    } catch {
      setFailed(true)
    } finally {
      setSaving(false)
    }
  }

  return (
    <SettingsBlock>
      <Switch
        label={t('settings.general.omitCyberRiskPromptEnabled')}
        checked={omittedForThirdParty}
        disabled={saving}
        onChange={next => void changeOmitted(next)}
        description={(
          <span className="block max-w-[68ch] space-y-1 leading-relaxed">
            <span className="block" role="status" aria-live="polite">
              {t(saving
                ? 'settings.general.omitCyberRiskPromptSaving'
                : omittedForThirdParty
                  ? 'settings.general.omitCyberRiskPromptOn'
                  : 'settings.general.omitCyberRiskPromptOff')}
            </span>
            <span className="block text-[var(--color-text-tertiary)]">
              {t('settings.general.omitCyberRiskPromptDescription')}
            </span>
            {failed && (
              <span role="alert" className="block text-[var(--color-error)]">
                {t('settings.general.omitCyberRiskPromptSaveFailed')}
              </span>
            )}
          </span>
        )}
      />
    </SettingsBlock>
  )
}
