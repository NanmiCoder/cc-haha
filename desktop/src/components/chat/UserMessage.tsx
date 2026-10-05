import { Button } from '@/components/ui/Button'
import { openSessionSource, sessionSourceTitle } from '@/lib/sessionNavigation'
import { memo, useCallback, useMemo } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { UsersRound } from 'lucide-react'
import type { UIAttachment } from '../../types/chat'
import { useTranslation } from '../../i18n'
import { openPreviewLink } from '../../lib/openPreviewLink'
import { splitTextByUrls } from '../../lib/urlBoundary'
import { AttachmentGallery } from './AttachmentGallery'
import { MessageActionBar, type MessageBranchAction, type MessageEditAction } from './MessageActionBar'
import { UserMessageEditor } from './UserMessageEditor'
import type { UserMessageEditDraft } from './userMessageEdit'
import { MarkdownRenderer } from '../markdown/MarkdownRenderer'

/**
 * Edit-and-resend for one prompt. The draft lives with the caller, not in this
 * component, so it survives the row being virtualized away and remounted.
 */
export type UserMessageEditAction = {
  label: string
  editing: boolean
  submitting: boolean
  disabled: boolean
  /** Why the action is disabled, when the user can do something about it. */
  disabledReason?: string
  getDraft: () => UserMessageEditDraft
  onStart: () => void
  onCancel: () => void
  onDraftChange: (draft: UserMessageEditDraft) => void
  onSubmit: (draft: UserMessageEditDraft) => void
}

type Props = {
  content: string
  sessionReferences?: Array<{ sessionId: string }>
  /** Set when this message was delivered from another collaborating session. */
  collaboration?: { sourceSessionId: string; messageId?: string }
  attachments?: UIAttachment[]
  branchAction?: MessageBranchAction
  editAction?: UserMessageEditAction
  timestamp?: number
  sessionId?: string
  /** Set when this turn came from another agent rather than from the user. */
  teammateFrom?: string
  teammateAvatarSrc?: string
  teammateAvatarKey?: string
  teammateAccent?: string
}

