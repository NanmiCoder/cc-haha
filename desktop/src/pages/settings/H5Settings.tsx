import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, Lock, Server, Unplug, UserRound } from 'lucide-react'
import { useTranslation, type TranslationKey } from '@/i18n'
import { useUIStore } from '@/stores/uiStore'
import { useProviderStore } from '@/stores/providerStore'
import { SettingsGroup, SettingsRow, SettingsSection } from '@/components/settings/SettingsSection'
import { Button } from '@/components/ui/Button'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { clearStoredH5Connection, getServerBaseUrl } from '@/lib/desktopRuntime'
import { ProviderSettings } from './ProviderSettings'
import { H5GeneralSettings } from './H5GeneralSettings'
import { ActivitySettings } from '../ActivitySettings'

export type H5SettingsSubpage = 'providers' | 'activity' | null

export type H5SettingsShellBridge = {
  subpage: H5SettingsSubpage
  setSubpage: (page: H5SettingsSubpage) => void
}

/**
 * Provided by `MobileShell` so settings subpages (`providers` / `activity`)
 * share the shell's single `MobileTopBar` and system back stack instead of
 * stacking a second back bar underneath it.
 */
export const H5SettingsShellContext = createContext<H5SettingsShellBridge | null>(null)

const detailPage = (tab: string | null): H5SettingsSubpage => tab === 'providers' || tab === 'activity' ? tab : null

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
  'settings.tab.browserUse',
  'settings.tab.computerUse',
  'settings.tab.voice',
]

/**
 * Settings on a phone or tablet: one grouped list, everything visible. Which
 * computer this is connected to sits on top (with a way to disconnect), the
 * model provider opens its own page, the preferences a phone may change
 * follow, and the computer-only ones close the list, read-only.
 */
type Props = {
  /** Suppresses the inline subpage back bar when an outer shell top bar owns back navigation. */
  hideSubpageBackBar?: boolean
}

export function H5Settings({ hideSubpageBackBar = false }: Props = {}) {
  const t = useTranslation()
  const shellBridge = useContext(H5SettingsShellContext)
  const pending = useUIStore((state) => state.pendingSettingsTab)
  const providerName = useProviderStore((state) => (
    state.providers.find((provider) => provider.id === state.activeId)?.name ?? null
  ))
  const fetchProviders = useProviderStore((state) => state.fetchProviders)
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  // Settings always opens on the list. Each detail page is a step into it,
  // kept here rather than in the remembered settings tab, so coming back to
  // Settings later starts from the list again. An explicit link still lands
  // directly on the requested page.
  const [localPage, setLocalPage] = useState<H5SettingsSubpage>(() => detailPage(pending))
  const page = shellBridge ? shellBridge.subpage : localPage
  const setPage = useCallback((next: H5SettingsSubpage) => {
    if (shellBridge) shellBridge.setSubpage(next)
    else setLocalPage(next)
  }, [shellBridge])

  useEffect(() => {
    if (!pending) return
    setPage(detailPage(pending))
    useUIStore.getState().setPendingSettingsTab(null)
  }, [pending, setPage])

  useEffect(() => {
    void fetchProviders().catch(() => undefined)
  }, [fetchProviders])

  const openList = () => setPage(null)
  const showSubpageBackBar = !hideSubpageBackBar && !shellBridge

  if (page) {
    return (
      <div
        data-testid="h5-settings-subpage"
        className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--color-surface)]"
      >
        {showSubpageBackBar && (
          <div
            data-testid="h5-settings-subpage-backbar"
            className="shrink-0 border-b border-[var(--color-border)] px-1 py-1 md:px-4 md:py-2"
          >
            <Button
              variant="ghost"
              size="lg"
              icon={<ChevronLeft size={18} strokeWidth={1.75} aria-hidden="true" />}
              onClick={openList}
            >
              {t('h5Settings.allSettings')}
            </Button>
          </div>
        )}
        <div className="scrollbar-autohide min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-5 md:px-8 md:py-6">
          <div className="mx-auto w-full max-w-[960px]">
            {page === 'providers' ? <ProviderSettings browserMode /> : <ActivitySettings browserMode />}
          </div>
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
    <div
      data-testid="h5-settings-scroll"
      className="scrollbar-autohide min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden bg-[var(--color-surface)] px-4 py-5 md:px-8 md:pb-10 md:pt-5"
    >
      <div className="mx-auto w-full max-w-[960px]">
        <header
          data-testid="h5-settings-desktop-header"
          className="mb-4 hidden min-h-8 items-center md:flex"
        >
          <h2 className="text-[18px] font-semibold leading-tight tracking-[-0.015em] text-[var(--color-text-primary)]">
            {t('settings.title')}
          </h2>
        </header>

        <SettingsGroup>
          <button
            type="button"
            onClick={() => setPage('activity')}
            className="v6c-pressable flex min-h-16 w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-border-focus)] active:bg-[var(--color-surface-hover)]"
          >
            <UserRound size={22} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-[var(--color-text-secondary)]" />
            <span className="min-w-0 flex-1">
              <span className="block text-[14px] font-semibold text-[var(--color-text-primary)]">{t('settings.tab.activity')}</span>
              <span className="mt-1 block text-xs text-[var(--color-text-tertiary)]">{t('settings.activity.entryDescription')}</span>
            </span>
            <ChevronRight size={16} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-[var(--color-text-tertiary)]" />
          </button>
        </SettingsGroup>

        <SettingsSection title={t('h5Settings.connection')}>
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
              onClick={() => setPage('providers')}
              className="v6c-pressable flex min-h-12 w-full items-center gap-3 px-4 py-2 text-left transition-colors hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-border-focus)] active:bg-[var(--color-surface-hover)]"
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
      </div>

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
