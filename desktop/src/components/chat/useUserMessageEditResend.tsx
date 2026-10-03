import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
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
  checkpoint: { target: SessionTurnCheckpoint['target'] }
}

type PendingConfirm = {
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
  /** Busy, background work, an agent tab, a side chat: no new edits start. */
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
  disabled,
  rewindingTurnId,
  setRewindingTurnId,
  t,
}: Options) {
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null)
  const [submittingMessageId, setSubmittingMessageId] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null)
  const draftsRef = useRef(new Map<string, UserMessageEditDraft>())
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

  const closeEditor = useCallback((messageId: string) => {
    draftsRef.current.delete(messageId)
    setEditingMessageId((current) => current === messageId ? null : current)
  }, [])

  const runResend = useCallback(async (
    messageId: string,
    card: EditableTurnCard,
    draft: UserMessageEditDraft,
    payload: UserMessageResendPayload,
    mode: SessionRewindMode,
  ) => {
    if (!sessionId) return
    const addToast = useUIStore.getState().addToast
    setRewindingTurnId(messageId)
    let result: SessionRewindResponse
    try {
      result = await rewindToTurnCheckpoint(sessionId, {
        checkpointTarget: card.checkpoint.target,
        expectedContent: card.target.expectedContent,
      }, mode)
    } catch (error) {
      // The server rewinds atomically: a failed rewind left the conversation
      // and the files as they were, so the draft stays open for another try.
      addToast({ type: 'error', message: t('chat.editResendFailed', { detail: getApiErrorMessage(error) }) })
      setConfirm(null)
      setRewindingTurnId(null)
      return
    }

    // From here the old turn is gone. The edit must reach either the model or
    // the composer — never be dropped with the editor.
    closeEditor(messageId)
    setConfirm(null)
    const chatStore = useChatStore.getState()
    let sent = false
    try {
      await chatStore.reloadHistory(sessionId)
      if ((useChatStore.getState().sessions[sessionId]?.chatState ?? 'idle') === 'idle') {
        useChatStore.getState().sendMessage(sessionId, payload.content, payload.attachments, payload.options)
        sent = true
      }
    } catch {
      sent = false
    }
    if (!sent) {
      useChatStore.getState().queueComposerPrefill(sessionId, {
        text: draft.text,
        attachments: draft.attachments.filter((attachment) => attachment.sendable),
      })
      addToast({ type: 'warning', message: t('chat.editResendPrefilled') })
    } else if (mode === 'both') {
      addToast(describeRewindResult(result, mode, t))
    }
    setRewindingTurnId(null)
  }, [closeEditor, sessionId, setRewindingTurnId, t])

  const submit = useCallback(async (messageId: string, draft: UserMessageEditDraft) => {
    const card = editableCards.get(messageId)
    if (!sessionId || !card || disabled || submittingMessageId || rewindingTurnId) return
    const payload = buildUserMessageResendPayload(draft, { contextReferencesOnly })
    if (!payload) return
    draftsRef.current.set(messageId, draft)

    setSubmittingMessageId(messageId)
    let preview: SessionRewindResponse
    try {
      preview = await sessionsApi.rewind(sessionId, {
        targetUserMessageId: card.checkpoint.target.targetUserMessageId,
        userMessageIndex: card.checkpoint.target.userMessageIndex,
        expectedContent: card.target.expectedContent,
        dryRun: true,
      })
    } catch (error) {
      useUIStore.getState().addToast({
        type: 'error',
        message: t('chat.editResendFailed', { detail: getApiErrorMessage(error) }),
      })
      setSubmittingMessageId(null)
      return
    }
    setSubmittingMessageId(null)

    const canRestoreCode = preview.code.available &&
      preview.code.filesChanged.length > 0 &&
      preview.restoreAvailable !== false
    const laterTurns = countLaterUserTurns(messagesRef.current, messageId)
    // Nothing on disk to decide about and nothing beyond this turn to lose:
    // the edit is the whole consequence, so it goes straight through.
    if (!canRestoreCode && preview.restoreAvailable !== false && laterTurns === 0) {
      await runResend(messageId, card, draft, payload, 'conversation')
      return
    }
    setConfirm({ messageId, card, draft, payload, preview, laterTurns, canRestoreCode })
  }, [contextReferencesOnly, disabled, editableCards, rewindingTurnId, runResend, sessionId, submittingMessageId, t])

  const editActionByMessageId = useMemo(() => {
    const result = new Map<string, UserMessageEditAction>()
    if (!sessionId) return result
    const label = t('chat.editMessage')
    for (const [messageId] of editableCards) {
      const editing = editingMessageId === messageId
      // A disabled session offers no new edits, but an open editor stays open
      // (disabled) instead of discarding what the user typed.
      if (disabled && !editing) continue
      const message = messageById.get(messageId)!
      result.set(messageId, {
        label,
        editing,
        submitting: submittingMessageId === messageId || rewindingTurnId === messageId,
        disabled: disabled || Boolean(rewindingTurnId && rewindingTurnId !== messageId),
        getDraft: () => draftsRef.current.get(messageId) ?? createUserMessageEditDraft(message),
        onStart: () => {
          setEditingMessageId((current) => {
            if (current && current !== messageId) draftsRef.current.delete(current)
            return messageId
          })
        },
        onCancel: () => closeEditor(messageId),
        onDraftChange: (draft) => { draftsRef.current.set(messageId, draft) },
        onSubmit: (draft) => { void submit(messageId, draft) },
      })
    }
    return result
  }, [closeEditor, disabled, editableCards, editingMessageId, messageById, rewindingTurnId, sessionId, submit, submittingMessageId, t])

  const dialog = useMemo<UserMessageEditDialog>(() => {
    const busy = Boolean(rewindingTurnId)
    const close = () => { if (!busy) setConfirm(null) }
    if (!confirm) {
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
      void runResend(confirm.messageId, confirm.card, confirm.draft, confirm.payload, mode)
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
  }, [confirm, rewindingTurnId, runResend, t])

  return { editActionByMessageId, dialog }
}
