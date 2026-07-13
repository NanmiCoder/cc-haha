import { useState, useRef, useEffect } from 'react'
import DOMPurify from 'dompurify'
import { useSettingsStore } from '../../stores/settingsStore'
import { useChatStore } from '../../stores/chatStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useTabStore } from '../../stores/tabStore'
import { useUIStore } from '../../stores/uiStore'
import { useTranslation } from '../../i18n'
import type { PermissionMode } from '../../types/settings'
import { useMobileViewport } from '../../hooks/useMobileViewport'
import { isDesktopRuntime } from '../../lib/desktopRuntime'
import { MobileBottomSheet } from '../shared/MobileBottomSheet'
import { ActionDialog } from '../shared/ActionDialog'
import { AutoModeOptInDialog } from './AutoModeOptInDialog'

const MODE_ICONS: Record<PermissionMode, string> = {
  default: 'verified_user',
  acceptEdits: 'bolt',
  auto: 'autoplay',
  plan: 'architecture',
  bypassPermissions: 'gavel',
  dontAsk: 'gavel',
}

type Props = {
  workDir?: string
  compact?: boolean
  menuPlacement?: 'top' | 'bottom'
  /** Controlled mode: override current value */
  value?: PermissionMode
  /** Controlled mode: called on change instead of updating global store */
  onChange?: (mode: PermissionMode) => void
}

