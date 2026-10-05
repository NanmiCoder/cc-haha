import { useCallback, useId, useState, type FormEvent, type ReactNode } from 'react'
import { ChevronRight, PencilLine, Trash2 } from 'lucide-react'
import { useTranslation, type TranslationKey } from '../../i18n'
import { Button } from '@/components/ui/Button'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { Input } from '@/components/ui/Input'
import { MobileBottomSheet } from '@/components/ui/MobileBottomSheet'
import { Spinner } from '@/components/ui/Spinner'
import { StatusDot } from '@/components/ui/Badge'
import { useLongPress } from '../../hooks/useLongPress'
import { formatRelativeTime } from '../../lib/formatRelativeTime'
import { releaseWorkspaceSession } from '../../lib/workspace/releaseSession'
import { useSessionStore } from '../../stores/sessionStore'
import { useChatStore } from '../../stores/chatStore'
import { useTabStore } from '../../stores/tabStore'
import { useUIStore } from '../../stores/uiStore'
import type { SessionListItem } from '../../types/session'
import { SessionAttentionMark } from '../layout/SessionAttentionMark'
import type { MobileSessionGroup, MobileSessionGroupId } from './mobileSessionGroups'

const GROUP_LABEL_KEYS: Record<MobileSessionGroupId, TranslationKey> = {
  attention: 'mobile.group.attention',
  running: 'sidebar.taskGroup.running',
  today: 'sidebar.taskGroup.today',
  yesterday: 'sidebar.taskGroup.yesterday',
  last7Days: 'sidebar.taskGroup.last7Days',
  last30Days: 'sidebar.taskGroup.last30Days',
  earlier: 'sidebar.taskGroup.earlier',
}

type Props = {
  groups: MobileSessionGroup[]
  runningIds: ReadonlySet<string>
  attentionIds: ReadonlySet<string>
  /** Highlighted row, for the tablet pane where the open session sits beside the list. */
  selectedSessionId?: string | null
  workspaceLabelFor: (session: SessionListItem) => string
  onOpen: (session: SessionListItem) => void
}

/**
 * The phone's session list. Tapping a row opens the session; pressing and
 * holding it opens a sheet with rename and delete, which on the desktop live
 * behind a right click that a phone cannot make.
 */
