import { useEffect, useId, useMemo, useState, type FormEvent } from 'react'
import { ArrowUp, ListChecks, MessageCircleQuestion, Shield } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { Button } from '@/components/ui/Button'
import { MobileBottomSheet } from '@/components/ui/MobileBottomSheet'
import { listPendingPermissions, useChatStore, type PendingPermission } from '../../stores/chatStore'
import { AskUserQuestion } from './AskUserQuestion'
import { PermissionDialog } from './PermissionDialog'
import { isExitPlanModeTool } from './PlanModePreview'
import { PERMISSION_TOOL_ICONS, extractToolDetails, getPermissionTitle } from './permissionPresentation'

type DecisionKind = 'tool' | 'plan' | 'question'

function kindOf(request: PendingPermission): DecisionKind {
  if (request.toolName === 'AskUserQuestion') return 'question'
  if (isExitPlanModeTool(request.toolName)) return 'plan'
  return 'tool'
}

function firstQuestionText(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const questions = (input as { questions?: unknown }).questions
  if (!Array.isArray(questions)) return ''
  const first = questions[0] as { question?: unknown } | undefined
  return typeof first?.question === 'string' ? first.question : ''
}

/**
 * The phone's answer to "something is waiting for you": while a request is
 * open, this takes the composer's place at the bottom of the session, where
 * the thumb and the eye already are, and the transcript above stays readable.
 *
 * A tool request is answered here in one tap. Typing a reason denies it with
 * that reason, which is what a reply to a request means. A plan or a question
 * needs room to read, so the bar opens the full card in a sheet. Requests are
 * answered in the order they arrived; the count says how many are queued.
 */
export function MobileApprovalDock({ sessionId }: { sessionId: string }) {
  const t = useTranslation()
  const session = useChatStore((state) => state.sessions[sessionId])
  const respondToPermission = useChatStore((state) => state.respondToPermission)
  const pending = useMemo(() => listPendingPermissions(session), [session])
  const current = pending[0]
  const requestId = current?.requestId ?? null
  const [detailOpen, setDetailOpen] = useState(false)
  const [reasonOpen, setReasonOpen] = useState(false)
  const [reason, setReason] = useState('')
  const reasonId = useId()

  // A new request starts closed and empty, whatever the last one was doing.
  useEffect(() => {
    setDetailOpen(false)
    setReasonOpen(false)
    setReason('')
  }, [requestId])

  if (!current) return null

  const kind = kindOf(current)
  const position = pending.length > 1 ? t('mobile.approval.position', { index: 1, total: pending.length }) : null

  let Icon = PERMISSION_TOOL_ICONS[current.toolName] ?? Shield
  let title: string
  let detail = ''
  if (kind === 'question') {
    Icon = MessageCircleQuestion
    title = t('mobile.approval.questionTitle')
    detail = firstQuestionText(current.input)
  } else if (kind === 'plan') {
    Icon = ListChecks
    title = t('permission.planReadyTitle')
    detail = current.description ?? ''
  } else {
    title = getPermissionTitle(current.toolName, current.input, t, current.displayName)
    detail = extractToolDetails(current.toolName, current.input, t).primary || current.description || current.toolName
  }

  const submitReason = (event: FormEvent) => {
    event.preventDefault()
    const message = reason.trim()
    if (!message) return
    respondToPermission(sessionId, current.requestId, false, { denyMessage: message })
  }

  return (
    <div
      data-testid="mobile-approval-dock"
      data-kind={kind}
      role="region"
      aria-label={title}
      className="flex flex-col gap-2.5 rounded-[var(--radius-xl)] border border-[var(--color-warning)] bg-[var(--color-warning-container)] p-3 shadow-[var(--shadow-raised)]"
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-[var(--color-surface-container-lowest)] text-[var(--color-on-warning-container)]">
          <Icon size={16} strokeWidth={1.75} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="min-w-0 flex-1 truncate text-[14px] font-semibold leading-5 text-[var(--color-text-primary)]">{title}</h2>
            {position ? (
              <span className="shrink-0 text-[12px] tabular-nums text-[var(--color-on-warning-container)]">{position}</span>
            ) : null}
          </div>
          {detail ? (
            <p
              className={`mt-0.5 line-clamp-2 break-words text-[12px] leading-[1.5] text-[var(--color-text-secondary)] ${
                kind === 'tool' ? 'font-mono' : ''
              }`}
            >
              {detail}
            </p>
          ) : null}
        </div>
      </div>

      {kind === 'tool' ? (
        <>
          <div className="grid grid-cols-[1fr_1.4fr] gap-2">
            <Button
              variant="secondary"
              size="lg"
              block
              onClick={() => respondToPermission(sessionId, current.requestId, false)}
            >
              {t('permission.deny')}
            </Button>
            <Button
              variant="primary"
              size="lg"
              block
              onClick={() => respondToPermission(sessionId, current.requestId, true)}
            >
              {t('permission.allow')}
            </Button>
          </div>
          <div className="flex items-center justify-between gap-2">
            <Button variant="ghost" size="md" onClick={() => setDetailOpen(true)}>
              {t('mobile.approval.viewDetails')}
            </Button>
            <Button
              variant="ghost"
              size="md"
              onClick={() => respondToPermission(sessionId, current.requestId, true, { rule: 'always' })}
            >
              {t('permission.allowForSession')}
            </Button>
          </div>
          {reasonOpen ? (
            <form onSubmit={submitReason} className="flex items-center gap-2">
              <label htmlFor={reasonId} className="sr-only">{t('mobile.approval.reasonLabel')}</label>
              <input
                id={reasonId}
                value={reason}
                autoFocus
                onChange={(event) => setReason(event.target.value)}
                placeholder={t('mobile.approval.reasonPlaceholder')}
                className="h-11 min-w-0 flex-1 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] px-3 text-[15px] text-[var(--color-text-primary)] outline-none focus:border-[var(--color-border-focus)]"
              />
              <Button
                type="submit"
                variant="accent"
                size="lg"
                shape="circle"
                disabled={!reason.trim()}
                aria-label={t('mobile.approval.denyWithReason')}
                className="h-11 w-11 shrink-0"
                icon={<ArrowUp size={18} strokeWidth={2} aria-hidden="true" />}
              />
            </form>
          ) : (
            <button
              type="button"
              onClick={() => setReasonOpen(true)}
              className="min-h-9 text-center text-[12px] text-[var(--color-text-tertiary)] underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
            >
              {t('mobile.approval.denyWithReasonHint')}
            </button>
          )}
        </>
      ) : (
        <Button variant="primary" size="lg" block onClick={() => setDetailOpen(true)}>
          {kind === 'question' ? t('mobile.approval.answer') : t('mobile.approval.reviewPlan')}
        </Button>
      )}

      <MobileBottomSheet
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        title={title}
        closeLabel={t('common.close')}
        testId="mobile-approval-sheet"
        tall
        contentClassName="p-3"
      >
        {kind === 'question' ? (
          <AskUserQuestion sessionId={sessionId} toolUseId={current.toolUseId ?? current.requestId} input={current.input} />
        ) : (
          <PermissionDialog
            sessionId={sessionId}
            requestId={current.requestId}
            toolName={current.toolName}
            input={current.input}
            description={current.description}
            displayName={current.displayName}
          />
        )}
      </MobileBottomSheet>
    </div>
  )
}
