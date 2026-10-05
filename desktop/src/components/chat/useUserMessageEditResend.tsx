import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { sessionsApi, type SessionRewindMode, type SessionRewindResponse, type SessionTurnCheckpoint } from '../../api/sessions'
import type { ActionDialogAction } from '@/components/ui/ActionDialog'
import type { TranslationKey } from '../../i18n/locales/en'
import { useChatStore } from '../../stores/chatStore'
import { useUIStore } from '../../stores/uiStore'
import type { UIMessage } from '../../types/chat'
import { describeRewindResult, getApiErrorMessage, rewindToTurnCheckpoint } from './turnRewind'
import type { UserMessageEditAction } from './UserMessage'
import {
  buildUserMessageResendPayload,
  countLaterUserTurns,
  createUserMessageEditDraft,
  type UserMessageEditDraft,
  type UserMessageResendPayload,
} from './userMessageEdit'

type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string

/** The slice of a turn card the edit flow needs: who to rewind, and how. */
export type EditableTurnCard = {
  target: { messageId: string; expectedContent: string }
  checkpoint: { target: Pick<SessionTurnCheckpoint['target'], 'targetUserMessageId' | 'userMessageIndex'> }
  /** Files are never offered back, whatever the dry run finds: only the conversation rewinds. */
  conversationOnly?: boolean
}

type EditContext = { sessionId: string | null | undefined; active: boolean }

type PendingConfirm = {
  context: EditContext
  messageId: string
  card: EditableTurnCard
  draft: UserMessageEditDraft
  payload: UserMessageResendPayload
  preview: SessionRewindResponse
  laterTurns: number
  canRestoreCode: boolean
}

type Options = {
  sessionId: string | null | undefined
  messages: UIMessage[]
  turnCards: EditableTurnCard[]
  /**
   * Prompts whose turn has completed. While an edit cannot start, these keep a
   * disabled action that says why instead of losing it: a pencil that silently
   * comes and goes with background work reads as a missing feature.
   */
  completedMessageIds: ReadonlySet<string>
  /** Why no edit can start in this session right now (a turn or background work is running). */
  blockedReason: string | null
  /** Why a completed prompt has no rewind target yet; null once the targets are settled. */
  pendingReason: string | null
  /** An agent tab, a side chat, an open undo dialog: no edit action at all. */
  disabled: boolean
  rewindingTurnId: string | null
  setRewindingTurnId: (messageId: string | null) => void
  t: Translate
}

export type UserMessageEditDialog = {
  open: boolean
  title: string
  body: ReactNode
  actions: ActionDialogAction[]
  loading: boolean
  onClose: () => void
}

function isEditableUserMessage(message: UIMessage | undefined): message is Extract<UIMessage, { type: 'user_text' }> {
  return Boolean(
    message &&
    message.type === 'user_text' &&
    !message.pending &&
    !message.optimisticQueued &&
    !message.teammateFrom &&
    !message.collaboration,
  )
}

/**
 * Edit a prompt in place, then rewind to before it and send the edit.
 *
 * Only turns the rewind API can already target are editable, and the rewind is
 * the existing one: a dry run first, so the dialog describes the same range the
 * real rewind will touch, then `conversation` or `both` exactly as "undo this
 * turn" does. Until the rewind succeeds nothing has changed and the editor
 * keeps the draft; after it succeeds the edit is sent, or handed to the
 * composer if it cannot be.
 */
