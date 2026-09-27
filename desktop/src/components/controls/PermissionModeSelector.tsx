import { useSideChatStore } from '@/stores/sideChatStore'
import { useState, useRef, useEffect, useCallback, useId } from 'react'
import DOMPurify from 'dompurify'
import { useDismissable } from '@/hooks/useDismissable'
import { useSettingsStore } from '../../stores/settingsStore'
import { useChatStore } from '../../stores/chatStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useTabStore } from '../../stores/tabStore'
import { useUIStore } from '../../stores/uiStore'
import { useTranslation } from '../../i18n'
import type { PermissionMode } from '../../types/settings'
import { useMobileViewport } from '../../hooks/useMobileViewport'
import { isDesktopRuntime } from '../../lib/desktopRuntime'
import { Badge, StatusDot, type Tone } from '@/components/ui/Badge'
import { MobileBottomSheet } from '@/components/ui/MobileBottomSheet'
import { ActionDialog } from '@/components/ui/ActionDialog'
import { AutoModeOptInDialog } from './AutoModeOptInDialog'

/**
 * The trigger states the mode as a risk-coloured dot rather than repeating the
 * menu's glyph: on the composer toolbar the reader needs "how much can it do
 * without me" at a glance, and a colour answers that faster than a symbol. The
 * per-mode glyphs stay in the menu, where there is room to tell them apart.
 */
const MODE_DOT_TONE: Record<PermissionMode, Tone> = {
  plan: 'neutral',
  default: 'neutral',
  acceptEdits: 'warning',
  auto: 'brand',
  bypassPermissions: 'danger',
  dontAsk: 'danger',
}

const MODE_ICONS: Record<PermissionMode, string> = {
  default: 'verified_user',
  acceptEdits: 'bolt',
  auto: 'autoplay',
  plan: 'architecture',
  bypassPermissions: 'gavel',
  dontAsk: 'gavel',
}

type Props = {
  sessionId?: string
  workDir?: string
  compact?: boolean
  menuPlacement?: 'top' | 'bottom'
  /** Controlled mode: override current value */
  value?: PermissionMode
  /** Controlled mode: called on change instead of updating global store */
  onChange?: (mode: PermissionMode) => void
}

