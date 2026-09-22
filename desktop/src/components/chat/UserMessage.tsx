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
import { MessageActionBar, type MessageBranchAction, type MessageRewindAction } from './MessageActionBar'
import { MarkdownRenderer } from '../markdown/MarkdownRenderer'

type Props = {
  content: string
  sessionReferences?: Array<{ sessionId: string }>
  /** Set when this message was delivered from another collaborating session. */
  collaboration?: { sourceSessionId: string; messageId?: string }
  attachments?: UIAttachment[]
  branchAction?: MessageBranchAction
  rewindAction?: MessageRewindAction
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
  rewindAction,
  timestamp,
  sessionId,
  teammateFrom,
  teammateAvatarSrc,
  teammateAvatarKey,
  teammateAccent,
}: Props) {
  const t = useTranslation()
  const hasText = content.trim().length > 0

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
          className="group flex min-w-0 max-w-[82%] flex-col items-start sm:max-w-[78%] lg:max-w-[680px]"
        >
          <div className="mb-1 flex min-w-0 items-center gap-2 px-0.5 text-[11px] text-[var(--color-text-tertiary)]">
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
              <UsersRound size={12} strokeWidth={2.2} aria-hidden="true" className="shrink-0 text-[var(--color-brand)]" />
            )}
            <span className="min-w-0 truncate font-mono font-bold text-[var(--color-text-secondary)]">
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
                className="min-w-0 max-w-full rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container)] px-[16px] py-[12px] text-[14px] leading-relaxed text-[var(--color-text-primary)]"
                style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}
              >
                <MarkdownRenderer
                  content={content}
                  onLinkClick={sessionId ? handleLinkClick : undefined}
                  className="[&>:first-child]:mt-0 [&>:last-child]:mb-0 [&_h1]:text-lg [&_h2]:text-base [&_h3]:text-sm [&_h4]:text-sm"
                />
              </div>
            )}
          </div>

          {hasText && (
            <MessageActionBar
              copyText={content}
              copyLabel={t('chat.copyPrompt')}
              align="start"
              timestamp={timestamp}
            />
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="flex justify-end">
      <div
        data-message-shell="user"
        className="group flex min-w-0 max-w-[82%] flex-col items-end sm:max-w-[78%] lg:max-w-[640px]"
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
              className="min-w-0 max-w-full rounded-[var(--radius-lg)] bg-[var(--color-surface-user-msg)] px-[18px] py-[13px] text-[14.5px] leading-relaxed text-[var(--color-text-primary)] whitespace-pre-wrap break-words"
              style={{
                overflowWrap: 'anywhere',
                wordBreak: 'break-word',
              }}
            >
              {body}
            </div>
          )}
        </div>

        {hasText && (
          <MessageActionBar
            copyText={content}
            copyLabel={t('chat.copyPrompt')}
            branchAction={branchAction}
            rewindAction={rewindAction}
            align="end"
            timestamp={timestamp}
          />
        )}
      </div>
    </div>
  )
})