export const UserMessage = memo(function UserMessage({
  content,
  sessionReferences,
  collaboration,
  attachments,
  branchAction,
  editAction,
  timestamp,
  sessionId,
  teammateFrom,
  teammateAvatarSrc,
  teammateAvatarKey,
  teammateAccent,
}: Props) {
  const t = useTranslation()
  const hasText = content.trim().length > 0
  const actionBarEditAction = useMemo<MessageEditAction | undefined>(
    () => editAction
      ? {
          label: editAction.label,
          disabled: editAction.disabled,
          disabledReason: editAction.disabledReason,
          onEdit: editAction.onStart,
        }
      : undefined,
    [editAction],
  )

  // The operator's prompt is literal text, NOT markdown — `**`, `#` and file
  // paths have to stay exactly as typed. Teammate traffic is rendered separately
  // below because agent-to-agent messages intentionally use Markdown.
  const segments = useMemo(() => splitTextByUrls(content), [content])

  const handleLinkClick = useCallback(
    (href: string, event: ReactMouseEvent<HTMLElement>): boolean => {
      if (!sessionId) return false
      const handled = openPreviewLink(href, sessionId)
      if (handled) event.preventDefault()
      return handled
    },
    [sessionId],
  )

  const body: ReactNode = segments.map((segment, index) =>
    segment.type === 'url' ? (
      <a
        key={index}
        href={segment.value}
        target="_blank"
        rel="noreferrer noopener"
        className="text-[var(--color-text-accent)] underline decoration-[1px] underline-offset-[3px] decoration-[var(--color-text-accent)] [overflow-wrap:anywhere] hover:decoration-[2px]"
        onClick={(event) => handleLinkClick(segment.value, event)}
      >
        {segment.value}
      </a>
    ) : (
      segment.value
    ),
  )

  // A teammate's instruction is not the user speaking, so it does not take the
  // user's right-aligned bubble. Attributing and left-aligning it is what gives
  // a member transcript the same read-at-a-glance structure the main session
  // has: prompt right, everything the agents said left.
  if (teammateFrom) {
    return (
      <div className="flex justify-start">
        <div
          data-message-shell="teammate"
          data-teammate-from={teammateFrom}
          className="group relative flex min-w-0 max-w-[82%] flex-col items-start lg:max-w-[680px]"
        >
          <div className="mb-1.5 flex min-w-0 items-center gap-2 px-0.5 text-xs text-[var(--color-text-tertiary)]">
            {teammateAvatarSrc ? (
              <span
                data-testid="teammate-message-avatar"
                data-avatar-key={teammateAvatarKey}
                aria-hidden="true"
                className="relative h-8 w-7 shrink-0"
              >
                <img
                  src={teammateAvatarSrc}
                  alt=""
                  draggable={false}
                  className="h-full w-full select-none object-contain drop-shadow-[0_2px_2px_rgba(0,0,0,0.14)]"
                />
                <span
                  className="absolute bottom-0 left-1/2 h-1 w-4 -translate-x-1/2 rounded-full border border-[var(--color-surface)]"
                  style={{ background: teammateAccent }}
                />
              </span>
            ) : (
              <UsersRound size={12} strokeWidth={2} aria-hidden="true" className="shrink-0 text-[var(--color-text-tertiary)]" />
            )}
            <span className="min-w-0 truncate font-mono font-medium text-[var(--color-text-secondary)]">
              {teammateFrom}
            </span>
            <span className="shrink-0">{t('chat.teammateMessage')}</span>
          </div>

          <div className="flex max-w-full flex-col items-start gap-2">
            {attachments && attachments.length > 0 && (
              <AttachmentGallery attachments={attachments} variant="message" />
            )}
            {hasText && (
              <div
                data-message-body="teammate"
                className="min-w-0 max-w-full rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] px-3.5 py-2.5 chat-reading-text text-[var(--color-text-primary)]"
                style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}
              >
                <MarkdownRenderer
                  content={content}
                  onLinkClick={sessionId ? handleLinkClick : undefined}
                  className="chat-reading-markdown [&>:first-child]:mt-0 [&>:last-child]:mb-0"
                />
              </div>
            )}
          </div>

          {hasText && (
            <MessageActionBar
              copyText={content}
              copyLabel={t('chat.copyPrompt')}
              align="start"
              placement="overlay"
              timestamp={timestamp}
            />
          )}
        </div>
      </div>
    )
  }

  if (editAction?.editing) {
    return (
      <div className="flex justify-end">
        <div
          data-message-shell="user"
          data-editing="true"
          className="flex w-full min-w-0 max-w-[82%] flex-col items-stretch lg:max-w-[640px]"
        >
          <UserMessageEditor
            initialDraft={editAction.getDraft()}
            submitting={editAction.submitting}
            disabled={editAction.disabled}
            onDraftChange={editAction.onDraftChange}
            onCancel={editAction.onCancel}
            onSubmit={editAction.onSubmit}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="flex justify-end">
      <div
        data-message-shell="user"
        className="group relative flex min-w-0 max-w-[82%] flex-col items-end lg:max-w-[640px]"
      >
        <div className="flex max-w-full flex-col items-end gap-2">
          {collaboration ? <div className="px-0.5 text-[11px] text-[var(--color-text-tertiary)]">
            <Button size="sm" variant="ghost" onClick={() => openSessionSource(collaboration.sourceSessionId)}>{t('chat.collaborationMessageFrom', { id: sessionSourceTitle(collaboration.sourceSessionId) })}</Button>
          </div> : null}
          {sessionReferences?.length ? <div className="flex max-w-full flex-wrap gap-1" aria-label={t('chat.referenceSessions')}>
            {sessionReferences.map(reference => <Button key={reference.sessionId} size="sm" variant="ghost" onClick={() => openSessionSource(reference.sessionId)}>{t('chat.openReferencedSession', { id: sessionSourceTitle(reference.sessionId) })}</Button>)}
          </div> : null}
          {attachments && attachments.length > 0 && (
            <AttachmentGallery attachments={attachments} variant="message" />
          )}

          {hasText && (
            <div
              data-message-body="user"
              className="min-w-0 max-w-full rounded-[var(--radius-lg)] bg-[var(--color-surface-user-msg)] px-3.5 py-2.5 chat-reading-text text-[var(--color-text-primary)] whitespace-pre-wrap break-words"
              style={{
                overflowWrap: 'anywhere',
                wordBreak: 'break-word',
              }}
            >
              {body}
            </div>
          )}
        </div>

        {(hasText || actionBarEditAction) && (
          <MessageActionBar
            copyText={content}
            copyLabel={t('chat.copyPrompt')}
            branchAction={branchAction}
            editAction={actionBarEditAction}
            align="end"
            placement="overlay"
            timestamp={timestamp}
          />
        )}
      </div>
    </div>
  )
})
