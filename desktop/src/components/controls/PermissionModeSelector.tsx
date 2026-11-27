import { useSideChatStore } from '@/stores/sideChatStore'
import { forwardRef, useState, useRef, useEffect, useCallback, useId, useImperativeHandle } from 'react'
import DOMPurify from 'dompurify'
import { Check, ChevronDown, CirclePlay, DraftingCompass, Folder, Gavel, ShieldCheck, Zap, type LucideIcon } from 'lucide-react'
import { useDismissable } from '@/hooks/useDismissable'
import { useRoomAbove } from '@/hooks/useRoomAbove'
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
import { useResolvedPermissionMode } from './permissionModeState'
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

export type PermissionModeSelectorHandle = {
  /** Opens the mode menu, as a tap on the trigger would. */
  open: () => void
}

type Props = {
  lean?: boolean
  sessionId?: string
  workDir?: string
  compact?: boolean
  /**
   * `chip` always shows the trigger. `elevatedOnly` hides it while every write
   * still asks first: the phone composer keeps the mode in its + sheet, and
   * only puts the trigger on the toolbar once some writes run unattended — the
   * one state worth a glance. `quiet` shows only the mode glyph in the default
   * mode (every write asks first) and the full chip (risk dot, label) in any
   * other, plan mode included: the default stays out of the way, and a
   * departure from it is named.
   */
  trigger?: 'chip' | 'elevatedOnly' | 'quiet'
  menuPlacement?: 'top' | 'bottom'
  /**
   * Which trigger edge the desktop menu lines up with. `right` keeps it inside
   * the container when the trigger sits at the end of a row, as in Settings.
   */
  menuAlign?: 'left' | 'right'
  /** Controlled mode: override current value */
  value?: PermissionMode
  /** Controlled mode: called on change instead of updating global store */
  onChange?: (mode: PermissionMode) => void
  /** Restrict selectable modes (e.g. Antigravity supports default/acceptEdits/auto/plan/bypassPermissions). */
  allowedModes?: readonly PermissionMode[]
  /** Use Antigravity ACP mode labels/descriptions and skip Claude-only Auto opt-in dialog. */
  antigravity?: boolean
}

