import { useEffect } from 'react'
import { useTranslation } from '@/i18n'
import { useUIStore } from '@/stores/uiStore'
import { SettingsPill } from '@/components/settings/SettingsSection'
import { ProviderSettings } from './ProviderSettings'
import { H5GeneralSettings } from './H5GeneralSettings'

export function H5Settings() {
  const t = useTranslation()
  const active = useUIStore((state) => state.activeSettingsTab)
  const pending = useUIStore((state) => state.pendingSettingsTab)
  const selected = (pending ?? active) === 'general' ? 'general' : 'providers'
  useEffect(() => {
    useUIStore.getState().setActiveSettingsTab(selected)
    if (pending) useUIStore.getState().setPendingSettingsTab(null)
  }, [pending, selected])
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--color-surface)]">
    <nav aria-label={t('sidebar.settings')} className="flex shrink-0 [&_button]:min-h-11 flex-wrap gap-2 border-b border-[var(--color-border)] p-3">
      <SettingsPill selected={selected === 'providers'} onClick={() => useUIStore.getState().setActiveSettingsTab('providers')}>{t('settings.tab.providers')}</SettingsPill>
      <SettingsPill selected={selected === 'general'} onClick={() => useUIStore.getState().setActiveSettingsTab('general')}>{t('settings.tab.general')}</SettingsPill>
    </nav>
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-5 sm:px-6">
      <p className="mb-5 text-xs leading-5 text-[var(--color-text-tertiary)]">{t('h5Settings.scope')}</p>
      {selected === 'providers' ? <ProviderSettings browserMode /> : <H5GeneralSettings />}
    </div>
  </div>
}
