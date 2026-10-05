import { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, Lock, Server, Unplug } from 'lucide-react'
import { useTranslation, type TranslationKey } from '@/i18n'
import { useUIStore } from '@/stores/uiStore'
import { useProviderStore } from '@/stores/providerStore'
import { SettingsGroup, SettingsRow, SettingsSection } from '@/components/settings/SettingsSection'
import { Button } from '@/components/ui/Button'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { clearStoredH5Connection, getServerBaseUrl } from '@/lib/desktopRuntime'
import { ProviderSettings } from './ProviderSettings'
import { H5GeneralSettings } from './H5GeneralSettings'

/**
 * The settings a computer keeps that a phone can see but not change: they
 * touch the computer itself (its MCP servers, its screen, its H5 door), so the
 * server only lets the computer edit them. Listing them says they exist and
 * where to change them, instead of leaving the phone unaware of them.
 */
const DESKTOP_ONLY_SETTINGS: TranslationKey[] = [
  'settings.tab.h5Access',
  'settings.tab.mcp',
  'settings.tab.skills',
  'settings.tab.plugins',
  'settings.tab.agents',
  'settings.tab.memory',
  'settings.tab.adapters',
  'settings.tab.computerUse',
  'settings.tab.voice',
]

/**
 * Settings on a phone or tablet: one grouped list, everything visible. Which
 * computer this is connected to sits on top (with a way to disconnect), the
 * model provider opens its own page, the preferences a phone may change
 * follow, and the computer-only ones close the list, read-only.
 */
export function H5Settings() {
  const t = useTranslation()
  const pending = useUIStore((state) => state.pendingSettingsTab)
  const providerName = useProviderStore((state) => (
    state.providers.find((provider) => provider.id === state.activeId)?.name ?? null
  ))
  const fetchProviders = useProviderStore((state) => state.fetchProviders)
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  // Settings always opens on the list. The provider page is a step into it,
  // kept here rather than in the remembered settings tab, so coming back to
  // Settings later starts from the list again. A link asking for the providers
  // page (no provider configured yet) still lands there.
  const [showingProviders, setShowingProviders] = useState(pending === 'providers')

  useEffect(() => {
    if (!pending) return
    setShowingProviders(pending === 'providers')
    useUIStore.getState().setPendingSettingsTab(null)
  }, [pending])

  useEffect(() => {
    void fetchProviders().catch(() => undefined)
  }, [fetchProviders])

  const openList = () => setShowingProviders(false)

  if (showingProviders) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--color-surface)]">
        <div className="shrink-0 border-b border-[var(--color-border)] px-1 py-1">
          <Button
            variant="ghost"
            size="lg"
            icon={<ChevronLeft size={18} strokeWidth={1.75} aria-hidden="true" />}
            onClick={openList}
          >
            {t('h5Settings.allSettings')}
          </Button>
        </div>
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-5">
          <ProviderSettings browserMode />
        </div>
      </div>
    )
  }

  const host = (() => {
    try {
      return new URL(getServerBaseUrl()).host
    } catch {
      return getServerBaseUrl()
    }
  })()

  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden bg-[var(--color-surface)] px-4 py-5">
      <SettingsSection className="mt-0" title={t('h5Settings.connection')}>
        <SettingsGroup>
          <SettingsRow title={t('h5Settings.connectedTo')} description={<span className="font-mono">{host}</span>}>
            <Button
              variant="danger-ghost"
              size="md"
              icon={<Unplug size={16} strokeWidth={1.75} aria-hidden="true" />}
              onClick={() => setConfirmDisconnect(true)}
            >
              {t('h5Settings.disconnect')}
            </Button>
          </SettingsRow>
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title={t('settings.tab.providers')}>
        <SettingsGroup>
          <button
            type="button"
            data-testid="h5-settings-providers"
            onClick={() => setShowingProviders(true)}
            className="flex min-h-12 w-full items-center gap-3 px-4 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-border-focus)] active:bg-[var(--color-surface-hover)]"
          >
            <Server size={18} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-[var(--color-text-secondary)]" />
            <span className="min-w-0 flex-1 truncate text-[14px] text-[var(--color-text-primary)]">{t('h5Settings.activeProvider')}</span>
            <span className="max-w-[45%] truncate text-[13px] text-[var(--color-text-tertiary)]">{providerName ?? ''}</span>
            <ChevronRight size={16} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-[var(--color-text-tertiary)]" />
          </button>
        </SettingsGroup>
      </SettingsSection>

      <H5GeneralSettings />

      <SettingsSection title={t('h5Settings.desktopOnly')} description={t('h5Settings.desktopOnlyHint')}>
        <SettingsGroup data-testid="h5-settings-desktop-only">
          {DESKTOP_ONLY_SETTINGS.map((key) => (
            <div key={key} className="flex min-h-11 items-center gap-3 px-4 text-[14px] text-[var(--color-text-tertiary)]">
              <span className="min-w-0 flex-1 truncate">{t(key)}</span>
              <Lock size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
            </div>
          ))}
        </SettingsGroup>
      </SettingsSection>

      <ConfirmDialog
        open={confirmDisconnect}
        onClose={() => setConfirmDisconnect(false)}
        onConfirm={() => {
          clearStoredH5Connection()
          window.location.reload()
        }}
        title={t('h5Settings.disconnect')}
        body={t('h5Settings.disconnectBody')}
        confirmLabel={t('h5Settings.disconnect')}
        cancelLabel={t('common.cancel')}
        confirmVariant="danger"
      />
    </div>
  )
}
