import { useSideChatStore } from '@/stores/sideChatStore'
import { useState, useRef, useEffect, useCallback, useId } from 'react'
import DOMPurify from 'dompurify'
import { Check, ChevronDown, CirclePlay, DraftingCompass, Folder, Gavel, ShieldCheck, Zap, type LucideIcon } from 'lucide-react'
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
import {
  COMPOSER_MENU_ITEM,
  COMPOSER_MENU_ITEM_ACTIVE,
  COMPOSER_MENU_SECTION,
  COMPOSER_POPOVER,
} from '@/components/chat/composerMenuStyles'

/**
 * The trigger states the mode as a risk-coloured dot rather than repeating the
 * menu's glyph: on the composer toolbar the reader needs "how much can it do
 * without me" at a glance, and a colour answers that faster than a symbol. The
 * per-mode glyphs stay in the menu, where there is room to tell them apart.
 */
// Green when every write still asks first, amber once some run unattended,
// red when nothing asks at all. Brand is not a risk level: terracotta is kept
// for the brand, the send key and selection.
const MODE_DOT_TONE: Record<PermissionMode, Tone> = {
  plan: 'success',
  default: 'success',
  acceptEdits: 'warning',
  auto: 'warning',
  bypassPermissions: 'danger',
  dontAsk: 'danger',
}

const MODE_ICONS: Record<PermissionMode, LucideIcon> = {
  default: ShieldCheck,
  acceptEdits: Zap,
  auto: CirclePlay,
  plan: DraftingCompass,
  bypassPermissions: Gavel,
  dontAsk: Gavel,
}

function ItemIcon({ mode }: { mode: PermissionMode }) {
  const Icon = MODE_ICONS[mode]
  return <Icon aria-hidden="true" size={16} strokeWidth={1.75} />
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
    color?: string
    /** Display-only flag on the row; carries no behaviour. */
    badge?: { tone: 'warning' | 'danger'; label: string }
  }> = [
    {
      value: 'default',
      label: t('permMode.askPermissions'),
      description: t('permMode.askPermDesc'),
    },
    {
      value: 'acceptEdits',
      label: t('permMode.autoAccept'),
      description: t('permMode.autoAcceptDesc'),
    },
    {
      value: 'auto',
      label: t('permMode.autoMode'),
      description: t('permMode.autoModeDesc'),
      badge: { tone: 'warning', label: t('permMode.badge.optIn') },
    },
    {
      value: 'plan',
      label: t('permMode.planMode'),
      description: t('permMode.planModeDesc'),
    },
    {
      value: 'bypassPermissions',
      label: t('permMode.bypass'),
      description: t('permMode.bypassDesc'),
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
  // A quiet 28px chip on the composer row (risk dot + label + chevron); the
  // compact desktop form keeps only the mode glyph, and the phone form grows
  // to the 44px touch target.
  const compactButtonClass = compact
    ? isMobile
      ? 'h-11 w-11 justify-center rounded-[var(--radius-md)] p-0'
      : 'h-7 w-7 justify-center rounded-[var(--radius-sm)] p-0'
    : 'h-7 gap-1.5 rounded-[var(--radius-sm)] px-2 text-xs'
  const TriggerIcon = MODE_ICONS[currentMode]
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
          className={`${COMPOSER_MENU_ITEM} items-start ${item.value === currentMode ? COMPOSER_MENU_ITEM_ACTIVE : ''}`}
        >
          {/* Fixed 20px box so every title starts on the same column whatever
              the glyph's own width. */}
          <span
            data-mode-icon={item.value}
            className={`mt-px flex w-5 shrink-0 justify-center ${item.color || 'text-[var(--color-text-tertiary)]'}`}
          >
            <ItemIcon mode={item.value} />
          </span>
          <div className="grid min-w-0 flex-1 gap-px">
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-medium text-[var(--color-text-primary)]">{item.label}</span>
              {item.badge && (
                // `pill={false}` gives the handoff's 6px corner; the pill shape
                // is reserved for status chips elsewhere.
                <Badge tone={item.badge.tone} size="xs" pill={false}>
                  {item.badge.label}
                </Badge>
              )}
            </div>
            <div className="text-xs leading-snug text-[var(--color-text-tertiary)]">{item.description}</div>
          </div>
          {item.value === currentMode && (
            <Check aria-hidden="true" size={14} strokeWidth={2} className="mt-0.5 shrink-0 text-[var(--color-brand)]" />
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
        className={`flex shrink-0 items-center whitespace-nowrap text-[var(--color-text-secondary)] transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] ${
          isTurnActive
            ? 'opacity-50 cursor-not-allowed'
            : `hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] ${open ? 'bg-[var(--color-surface-hover)] text-[var(--color-text-primary)]' : ''}`
        } ${compactButtonClass}`}
      >
        {compact ? (
          <TriggerIcon data-mode-icon={currentMode} aria-hidden="true" size={isMobile ? 18 : 14} strokeWidth={1.75} />
        ) : (
          <StatusDot tone={MODE_DOT_TONE[currentMode]} data-testid="permission-mode-dot" />
        )}
        {!compact && (
          <>
            <span>{MODE_LABELS[currentMode]}</span>
            <ChevronDown aria-hidden="true" size={12} strokeWidth={2} className="text-[var(--color-text-tertiary)]" />
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
          <div id={menuId} ref={menuRef} role="menu" className={`absolute left-0 ${menuPlacementClass} z-[var(--z-dropdown)] w-[340px] ${COMPOSER_POPOVER}`}>
            <div className={COMPOSER_MENU_SECTION}>
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
            <div className="flex items-center gap-2 rounded-[var(--radius-md)] bg-[var(--color-surface-container)] px-3 py-2" title={workDir}>
              <Folder aria-hidden="true" size={14} strokeWidth={1.75} className="shrink-0 text-[var(--color-text-tertiary)]" />
              <code className="truncate font-mono text-xs text-[var(--color-text-primary)]">{workDir}</code>
            </div>
            <ul className="space-y-1.5 text-xs text-[var(--color-text-secondary)]">
              <li className="flex items-start gap-2">
                <Check aria-hidden="true" size={14} strokeWidth={2} className="mt-0.5 shrink-0 text-[var(--color-error)]" />
                {t('permMode.permReadWrite')}
              </li>
              <li className="flex items-start gap-2">
                <Check aria-hidden="true" size={14} strokeWidth={2} className="mt-0.5 shrink-0 text-[var(--color-error)]" />
                {t('permMode.permShell')}
              </li>
              <li className="flex items-start gap-2">
                <Check aria-hidden="true" size={14} strokeWidth={2} className="mt-0.5 shrink-0 text-[var(--color-error)]" />
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