export function useUserMessageEditResend({
  sessionId,
  messages,
  turnCards,
  completedMessageIds,
  blockedReason,
  pendingReason,
  disabled,
  rewindingTurnId,
  setRewindingTurnId,
  t,
}: Options) {
  const [editing, setEditing] = useState<{ sessionId: string; messageId: string } | null>(null)
  const [submitting, setSubmitting] = useState<{ context: EditContext; messageId: string } | null>(null)
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null)
  const draftsRef = useRef(new Map<string, UserMessageEditDraft>())
  // A new identity also invalidates A → B → A requests and captured dialog actions.
  const contextRef = useRef<EditContext>({ sessionId, active: true })
  if (contextRef.current.sessionId !== sessionId) contextRef.current = { sessionId, active: true }
  const context = contextRef.current
  const editingMessageId = editing && editing.sessionId === sessionId ? editing.messageId : null
  const submittingMessageId = submitting?.context === context ? submitting.messageId : null
  const isCurrentContext = useCallback((candidate: EditContext) =>
    candidate.active && contextRef.current === candidate, [])

  useEffect(() => {
    const current = contextRef.current
    current.active = true
    setRewindingTurnId(null)
    return () => { current.active = false }
  }, [sessionId, setRewindingTurnId])

  const messagesRef = useRef(messages)
  messagesRef.current = messages

  const messageById = useMemo(() => {
    const result = new Map<string, Extract<UIMessage, { type: 'user_text' }>>()
    for (const message of messages) {
      if (message.type === 'user_text') result.set(message.id, message)
    }
    return result
  }, [messages])

  const editableCards = useMemo(() => {
    const result = new Map<string, EditableTurnCard>()
    for (const card of turnCards) {
      if (isEditableUserMessage(messageById.get(card.target.messageId))) {
        result.set(card.target.messageId, card)
      }
    }
    return result
  }, [messageById, turnCards])

  const contextReferencesOnly = useCallback(
    (count: number) => t('chat.contextReferencesOnly', { count }),
    [t],
  )

  const closeEditor = useCallback((targetSessionId: string, messageId: string) => {
    draftsRef.current.delete(JSON.stringify([targetSessionId, messageId]))
    setEditing((current) => current?.sessionId === targetSessionId && current.messageId === messageId ? null : current)
  }, [])

  const runResend = useCallback(async (
    requestContext: EditContext,
    messageId: string,
    card: EditableTurnCard,
    draft: UserMessageEditDraft,
    payload: UserMessageResendPayload,
    mode: SessionRewindMode,
  ) => {
    const targetSessionId = requestContext.sessionId
    if (!targetSessionId || !isCurrentContext(requestContext)) return
    const addToast = useUIStore.getState().addToast
    setRewindingTurnId(messageId)
    let result: SessionRewindResponse
    try {
      result = await rewindToTurnCheckpoint(targetSessionId, {
        checkpointTarget: card.checkpoint.target,
        expectedContent: card.target.expectedContent,
      }, mode)
    } catch (error) {
      // The server rewinds atomically: a failed rewind left the conversation
      // and the files as they were, so the draft stays open for another try.
      addToast({ type: 'error', message: t('chat.editResendFailed', { detail: getApiErrorMessage(error) }) })
      if (isCurrentContext(requestContext)) {
        setConfirm(null)
        setRewindingTurnId(null)
      }
      return
    }

    // From here the old turn is gone. The edit must reach either the model or
    // the composer — never be dropped with the editor.
    closeEditor(targetSessionId, messageId)
    if (isCurrentContext(requestContext)) setConfirm(null)
    const chatStore = useChatStore.getState()
    let sent = false
    try {
      const session = chatStore.sessions[targetSessionId]
      await chatStore.reloadHistory(targetSessionId, {
        messages: session?.messages ?? [],
        backgroundAgentTasks: session?.backgroundAgentTasks,
      }, { requireApplied: true })
      if (useChatStore.getState().sessions[targetSessionId]?.chatState === 'idle') {
        useChatStore.getState().sendMessage(targetSessionId, payload.content, payload.attachments, payload.options)
        sent = true
      }
    } catch {
      sent = false
    }
    if (!sent) {
      useChatStore.getState().queueComposerPrefill(targetSessionId, {
        text: draft.text,
        attachments: draft.attachments.filter((attachment) => attachment.sendable),
        ...(draft.sessionReferences.length > 0 ? { sessionReferences: draft.sessionReferences } : {}),
      }, { restoreMissingSession: true })
      addToast({ type: 'warning', message: t('chat.editResendPrefilled') })
    } else if (mode === 'both') {
      addToast(describeRewindResult(result, mode, t))
    }
    if (isCurrentContext(requestContext)) setRewindingTurnId(null)
  }, [closeEditor, isCurrentContext, setRewindingTurnId, t])

  const submit = useCallback(async (messageId: string, draft: UserMessageEditDraft) => {
    const requestContext = context
    if (!isCurrentContext(requestContext)) return
    const card = editableCards.get(messageId)
    if (!sessionId || !card || disabled || blockedReason || submittingMessageId || rewindingTurnId) return
    const payload = buildUserMessageResendPayload(draft, { contextReferencesOnly })
    if (!payload) return
    draftsRef.current.set(JSON.stringify([sessionId, messageId]), draft)

    setSubmitting({ context: requestContext, messageId })
    let preview: SessionRewindResponse
    try {
      preview = await sessionsApi.rewind(sessionId, {
        targetUserMessageId: card.checkpoint.target.targetUserMessageId,
        userMessageIndex: card.checkpoint.target.userMessageIndex,
        expectedContent: card.target.expectedContent,
        dryRun: true,
      })
    } catch (error) {
      if (!isCurrentContext(requestContext)) return
      useUIStore.getState().addToast({
        type: 'error',
        message: t('chat.editResendFailed', { detail: getApiErrorMessage(error) }),
      })
      setSubmitting(null)
      return
    }
    if (!isCurrentContext(requestContext)) return
    setSubmitting(null)

    const canRestoreCode = !card.conversationOnly &&
      preview.code.available &&
      preview.code.filesChanged.length > 0 &&
      preview.restoreAvailable !== false
    const laterTurns = countLaterUserTurns(messagesRef.current, messageId)
    // Nothing on disk to decide about and nothing beyond this turn to lose:
    // the edit is the whole consequence, so it goes straight through.
    if (!canRestoreCode && preview.restoreAvailable !== false && laterTurns === 0) {
      await runResend(requestContext, messageId, card, draft, payload, 'conversation')
      return
    }
    setConfirm({ context: requestContext, messageId, card, draft, payload, preview, laterTurns, canRestoreCode })
  }, [blockedReason, context, contextReferencesOnly, disabled, editableCards, isCurrentContext, rewindingTurnId, runResend, sessionId, submittingMessageId, t])

  const editActionByMessageId = useMemo(() => {
    const result = new Map<string, UserMessageEditAction>()
    if (!sessionId) return result
    const label = t('chat.editMessage')
    for (const messageId of new Set([...editableCards.keys(), ...completedMessageIds])) {
      const message = messageById.get(messageId)
      if (!isEditableUserMessage(message)) continue
      const card = editableCards.get(messageId)
      const editing = editingMessageId === messageId
      // A disabled session offers no new edits, but an open editor stays open
      // (disabled) instead of discarding what the user typed.
      if (disabled && !editing) continue
      const unavailableReason = blockedReason ?? (card ? null : pendingReason)
      // Settled targets without this prompt: the rewind API cannot address it.
      if (!card && !unavailableReason && !editing) continue
      result.set(messageId, {
        label,
        editing,
        submitting: submittingMessageId === messageId || rewindingTurnId === messageId,
        disabled: disabled || !card || Boolean(unavailableReason) ||
          Boolean(rewindingTurnId && rewindingTurnId !== messageId),
        ...(unavailableReason ? { disabledReason: unavailableReason } : {}),
        getDraft: () => draftsRef.current.get(JSON.stringify([sessionId, messageId])) ?? createUserMessageEditDraft(message),
        onStart: () => {
          setEditing((current) => {
            if (current && (current.sessionId !== sessionId || current.messageId !== messageId)) {
              draftsRef.current.delete(JSON.stringify([current.sessionId, current.messageId]))
            }
            return { sessionId, messageId }
          })
        },
        onCancel: () => closeEditor(sessionId, messageId),
        onDraftChange: (draft) => { draftsRef.current.set(JSON.stringify([sessionId, messageId]), draft) },
        onSubmit: (draft) => { void submit(messageId, draft) },
      })
    }
    return result
  }, [blockedReason, closeEditor, completedMessageIds, disabled, editableCards, editingMessageId, messageById, pendingReason, rewindingTurnId, sessionId, submit, submittingMessageId, t])

  const dialog = useMemo<UserMessageEditDialog>(() => {
    const busy = Boolean(rewindingTurnId)
    const close = () => { if (!busy) setConfirm(null) }
    if (!confirm || !isCurrentContext(confirm.context)) {
      return { open: false, title: '', body: null, actions: [], loading: false, onClose: close }
    }
    const { preview, laterTurns, canRestoreCode } = confirm
    const unverified = preview.unverifiedChangeSources ?? []
    const lines = [
      laterTurns > 0
        ? t('chat.editResendDropsTurns', { count: laterTurns })
        : t('chat.editResendLatestBody'),
    ]
    let caution: string | null = null
    if (canRestoreCode) {
      lines.push(t('chat.editResendRestoreChoice', { count: preview.code.filesChanged.length }))
      if (unverified.length > 0) {
        caution = t('chat.turnChangesPartialCoverageConfirmBody', { sources: unverified.join(', ') })
      }
    } else if (preview.restoreAvailable === false) {
      caution = t('chat.turnChangesConversationOnlyConfirmBody')
    } else {
      lines.push(t('chat.editResendFilesUntouched'))
    }
    const body = (
      <div className="space-y-2 text-sm leading-6 text-[var(--color-text-secondary)]">
        {lines.map((line, index) => <p key={index}>{line}</p>)}
        {caution ? <p className="text-[var(--color-warning)]">{caution}</p> : null}
      </div>
    )
    const run = (mode: SessionRewindMode) => {
      void runResend(confirm.context, confirm.messageId, confirm.card, confirm.draft, confirm.payload, mode)
    }
    const actions: ActionDialogAction[] = [
      { label: t('common.cancel'), onClick: close, variant: 'secondary' },
      canRestoreCode
        ? { label: t('chat.editResendConversationOnly'), onClick: () => run('conversation'), variant: 'secondary', loading: busy }
        : {
            label: preview.restoreAvailable === false
              ? t('chat.editResendConversationOnly')
              : t('chat.editResendConversation'),
            onClick: () => run('conversation'),
            variant: 'danger',
            loading: busy,
          },
      ...(canRestoreCode
        ? [{ label: t('chat.editResendWithCode'), onClick: () => run('both'), variant: 'danger' as const, loading: busy }]
        : []),
    ]
    return {
      open: true,
      title: t('chat.editResendConfirmTitle'),
      body,
      actions,
      loading: busy,
      onClose: close,
    }
  }, [confirm, context, isCurrentContext, rewindingTurnId, runResend, t])

  return { editActionByMessageId, dialog }
}