export function PermissionModeSelector({ sessionId, workDir: workDirProp, compact = false, menuPlacement = 'top', value, onChange }: Props = {}) {
  const t = useTranslation()
  const isMobile = useMobileViewport() && !isDesktopRuntime()
  const {
    permissionMode: storeMode,
    autoModeOptInAccepted,
    acceptAutoModeOptIn,
  } = useSettingsStore()
  const setSessionPermissionMode = useChatStore((s) => s.setSessionPermissionMode)
  const selectedTabId = useTabStore((s) => s.activeTabId)
  const activeTabId = sessionId ?? selectedTabId
  const livePermissionMode = useChatStore(s => activeTabId ? s.sessions[activeTabId]?.permissionMode : undefined)
  const sideChat = useSideChatStore(s => activeTabId ? s.entries[activeTabId] : undefined)
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
    /** Display-only flag on the row; carries no behaviour. */
    badge?: { tone: 'warning' | 'danger'; label: string }
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
      badge: { tone: 'warning', label: t('permMode.badge.optIn') },
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
      badge: { tone: 'danger', label: t('permMode.badge.risky') },
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
    : livePermissionMode || (activeSession?.permissionMode as PermissionMode | undefined) || sideChat?.permissionMode || storeMode
  const workDir = workDirProp || activeSession?.workDir || sideChat?.workDir || '~'
  const compactButtonClass = compact
    ? isMobile
      ? 'h-11 w-11 justify-center rounded-[var(--radius-md)] p-0 border border-[var(--color-border)] bg-[var(--color-surface)]'
      : 'h-8 w-8 justify-center rounded-full p-0 bg-[var(--color-surface-container-low)]'
    : 'h-8 gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-[13px]'
  const menuPlacementClass = menuPlacement === 'bottom'
    ? 'top-full mt-2'
    : 'bottom-full mb-2'
  // Generated, not hard-coded: the previous literal id was rendered by both the
  // sheet branch and the desktop branch, so `aria-controls` pointed at whichever
  // duplicate the browser resolved first.
  const menuId = useId()

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

  const closeMenu = useCallback(() => setOpen(false), [])

  // `ref` wraps the trigger and the desktop popup; `menuRef` covers the sheet,
  // which portals out of it. `stopEscapePropagation` keeps one Escape from
  // closing both this menu and a dialog it was opened inside.
  useDismissable({
    open,
    refs: [ref, menuRef],
    onDismiss: closeMenu,
    stopEscapePropagation: true,
  })

  const permissionItems = (
    <>
      {PERMISSION_ITEMS.map((item) => (
        <button
          key={item.value}
          role="menuitem"
          onClick={() => {
            const actionTabId = sessionId ?? useTabStore.getState().activeTabId
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
            flex w-full items-start gap-3 rounded-[var(--radius-md)] px-3 py-2.5 text-left transition-colors
            hover:bg-[var(--color-surface-hover)]
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-border-focus)]
            ${item.value === currentMode ? 'bg-[var(--color-surface-selected)]' : ''}
          `}
        >
          {/* Fixed 20px box: the Auto glyph is drawn 2px smaller to match the
              others optically, and without a box that difference shifted its
              whole title/description column 2px left of the other four rows. */}
          <span className={`material-symbols-outlined mt-0.5 w-5 shrink-0 text-center ${item.value === 'auto' ? 'text-[18px]' : 'text-[20px]'} ${item.color || 'text-[var(--color-text-secondary)]'}`}>
            {item.icon}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-[var(--color-text-primary)]">{item.label}</span>
              {item.badge && (
                // `pill={false}` gives the handoff's 6px corner; the pill shape
                // is reserved for status chips elsewhere.
                <Badge tone={item.badge.tone} size="xs" pill={false}>
                  {item.badge.label}
                </Badge>
              )}
            </div>
            <div className="mt-0.5 text-[12.5px] leading-snug text-[var(--color-text-tertiary)]">{item.description}</div>
          </div>
          {item.value === currentMode && (
            <span className="material-symbols-outlined mt-0.5 text-[16px] text-[var(--color-brand)]" style={{ fontVariationSettings: "'FILL' 1" }}>
              check_circle
            </span>
          )}
        </button>
      ))}
    </>
  )

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => {
          const actionTabId = sessionId ?? useTabStore.getState().activeTabId
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
        // `shrink-0` / `whitespace-nowrap`: it shares the composer toolbar with
        // the run-location pill, whose branch name can be arbitrarily long.
        // Without these the label wrapped to two lines and grew the whole row.
        className={`flex shrink-0 items-center whitespace-nowrap font-medium text-[var(--color-text-primary)] transition-[background-color,color,border-color] duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface)] ${
          isTurnActive ? 'opacity-50 cursor-not-allowed' : 'hover:border-[var(--color-outline)] hover:bg-[var(--color-surface-hover)]'
        } ${compactButtonClass}`}
      >
        {compact ? (
          <span className={`material-symbols-outlined text-[var(--color-text-secondary)] ${currentMode === 'auto' ? 'text-[12px]' : 'text-[14px]'}`}>
            {MODE_ICONS[currentMode]}
          </span>
        ) : (
          <StatusDot tone={MODE_DOT_TONE[currentMode]} data-testid="permission-mode-dot" />
        )}
        {!compact && (
          <>
            <span>{MODE_LABELS[currentMode]}</span>
            <span className="material-symbols-outlined text-[12px] text-[var(--color-text-tertiary)]">expand_more</span>
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
            <div id={menuId} ref={menuRef} role="menu">
              {permissionItems}
            </div>
          </MobileBottomSheet>
        ) : (
          <div id={menuId} ref={menuRef} role="menu" className={`absolute left-0 ${menuPlacementClass} z-[var(--z-dropdown)] w-[360px] rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] p-1.5 shadow-[var(--shadow-overlay)]`}>
            <div className="px-3 pb-1 pt-2 text-[10px] font-bold uppercase tracking-widest text-[var(--color-text-tertiary)]">
              {t('permMode.executionPermissions')}
            </div>
            {permissionItems}
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
            <div className="flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container)] px-3 py-2" title={workDir}>
              <span className="material-symbols-outlined shrink-0 text-[16px] text-[var(--color-text-tertiary)]">folder</span>
              <code className="truncate font-mono text-xs text-[var(--color-text-primary)]">{workDir}</code>
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
              const actionTabId = sessionId ?? useTabStore.getState().activeTabId
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
          const actionTabId = sessionId ?? useTabStore.getState().activeTabId
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
            const confirmedTabId = sessionId ?? useTabStore.getState().activeTabId
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
