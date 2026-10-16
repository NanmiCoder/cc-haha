import {
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  SettingsSwitchRow,
} from '@/components/settings/SettingsSection'
import { SelectField } from '@/components/ui/SelectField'
import { useTranslation } from '@/i18n'
import { SESSION_TAB_LIMIT_OPTIONS, type SessionTabLimit } from '@/lib/tabBehavior'
import { useTabBehaviorStore } from '@/stores/tabBehaviorStore'

const UNLIMITED = 'unlimited'

export function TabBehaviorSettings() {
  const t = useTranslation()
  const behavior = useTabBehaviorStore((s) => s.behavior)
  const setBehavior = useTabBehaviorStore((s) => s.setBehavior)

  return (
    <SettingsSection title={t('settings.tabs.title')} description={t('settings.tabs.description')}>
      <SettingsGroup>
        <SettingsRow
          title={t('settings.tabs.limit')}
          description={t('settings.tabs.limitHint')}
          layout="inline"
        >
          <SelectField
            label={t('settings.tabs.limit')}
            labelHidden
            size="md"
            className="w-auto min-w-[120px]"
            value={behavior.sessionTabLimit === null ? UNLIMITED : String(behavior.sessionTabLimit)}
            options={[
              { value: UNLIMITED, label: t('settings.tabs.limitUnlimited') },
              ...SESSION_TAB_LIMIT_OPTIONS.map((count) => ({
                value: String(count),
                label: t('settings.tabs.limitCount', { count }),
              })),
            ]}
            onChange={(value) => setBehavior({
              sessionTabLimit: value === UNLIMITED ? null : Number(value) as SessionTabLimit,
            })}
          />
        </SettingsRow>
        <SettingsSwitchRow
          title={t('settings.tabs.restoreOnLaunch')}
          description={behavior.restoreOnLaunch
            ? t('settings.tabs.restoreOnLaunchHintOn')
            : t('settings.tabs.restoreOnLaunchHintOff')}
          checked={behavior.restoreOnLaunch}
          onChange={(restoreOnLaunch) => setBehavior({ restoreOnLaunch })}
        />
      </SettingsGroup>
    </SettingsSection>
  )
}