export const PermissionModeSelector = forwardRef<PermissionModeSelectorHandle, Props>(function PermissionModeSelector(
  { lean = false, sessionId, workDir: workDirProp, compact = false, trigger = 'chip', menuPlacement = 'top', menuAlign = 'left', value, onChange, allowedModes, antigravity = false }: Props = {},
  handleRef,
) {
  const t = useTranslation()
  const isMobile = useMobileViewport() && !isDesktopRuntime()
  const {
    autoModeOptInAccepted,
    acceptAutoModeOptIn,
  } = useSettingsStore()
  const setSessionPermissionMode = useChatStore((s) => s.setSessionPermissionMode)
  const selectedTabId = useTabStore((s) => s.activeTabId)
  const activeTabId = sessionId ?? selectedTabId
  const sideChat = useSideChatStore(s => activeTabId ? s.entries[activeTabId] : undefined)
  const sessions = useSessionStore((s) => s.sessions)
  const [open, setOpen] = useState(false)
  const [confirmDialog, setConfirmDialog] = useState(false)
  const [autoDialog, setAutoDialog] = useState(false)
  const [autoConsentPending, setAutoConsentPending] = useState(false)
  const interactionTabIdRef = useRef<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [roomRef, menuRoom, roomSide] = useRoomAbove<HTMLDivElement>({ allowBelow: menuPlacement !== 'bottom' })
  const setDesktopMenuRef = useCallback((node: HTMLDivElement | null) => {
    menuRef.current = node
    roomRef(node)
  }, [roomRef])

  const isControlled = value !== undefined
  const PERMISSION_ITEMS: Array<{
    value: PermissionMode
    label: string
    description: string
    color?: string
    /** Display-only flag on the row; carries no behaviour. */
    badge?: { tone: 'warning' | 'danger'; label: string }
  }> = antigravity
    ? [
        {
          value: 'default',
          label: t('permMode.antigravity.default'),
          description: t('permMode.antigravity.defaultDesc'),
        },
        {
          value: 'acceptEdits',
          label: t('permMode.antigravity.acceptEdits'),
          description: t('permMode.antigravity.acceptEditsDesc'),
        },
        {
          value: 'auto',
          label: t('permMode.antigravity.auto'),
          description: t('permMode.antigravity.autoDesc'),
        },
        {
          value: 'plan',
          label: t('permMode.antigravity.plan'),
          description: t('permMode.antigravity.planDesc'),
        },
        {
          value: 'bypassPermissions',
          label: t('permMode.antigravity.bypass'),
          description: t('permMode.antigravity.bypassDesc'),
          color: 'text-[var(--color-error)]',
          badge: { tone: 'danger', label: t('permMode.badge.risky') },
        },
      ]
    : [
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
    bypassPermissions: antigravity ? t('permMode.antigravity.label.bypassPermissions') : t('permMode.label.bypassPermissions'),
    dontAsk: t('permMode.label.dontAsk'),
  }

  const activeSession = activeTabId
    ? sessions.find((s) => s.id === activeTabId)
    : null
  const currentMode = useResolvedPermissionMode(sessionId, value)
  const workDir = workDirProp || activeSession?.workDir || sideChat?.workDir || '~'
  // A quiet 28px chip on the composer row (risk dot + label + chevron); the
  // compact desktop form keeps only the mode glyph, and the phone form grows
  // to the 44px touch target.
  // Plan mode shares the default's green dot but is not the default: it stops
  // the agent from editing, so it is named rather than reduced to a glyph.
  const glyphOnly = compact || (trigger === 'quiet' && currentMode === 'default')
  const compactButtonClass = glyphOnly
    ? isMobile
      ? 'h-11 w-11 justify-center rounded-[var(--radius-card-inner)] p-0'
      : 'h-7 w-7 justify-center rounded-[var(--radius-control)] p-0'
    : 'v6c-raised v6c-pressable h-7 gap-1.5 rounded-[var(--radius-control)] border border-[var(--color-surface-glass-border)] px-2 text-xs'
  const TriggerIcon = MODE_ICONS[currentMode]
  const effectivePlacement = menuPlacement === 'bottom' ? 'bottom' : roomSide
  const menuPlacementClass = effectivePlacement === 'bottom'
    ? 'top-full mt-2'
    : 'bottom-full mb-2'
  const menuAlignClass = menuAlign === 'right' ? 'right-0' : 'left-0'
  // Generated, not hard-coded: the previous literal id was rendered by both the
  // sheet branch and the desktop branch, so `aria-controls` pointed at whichever
  // duplicate the browser resolved first.
  const menuId = useId()

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

  const openMenu = useCallback(() => {
    interactionTabIdRef.current = sessionId ?? useTabStore.getState().activeTabId
    setOpen(true)
  }, [sessionId])

  useImperativeHandle(handleRef, () => ({ open: openMenu }), [openMenu])

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
      {PERMISSION_ITEMS.filter(item => (
        (!allowedModes || allowedModes.includes(item.value)) &&
        !((lean || activeSession?.agentProfile === 'lean') && item.value === 'plan')
      )).map((item) => (
        <button
          key={item.value}
          type="button"
          role="menuitem"
          onClick={() => {
            const actionTabId = sessionId ?? useTabStore.getState().activeTabId
            if (actionTabId !== interactionTabIdRef.current) {
              setOpen(false)
              setConfirmDialog(false)
              setAutoDialog(false)
              interactionTabIdRef.current = null
              return
            }
            if (!antigravity && item.value === 'auto' && item.value !== currentMode) {
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
            <Check aria-hidden="true" size={14} strokeWidth={1.75} className="mt-0.5 shrink-0 text-[var(--color-brand)]" />
          )}
        </button>
      ))}
    </>
  )

  const showTrigger = trigger !== 'elevatedOnly' || MODE_DOT_TONE[currentMode] !== 'success'

  return (
    <div ref={ref} className="relative">
      {showTrigger ? (
      <button
        type="button"
        onClick={() => {
          const actionTabId = sessionId ?? useTabStore.getState().activeTabId
          if (open) {
            setOpen(false)
            interactionTabIdRef.current = null
            return
          }
          interactionTabIdRef.current = actionTabId
          setOpen(true)
        }}
        aria-label={MODE_LABELS[currentMode]}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title={glyphOnly ? MODE_LABELS[currentMode] : undefined}
        // `shrink-0` / `whitespace-nowrap`: it shares the composer toolbar with
        // the run-location pill, whose branch name can be arbitrarily long.
        // Without these the label wrapped to two lines and grew the whole row.
        className={`flex shrink-0 items-center whitespace-nowrap text-[var(--color-text-secondary)] transition-[background-color,color,border-color,box-shadow,transform] duration-150 ease-out hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] ${
          glyphOnly
            ? `hover:bg-[var(--color-surface-hover)] ${open ? 'bg-[var(--color-surface-hover)] text-[var(--color-text-primary)]' : ''}`
            : `hover:[background:var(--v6c-raised-fill-hover)] ${open ? '[background:var(--v6c-raised-fill-hover)] text-[var(--color-text-primary)]' : ''}`
        } ${compactButtonClass}`}
      >
        {glyphOnly ? (
          <TriggerIcon data-mode-icon={currentMode} aria-hidden="true" size={isMobile ? 18 : 14} strokeWidth={1.75} />
        ) : (
          <StatusDot tone={MODE_DOT_TONE[currentMode]} data-testid="permission-mode-dot" />
        )}
        {!glyphOnly && (
          <>
            <span>{MODE_LABELS[currentMode]}</span>
            <ChevronDown aria-hidden="true" size={12} strokeWidth={1.75} className="text-[var(--color-text-tertiary)]" />
          </>
        )}
      </button>
      ) : null}

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
          <div
            id={menuId}
            ref={setDesktopMenuRef}
            role="menu"
            style={menuPlacement !== 'bottom' && menuRoom ? { maxHeight: menuRoom } : undefined}
            className={`absolute ${menuAlignClass} ${menuPlacementClass} z-[var(--z-dropdown)] scrollbar-autohide w-[340px] overflow-y-auto ${COMPOSER_POPOVER}`}
          >
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
              dangerouslySetInnerHTML={{
                __html: DOMPurify.sanitize(
                  t(antigravity ? 'permMode.antigravity.enableBypassBody' : 'permMode.enableBypassBody'),
                ),
              }}
            />
            <div className="flex items-center gap-2 rounded-[var(--radius-card-inner)] bg-[var(--color-surface-container)] px-3 py-2" title={workDir}>
              <Folder aria-hidden="true" size={14} strokeWidth={1.75} className="shrink-0 text-[var(--color-text-tertiary)]" />
              <code className="truncate font-mono text-xs text-[var(--color-text-primary)]">{workDir}</code>
            </div>
            <ul className="space-y-1.5 text-xs text-[var(--color-text-secondary)]">
              <li className="flex items-start gap-2">
                <Check aria-hidden="true" size={14} strokeWidth={1.75} className="mt-0.5 shrink-0 text-[var(--color-error)]" />
                {t('permMode.permReadWrite')}
              </li>
              <li className="flex items-start gap-2">
                <Check aria-hidden="true" size={14} strokeWidth={1.75} className="mt-0.5 shrink-0 text-[var(--color-error)]" />
                {t('permMode.permShell')}
              </li>
              <li className="flex items-start gap-2">
                <Check aria-hidden="true" size={14} strokeWidth={1.75} className="mt-0.5 shrink-0 text-[var(--color-error)]" />
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
              if (actionTabId !== interactionTabIdRef.current) {
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
          if (actionTabId !== interactionTabIdRef.current) {
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
            if (confirmedTabId !== interactionTabIdRef.current) return
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
})
