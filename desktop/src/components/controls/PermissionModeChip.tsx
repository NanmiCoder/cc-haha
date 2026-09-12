import { useState, useRef, useCallback, useId } from 'react'
import DOMPurify from 'dompurify'
import { useDismissable } from '@/hooks/useDismissable'
import { useSettingsStore } from '../../stores/settingsStore'
import { useChatStore } from '../../stores/chatStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useTabStore } from '../../stores/tabStore'
import { useUIStore } from '../../stores/uiStore'
import { useTranslation } from '../../i18n'
import type { PermissionMode } from '../../types/settings'
import { ActionDialog } from '@/components/ui/ActionDialog'
import { AutoModeOptInDialog } from './AutoModeOptInDialog'

const MODE_DOT_COLOR: Record<PermissionMode, string> = {
  plan: 'bg-[var(--color-text-tertiary)]',
  default: 'bg-[var(--color-text-tertiary)]',
  acceptEdits: 'bg-[var(--color-warning)]',
  auto: 'bg-[var(--color-brand)]',
  bypassPermissions: 'bg-[var(--color-error)]',
  dontAsk: 'bg-[var(--color-error)]',
}

const MODE_LABELS: Record<PermissionMode, string> = {
  default: 'permMode.label.default',
  acceptEdits: 'permMode.label.acceptEdits',
  auto: 'permMode.label.auto',
  plan: 'permMode.label.plan',
  bypassPermissions: 'permMode.label.bypassPermissions',
  dontAsk: 'permMode.label.dontAsk',
}

type Props = {
  sessionId?: string
  disabled?: boolean
}