export function MobileSessionList({
  groups,
  runningIds,
  attentionIds,
  selectedSessionId = null,
  workspaceLabelFor,
  onOpen,
}: Props) {
  const t = useTranslation()
  const [actionSession, setActionSession] = useState<SessionListItem | null>(null)
  const [renaming, setRenaming] = useState<SessionListItem | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [pendingDelete, setPendingDelete] = useState<SessionListItem | null>(null)
  const renameSession = useSessionStore((state) => state.renameSession)
  const deleteSession = useSessionStore((state) => state.deleteSession)
  const addToast = useUIStore((state) => state.addToast)

  const closeActions = useCallback(() => setActionSession(null), [])
  const rowHintId = useId()

  const startRename = () => {
    if (!actionSession) return
    setRenameValue(actionSession.title || '')
    setRenaming(actionSession)
    setActionSession(null)
  }

  const submitRename = async (event: FormEvent) => {
    event.preventDefault()
    if (!renaming) return
    const title = renameValue.trim()
    const session = renaming
    setRenaming(null)
    if (!title || title === session.title) return
    try {
      await renameSession(session.id, title)
    } catch {
      addToast({ type: 'error', message: t('mobile.session.renameFailed') })
    }
  }

  const confirmDelete = async () => {
    if (!pendingDelete) return
    const sessionId = pendingDelete.id
    setPendingDelete(null)
    try {
      await deleteSession(sessionId)
    } catch {
      addToast({ type: 'error', message: t('mobile.session.deleteFailed') })
      return
    }
    useChatStore.getState().disconnectSession(sessionId)
    releaseWorkspaceSession(sessionId)
    useTabStore.getState().closeTab(sessionId)
  }

  return (
    <>
      <div data-testid="mobile-session-list" className="flex flex-col pb-3">
        <p id={rowHintId} className="sr-only">{t('mobile.session.actionsHint')}</p>
        {groups.map((group) => (
          <section key={group.id} aria-labelledby={`mobile-session-group-${group.id}`}>
            <h2
              id={`mobile-session-group-${group.id}`}
              className={`sticky top-0 z-[var(--z-raised)] flex items-center gap-1.5 bg-[var(--color-surface)] px-4 pb-1.5 pt-3 text-[12px] font-medium ${
                group.id === 'attention'
                  ? 'text-[var(--color-on-warning-container)]'
                  : 'text-[var(--color-text-tertiary)]'
              }`}
            >
              {t(GROUP_LABEL_KEYS[group.id])}
              <span className="tabular-nums">· {group.sessions.length}</span>
            </h2>
            <ul className={group.id === 'attention'
              ? 'mx-3 overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-warning)] bg-[var(--color-warning-container)]'
              : 'mx-3'}
            >
              {group.sessions.map((session) => (
                <li key={session.id} className="border-b border-[var(--color-border)] last:border-b-0">
                  <MobileSessionRow
                    session={session}
                    running={runningIds.has(session.id)}
                    waiting={attentionIds.has(session.id)}
                    selected={session.id === selectedSessionId}
                    workspaceLabel={workspaceLabelFor(session)}
                    hintId={rowHintId}
                    onOpen={onOpen}
                    onLongPress={setActionSession}
                  />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      <MobileBottomSheet
        open={actionSession !== null}
        onClose={closeActions}
        title={<span className="block truncate">{actionSession?.title || t('session.untitled')}</span>}
        ariaLabel={actionSession?.title || t('session.untitled')}
        closeLabel={t('common.close')}
        testId="mobile-session-actions"
      >
        <div className="flex flex-col p-2" role="menu">
          <SheetAction icon={<PencilLine size={18} strokeWidth={1.75} aria-hidden="true" />} onClick={startRename}>
            {t('common.rename')}
          </SheetAction>
          <SheetAction
            danger
            icon={<Trash2 size={18} strokeWidth={1.75} aria-hidden="true" />}
            onClick={() => {
              setPendingDelete(actionSession)
              setActionSession(null)
            }}
          >
            {t('common.delete')}
          </SheetAction>
        </div>
      </MobileBottomSheet>

      <MobileBottomSheet
        open={renaming !== null}
        onClose={() => setRenaming(null)}
        title={t('mobile.session.renameTitle')}
        closeLabel={t('common.close')}
        testId="mobile-session-rename"
      >
        <form className="flex flex-col gap-3 p-4" onSubmit={submitRename}>
          <Input
            label={t('mobile.session.renameLabel')}
            size="xl"
            value={renameValue}
            autoFocus
            onChange={(event) => setRenameValue(event.target.value)}
          />
          <div className="grid grid-cols-2 gap-2">
            <Button type="button" variant="secondary" size="lg" block onClick={() => setRenaming(null)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" variant="primary" size="lg" block disabled={!renameValue.trim()}>
              {t('common.save')}
            </Button>
          </div>
        </form>
      </MobileBottomSheet>

      <ConfirmDialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
        title={t('common.delete')}
        body={pendingDelete ? t('sidebar.confirmDelete') : ''}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        confirmVariant="danger"
      />
    </>
  )
}

function MobileSessionRow({
  session,
  running,
  waiting,
  selected,
  workspaceLabel,
  hintId,
  onOpen,
  onLongPress,
}: {
  session: SessionListItem
  running: boolean
  waiting: boolean
  selected: boolean
  workspaceLabel: string
  hintId: string
  onOpen: (session: SessionListItem) => void
  onLongPress: (session: SessionListItem) => void
}) {
  const t = useTranslation()
  const longPress = useLongPress({ onLongPress: () => onLongPress(session) })
  const relativeTime = formatRelativeTime(session.modifiedAt, t)
  const title = session.title || t('session.untitled')

  return (
    <button
      type="button"
      data-mobile-session-id={session.id}
      aria-current={selected ? 'true' : undefined}
      aria-describedby={hintId}
      onClick={() => onOpen(session)}
      {...longPress}
      className={`flex min-h-[56px] w-full select-none items-center gap-3 px-1 py-2 text-left [-webkit-touch-callout:none] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-border-focus)] ${
        selected ? 'rounded-[var(--radius-md)] bg-[var(--color-surface-selected)]' : 'active:bg-[var(--color-surface-hover)]'
      }`}
    >
      <span className="flex h-5 w-5 shrink-0 items-center justify-center">
        {waiting ? (
          <SessionAttentionMark label={t('mobile.session.waiting')} />
        ) : running ? (
          <span role="img" aria-label={t('mobile.session.running')} className="inline-flex text-[var(--color-info)]">
            <Spinner size={14} />
          </span>
        ) : (
          <StatusDot tone="neutral" size="sm" />
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[14px] font-medium leading-5 text-[var(--color-text-primary)]">{title}</span>
        <span className="truncate text-[12px] leading-4 text-[var(--color-text-tertiary)]">
          {[workspaceLabel, relativeTime].filter(Boolean).join(' · ')}
        </span>
      </span>
      <ChevronRight size={16} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-[var(--color-text-tertiary)]" />
    </button>
  )
}

function SheetAction({
  icon,
  danger = false,
  onClick,
  children,
}: {
  icon: ReactNode
  danger?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={`flex min-h-12 items-center gap-3 rounded-[var(--radius-md)] px-3 text-left text-[15px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] active:bg-[var(--color-surface-hover)] ${
        danger ? 'text-[var(--color-error)]' : 'text-[var(--color-text-primary)]'
      }`}
    >
      {icon}
      {children}
    </button>
  )
}
