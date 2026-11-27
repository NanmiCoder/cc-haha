import { useEffect } from 'react'
import { PanelTop } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import {
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  SettingsSwitchRow,
} from '@/components/settings/SettingsSection'
import type { UsageDisplayMode } from '@/api/desktopUiPreferences'
import { useTranslation } from '@/i18n'
import { getDesktopHost } from '@/lib/desktopHost'
import { useUsageSummaryStore } from '@/stores/usageSummaryStore'

export function UsageWidgetSettings() {
  const t = useTranslation()
  const host = getDesktopHost()
  const preferences = useUsageSummaryStore((s) => s.preferences)
  const preferencesLoaded = useUsageSummaryStore((s) => s.preferencesLoaded)
  const hydratePreferences = useUsageSummaryStore((s) => s.hydratePreferences)
  const updatePreferences = useUsageSummaryStore((s) => s.updatePreferences)
  const snapFloatingToTop = useUsageSummaryStore((s) => s.snapFloatingToTop)

  useEffect(() => {
    if (!host.isDesktop || preferencesLoaded) return
    void hydratePreferences()
  }, [host.isDesktop, hydratePreferences, preferencesLoaded])

  if (!host.isDesktop) return null

  return (
    <SettingsSection title={t('usageWidget.settingsTitle')}>
      <SettingsGroup>
        <SettingsRow
          title={t('usageWidget.settingsDisplayModeTitle')}
          description={t('usageWidget.settingsDisplayModeDesc')}
        >
          <SegmentedControl<UsageDisplayMode>
            size="sm"
            label={t('usageWidget.settingsDisplayModeTitle')}
            value={preferences.displayMode}
            onChange={(value) => void updatePreferences({ displayMode: value })}
            items={[
              { value: 'remaining', label: t('usageWidget.displayModeRemaining') },
              { value: 'used', label: t('usageWidget.displayModeUsed') },
            ]}
          />
        </SettingsRow>

        <SettingsSwitchRow
          title={t('usageWidget.settingsFloatingTitle')}
          description={t('usageWidget.settingsFloatingDesc')}
          checked={preferences.floatingEnabled}
          onChange={(enabled) => void updatePreferences({ floatingEnabled: enabled })}
        />

        <SettingsRow
          title={t('usageWidget.settingsSnapTopTitle')}
          description={t('usageWidget.settingsSnapTopDesc')}
        >
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void snapFloatingToTop()}
            icon={<PanelTop size={13} strokeWidth={1.75} aria-hidden="true" />}
          >
            {t('usageWidget.snapTopButton')}
          </Button>
        </SettingsRow>

        <SettingsSwitchRow
          title={t('usageWidget.settingsMenuBarTitle')}
          description={t('usageWidget.settingsMenuBarDesc')}
          checked={preferences.menuBarEnabled}
          onChange={(enabled) => void updatePreferences({ menuBarEnabled: enabled })}
        />
      </SettingsGroup>
    </SettingsSection>
  )
}