export function PermissionModeSelector({ workDir: workDirProp, compact = false, menuPlacement = 'top', value, onChange }: Props = {}) {
  const t = useTranslation()
  const isMobile = useMobileViewport() && !isDesktopRuntime()
  const {
    permissionMode: storeMode,
    autoModeOptInAccepted,
    acceptAutoModeOptIn,
  } = useSettingsStore()
  const setSessionPermissionMode = useChatStore((s) => s.setSessionPermissionMode)
  const activeTabId = useTabStore((s) => s.activeTabId)
  const sessions = useSessionStore((s) => s.sessions)
  const chatState = useChatStore((s) =>
    activeTabId ? s.sessions[activeTabId]?.chatState ?? 'idle' : 'idle',
  )
  const isTurnActive = chatState !== 'idle'
  const isTurnActiveNow = (tabId: string | null) => {
    if (!tabId) return false
    return (useChatStore.getState().sessions[tabId]?.chatState ?? 'idle') !== 'idle'
  }
  const [open, setOpen] = useState(false)
  const [confirmDialog, setConfirmDialog] = useState(false)
  const [autoDialog, setAutoDialog] = useState(false)
  const [autoConsentPending, setAutoConsentPending] = useState(false)
  const interactionTabIdRef = useRef<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const isControlled = value !== undefined
  const PERMISSION_ITEMS: Array<{
    value: PermissionMode
    label: string
    description: string
    icon: string
    color?: string
  }> = [
    {
      value: 'default',
      label: t('permMode.askPermissions'),
      description: t('permMode.askPermDesc'),
      icon: 'verified_user',
    },
    {
      value: 'acceptEdits',
      label: t('permMode.autoAccept'),
      description: t('permMode.autoAcceptDesc'),
      icon: 'bolt',
    },
    {
      value: 'auto',
      label: t('permMode.autoMode'),
      description: t('permMode.autoModeDesc'),
      icon: 'autoplay',
      color: 'text-[var(--color-brand)]',
    },
    {
      value: 'plan',
      label: t('permMode.planMode'),
      description: t('permMode.planModeDesc'),
      icon: 'architecture',
      color: 'text-[var(--color-text-tertiary)]',
    },
    {
      value: 'bypassPermissions',
      label: t('permMode.bypass'),
      description: t('permMode.bypassDesc'),
      icon: 'gavel',
      color: 'text-[var(--color-error)]',
    },
  ]

  const MODE_LABELS: Record<PermissionMode, string> = {
    default: t('permMode.label.default'),
    acceptEdits: t('permMode.label.acceptEdits'),
    auto: t('permMode.label.auto'),
    plan: t('permMode.label.plan'),
    bypassPermissions: t('permMode.label.bypassPermissions'),
    dontAsk: t('permMode.label.dontAsk'),
  }

  const activeSession = activeTabId
    ? sessions.find((s) => s.id === activeTabId)
    : null
  const currentMode = isControlled
    ? value
    : (activeSession?.permissionMode as PermissionMode | undefined) || storeMode
  const workDir = workDirProp || activeSession?.workDir || '~'
  const compactButtonClass = compact
    ? isMobile
      ? 'h-11 w-11 justify-center rounded-xl p-0'
      : 'h-8 w-8 justify-center rounded-full p-0'
    : 'gap-1.5 rounded-full px-2.5 py-1.5 text-xs'
  const menuPlacementClass = menuPlacement === 'bottom'
    ? 'top-full mt-2'
    : 'bottom-full mb-2'
  const menuId = 'permission-mode-menu'

  useEffect(() => {
    if (isTurnActive) {
      setOpen(false)
      setConfirmDialog(false)
      setAutoDialog(false)
      interactionTabIdRef.current = null
    }
  }, [isTurnActive])

  useEffect(() => {
    if (
      (open || confirmDialog || autoDialog) &&
      activeTabId !== interactionTabIdRef.current
    ) {
      setOpen(false)
      setConfirmDialog(false)
      setAutoDialog(false)
      interactionTabIdRef.current = null
    }
  }, [activeTabId, autoDialog, confirmDialog, open])

  useEffect(() => {
    if (!open) return
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node
      if (
        ref.current &&
        !ref.current.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        setOpen(false)
      }
    }
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleEsc)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleEsc)
    }
  }, [open])

  const permissionOptions = (
    <div id={menuId} ref={menuRef} role="menu">
      {PERMISSION_ITEMS.map((item) => (
        <button
          key={item.value}
          role="menuitem"
          onClick={() => {
            const actionTabId = useTabStore.getState().activeTabId
            if (
              actionTabId !== interactionTabIdRef.current ||
              isTurnActiveNow(actionTabId)
            ) {
              setOpen(false)
              setConfirmDialog(false)
              setAutoDialog(false)
              interactionTabIdRef.current = null
              return
            }
            if (item.value === 'auto' && item.value !== currentMode) {
              setOpen(false)
              setAutoDialog(true)
              return
            }
            if (item.value === 'bypassPermissions') {
              setOpen(false)
              setConfirmDialog(true)
              return
            }
            if (isControlled) {
              onChange?.(item.value)
            } else {
              if (actionTabId) setSessionPermissionMode(actionTabId, item.value)
            }
            setOpen(false)
            interactionTabIdRef.current = null
          }}
          className={`
            flex w-full items-start gap-3 px-4 py-3 text-left transition-colors
            hover:bg-[var(--color-surface-hover)]
            ${item.value === currentMode ? 'bg-[var(--color-surface-selected)]' : ''}
          `}
        >
          <span className={`material-symbols-outlined mt-0.5 ${item.value === 'auto' ? 'text-[18px]' : 'text-[20px]'} ${item.color || 'text-[var(--color-text-secondary)]'}`}>
            {item.icon}
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-[var(--color-text-primary)]">{item.label}</div>
            <div className="mt-0.5 text-xs text-[var(--color-text-tertiary)]">{item.description}</div>
          </div>
          {item.value === currentMode && (
            <span className="material-symbols-outlined mt-0.5 text-[16px] text-[var(--color-brand)]" style={{ fontVariationSettings: "'FILL' 1" }}>
              check_circle
            </span>
          )}
        </button>
      ))}
    </div>
  )

  const menuContent = (
    <>
      <div className="px-4 py-2 text-[10px] font-bold uppercase tracking-widest text-[var(--color-outline)]">
        {t('permMode.executionPermissions')}
      </div>
      {permissionOptions}
    </>
  )

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => {
          const actionTabId = useTabStore.getState().activeTabId
          if (isTurnActiveNow(actionTabId)) return
          if (open) {
            setOpen(false)
            interactionTabIdRef.current = null
            return
          }
          interactionTabIdRef.current = actionTabId
          setOpen(true)
        }}
        disabled={isTurnActive}
        aria-label={MODE_LABELS[currentMode]}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title={isTurnActive ? t('permMode.disabledDuringTurn') : (compact ? MODE_LABELS[currentMode] : undefined)}
        className={`flex items-center bg-[var(--color-surface-container-low)] font-medium text-[var(--color-text-secondary)] transition-colors ${
          isTurnActive ? 'opacity-50 cursor-not-allowed' : 'hover:bg-[var(--color-surface-hover)]'
        } ${compactButtonClass}`}
      >
        <span className={`material-symbols-outlined ${currentMode === 'auto' ? 'text-[12px]' : 'text-[14px]'}`}>
          {MODE_ICONS[currentMode]}
        </span>
        {!compact && (
          <>
            <span>{MODE_LABELS[currentMode]}</span>
            <span className="material-symbols-outlined text-[12px]">expand_more</span>
          </>
        )}
      </button>

      {open && (
        isMobile ? (
          <MobileBottomSheet
            open={open}
            onClose={() => setOpen(false)}
            title={t('permMode.executionPermissions')}
            closeLabel={t('tabs.close')}
            ariaLabel={t('permMode.executionPermissions')}
            contentClassName="py-2"
          >
            {permissionOptions}
          </MobileBottomSheet>
        ) : (
          <div id={menuId} ref={menuRef} role="menu" className={`absolute left-0 ${menuPlacementClass} w-[320px] rounded-xl bg-[var(--color-surface-container-lowest)] border border-[var(--color-border)] shadow-[var(--shadow-dropdown)] z-50 py-2`}>
            {menuContent}
          </div>
        )
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
            <div className="flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-container)] px-3 py-2" title={workDir}>
              <span className="material-symbols-outlined shrink-0 text-[16px] text-[var(--color-text-tertiary)]">folder</span>
              <code className="truncate text-xs font-[var(--font-mono)] text-[var(--color-text-primary)]">{workDir}</code>
            </div>
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
            onClick: () => {
              const actionTabId = useTabStore.getState().activeTabId
              if (
                actionTabId !== interactionTabIdRef.current ||
                isTurnActiveNow(actionTabId)
              ) {
                setConfirmDialog(false)
                interactionTabIdRef.current = null
                return
              }
              if (isControlled) {
                onChange?.('bypassPermissions')
              } else if (actionTabId) {
                setSessionPermissionMode(actionTabId, 'bypassPermissions')
              }
              setConfirmDialog(false)
              interactionTabIdRef.current = null
            },
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
        onConfirm={async () => {
          const actionTabId = useTabStore.getState().activeTabId
          if (
            actionTabId !== interactionTabIdRef.current ||
            isTurnActiveNow(actionTabId)
          ) {
            setAutoDialog(false)
            interactionTabIdRef.current = null
            return
          }

          setAutoConsentPending(true)
          try {
            if (!autoModeOptInAccepted) {
              await acceptAutoModeOptIn()
            }
            const confirmedTabId = useTabStore.getState().activeTabId
            if (
              confirmedTabId !== interactionTabIdRef.current ||
              isTurnActiveNow(confirmedTabId)
            ) {
              return
            }
            if (isControlled) {
              onChange?.('auto')
            } else if (confirmedTabId) {
              setSessionPermissionMode(confirmedTabId, 'auto')
            }
            setAutoDialog(false)
            interactionTabIdRef.current = null
          } catch (err) {
            useUIStore.getState().addToast({
              type: 'error',
              message: err instanceof Error ? err.message : t('common.error'),
            })
          } finally {
            setAutoConsentPending(false)
          }
        }}
      />
    </div>
  )
}
