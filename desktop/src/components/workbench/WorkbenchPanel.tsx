import { ArrowLeft, FolderOpen, Globe, Maximize2, X } from 'lucide-react'
import { useTranslation } from '../../i18n'
import {
  useWorkspacePanelStore,
  type WorkbenchMode,
} from '../../stores/workspacePanelStore'
import { useBrowserPanelStore } from '../../stores/browserPanelStore'
import { WORKBENCH_TAB_PREFIX, useTabStore } from '../../stores/tabStore'
import { WorkspacePanel } from '../workspace/WorkspacePanel'
import { BrowserSurface } from '../browser/BrowserSurface'

type WorkbenchPanelProps = {
  sessionId: string
  variant?: 'panel' | 'tab'
  onClose?: () => void
}

const MODE_ITEMS: ReadonlyArray<{
  mode: WorkbenchMode
  labelKey: 'workbench.modeWorkspace' | 'workbench.modeBrowser'
  Icon: typeof FolderOpen
}> = [
  { mode: 'workspace', labelKey: 'workbench.modeWorkspace', Icon: FolderOpen },
  { mode: 'browser', labelKey: 'workbench.modeBrowser', Icon: Globe },
]

/**
 * Unified right-side "Workbench" panel. Hosts the file workspace and the native
 * browser surface behind a single per-session mode switch (file ↔ browser),
 * sharing the panel's open state and width via {@link useWorkspacePanelStore}.
 */
export function WorkbenchPanel({ sessionId, variant = 'panel', onClose }: WorkbenchPanelProps) {
  const t = useTranslation()
  const mode = useWorkspacePanelStore((state) => state.getMode(sessionId))
  const setMode = useWorkspacePanelStore((state) => state.setMode)
  const closePanel = useWorkspacePanelStore((state) => state.closePanel)
  const ensureBlankBrowser = useBrowserPanelStore((state) => state.ensureBlank)
  const isTabVariant = variant === 'tab'

  const handleModeSelect = (nextMode: WorkbenchMode) => {
    if (nextMode === 'browser') {
      ensureBlankBrowser(sessionId)
    }
    setMode(sessionId, nextMode)
  }

  const handleExpand = () => {
    const origin = useWorkspacePanelStore.getState().getOrigin(sessionId)
    useTabStore.getState().openWorkbenchTab(sessionId, t('workbench.tabTitle'), {
      sourceSessionId: sessionId,
      ...(origin ?? {}),
    })
    closePanel(sessionId)
  }

  const handleClose = () => {
    if (onClose) {
      onClose()
      return
    }
    closePanel(sessionId)
  }

  const handleReturn = () => {
    const store = useTabStore.getState()
    const activeTab = store.tabs.find((tab) => tab.sessionId === store.activeTabId)
    const tabId = activeTab?.type === 'workbench' && activeTab.workbenchSessionId === sessionId
      ? activeTab.sessionId
      : `${WORKBENCH_TAB_PREFIX}${sessionId}`
    store.returnFromWorkbench(tabId)
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-[var(--color-surface)]">
      <header
        data-testid="workbench-navigation"
        aria-label={t('workbench.navigation')}
        className="flex h-12 shrink-0 items-center gap-2.5 border-b border-[var(--color-text-primary)]/10 bg-[var(--color-surface)] px-4"
      >
        {isTabVariant && (
          <button
            type="button"
            onClick={handleReturn}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[7px] px-2 text-[12px] font-medium text-[var(--color-text-secondary)] transition-[color,background-color,transform] duration-200 ease-out hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-info)]/30"
          >
            <ArrowLeft size={15} strokeWidth={2} aria-hidden="true" />
            <span>{t('workbench.backToConversation')}</span>
          </button>
        )}
        <div
          role="tablist"
          aria-label={t('workbench.modeSwitch')}
          className="inline-flex items-center gap-0.5 rounded-[8px] bg-[var(--color-surface-container)] p-0.5"
        >
          {MODE_ITEMS.map(({ mode: itemMode, labelKey, Icon }) => {
            const isActive = mode === itemMode
            return (
              <button
                key={itemMode}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => handleModeSelect(itemMode)}
                className={`inline-flex h-7 items-center gap-1.5 rounded-[6px] px-2.5 text-[12px] font-medium transition-[color,background-color,transform] duration-200 ease-out active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-info)]/30 ${
                  isActive
                    ? 'bg-[var(--color-surface)] text-[var(--color-text-primary)] shadow-[0_1px_2px_rgba(15,23,42,0.08)]'
                    : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]'
                }`}
              >
                <Icon size={15} strokeWidth={2} aria-hidden="true" className="shrink-0" />
                <span>{t(labelKey)}</span>
              </button>
            )
          })}
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-1">
          {!isTabVariant && (
            <button
              type="button"
              aria-label={t('workbench.expand')}
              title={t('workbench.expand')}
              onClick={handleExpand}
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-info)]/30"
            >
              <Maximize2 size={15} strokeWidth={2} aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            aria-label={t('workbench.close')}
            onClick={handleClose}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-info)]/30"
          >
            <X size={16} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col">
        {mode === 'browser' ? (
          <BrowserSurface sessionId={sessionId} />
        ) : (
          <WorkspacePanel sessionId={sessionId} embedded forceVisible={isTabVariant} />
        )}
      </div>
    </div>
  )
}