export function PermissionModeChip({ sessionId: sessionIdProp, disabled = false }: Props) {
  const t = useTranslation()
  const {
    permissionMode: storeMode,
    autoModeOptInAccepted,
    acceptAutoModeOptIn,
  } = useSettingsStore()
  const setSessionPermissionMode = useChatStore((s) => s.setSessionPermissionMode)
  const activeTabId = useTabStore((s) => s.activeTabId)
  const sessions = useSessionStore((s) => s.sessions)

  const sessionId = sessionIdProp ?? activeTabId
  const activeSession = sessionId ? sessions.find((s) => s.id === sessionId) : null
  const currentMode: PermissionMode = (activeSession?.permissionMode as PermissionMode | undefined) || storeMode

  const [open, setOpen] = useState(false)
  const [confirmDialog, setConfirmDialog] = useState(false)
  const [autoDialog, setAutoDialog] = useState(false)
  const [autoConsentPending, setAutoConsentPending] = useState(false)
  const interactionTabIdRef = useRef<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuId = useId()

  const isTurnActive = (() => {
    if (!sessionId) return false
    return (useChatStore.getState().sessions[sessionId]?.chatState ?? 'idle') !== 'idle'
  })()

  const closeMenu = useCallback(() => setOpen(false), [])

  useDismissable({
    open,
    refs: [ref, menuRef],
    onDismiss: closeMenu,
    stopEscapePropagation: true,
  })

  const PERMISSION_ITEMS: Array<{
    value: PermissionMode
    label: string
    description: string
  }> = [
    { value: 'default', label: t('permMode.askPermissions'), description: t('permMode.askPermDesc') },
    { value: 'acceptEdits', label: t('permMode.autoAccept'), description: t('permMode.autoAcceptDesc') },
    { value: 'auto', label: t('permMode.autoMode'), description: t('permMode.autoModeDesc') },
    { value: 'plan', label: t('permMode.planMode'), description: t('permMode.planModeDesc') },
    { value: 'bypassPermissions', label: t('permMode.bypass'), description: t('permMode.bypassDesc') },
  ]

  const handleSelect = useCallback((value: PermissionMode) => {
    const tabId = useTabStore.getState().activeTabId
    if (isTurnActive) {
      setOpen(false)
      return
    }
    if (value === 'auto' && value !== currentMode) {
      setOpen(false)
      setAutoDialog(true)
      return
    }
    if (value === 'bypassPermissions') {
      setOpen(false)
      setConfirmDialog(true)
      return
    }
    if (tabId) setSessionPermissionMode(tabId, value)
    setOpen(false)
  }, [isTurnActive, currentMode, setSessionPermissionMode])

  const handleConfirmBypass = useCallback(() => {
    const tabId = useTabStore.getState().activeTabId
    if (isTurnActive || !tabId) {
      setConfirmDialog(false)
      return
    }
    setSessionPermissionMode(tabId, 'bypassPermissions')
    setConfirmDialog(false)
  }, [isTurnActive, setSessionPermissionMode])

  const handleConfirmAuto = useCallback(async () => {
    const tabId = useTabStore.getState().activeTabId
    if (isTurnActive || !tabId) {
      setAutoDialog(false)
      return
    }
    setAutoConsentPending(true)
    try {
      if (!autoModeOptInAccepted) {
        await acceptAutoModeOptIn()
      }
      const confirmedTabId = useTabStore.getState().activeTabId
      if (confirmedTabId && !isTurnActive) {
        setSessionPermissionMode(confirmedTabId, 'auto')
      }
    } catch (err) {
      useUIStore.getState().addToast({
        type: 'error',
        message: err instanceof Error ? err.message : t('common.error'),
      })
    } finally {
      setAutoConsentPending(false)
      setAutoDialog(false)
    }
  }, [isTurnActive, autoModeOptInAccepted, acceptAutoModeOptIn, setSessionPermissionMode, t])

  return (
    <div ref={ref} className="relative inline-flex">
      <button
        onClick={() => {
          if (disabled || isTurnActive) return
          if (open) {
            setOpen(false)
            return
          }
          interactionTabIdRef.current = activeTabId
          setOpen(true)
        }}
        disabled={disabled || isTurnActive}
        title={disabled || isTurnActive ? t('permMode.chipTooltipDisabled') : t('permMode.chipTooltip')}
        className={`inline-flex items-center gap-1 rounded-[4px] px-1.5 py-0.5 transition-colors ${
          disabled || isTurnActive
            ? 'cursor-not-allowed opacity-50'
            : 'cursor-pointer hover:bg-[var(--color-surface-hover)]'
        }`}
      >
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${MODE_DOT_COLOR[currentMode]}`} />
        <span className="shrink-0 font-medium">{t(MODE_LABELS[currentMode])}</span>
        <span className="material-symbols-outlined shrink-0 text-[10px] text-[var(--color-text-tertiary)]">
          expand_more
        </span>
      </button>

      {open && (
        <div
          id={menuId}
          ref={menuRef}
          role="menu"
          className="absolute left-0 top-full z-[var(--z-dropdown)] mt-1 w-[320px] rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] p-1.5 shadow-[var(--shadow-overlay)]"
        >
          <div className="px-3 pb-1 pt-2 text-[10px] font-bold uppercase tracking-widest text-[var(--color-text-tertiary)]">
            {t('permMode.executionPermissions')}
          </div>
          {PERMISSION_ITEMS.map((item) => (
            <button
              key={item.value}
              role="menuitem"
              onClick={() => handleSelect(item.value)}
              className={`flex w-full items-start gap-3 rounded-[var(--radius-md)] px-3 py-2 text-left transition-colors hover:bg-[var(--color-surface-hover)] ${
                item.value === currentMode ? 'bg-[var(--color-surface-selected)]' : ''
              }`}
            >
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-[var(--color-text-primary)]">{item.label}</div>
                <div className="mt-0.5 text-[11px] leading-snug text-[var(--color-text-tertiary)]">{item.description}</div>
              </div>
              {item.value === currentMode && (
                <span className="material-symbols-outlined mt-0.5 text-[16px] text-[var(--color-brand)]" style={{ fontVariationSettings: "'FILL' 1" }}>
                  check_circle
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      <ActionDialog
        open={confirmDialog}
        onClose={() => {
          setConfirmDialog(false)
          interactionTabIdRef.current = null
        }}
        title={t('permMode.enableBypassTitle')}
        width={420}
        body={(
          <div className="space-y-3">
            <p className="text-xs font-medium text-[var(--color-error)]">
              {t('permMode.enableBypassSubtitle')}
            </p>
            <p
              className="text-xs leading-relaxed text-[var(--color-text-secondary)]"
              dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(t('permMode.enableBypassBody')) }}
            />
            <ul className="space-y-1.5 text-xs text-[var(--color-text-secondary)]">
              <li className="flex items-start gap-2">
                <span className="material-symbols-outlined mt-0.5 text-[14px] text-[var(--color-error)]">check</span>
                {t('permMode.permReadWrite')}
              </li>
              <li className="flex items-start gap-2">
                <span className="material-symbols-outlined mt-0.5 text-[14px] text-[var(--color-error)]">check</span>
                {t('permMode.permShell')}
              </li>
              <li className="flex items-start gap-2">
                <span className="material-symbols-outlined mt-0.5 text-[14px] text-[var(--color-error)]">check</span>
                {t('permMode.permPackages')}
              </li>
            </ul>
          </div>
        )}
        actions={[
          {
            label: t('common.cancel'),
            onClick: () => {
              setConfirmDialog(false)
              interactionTabIdRef.current = null
            },
            variant: 'secondary',
          },
          {
            label: t('permMode.enableBypassBtn'),
            onClick: handleConfirmBypass,
            variant: 'danger',
          },
        ]}
      />

      <AutoModeOptInDialog
        open={autoDialog}
        loading={autoConsentPending}
        onClose={() => {
          if (autoConsentPending) return
          setAutoDialog(false)
          interactionTabIdRef.current = null
        }}
        onConfirm={handleConfirmAuto}
      />
    </div>
  )
}
