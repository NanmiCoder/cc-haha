import { useCallback, useEffect, useRef, useState } from 'react'
import { sessionsApi } from '@/api/sessions'
import { useTranslation } from '@/i18n'
import {
  mentionsEqual,
  prepareMentionsForRewrite,
  type ComposerMention,
} from '@/lib/composerMentions'
import { useUIStore } from '@/stores/uiStore'

export type PromptOptimizeRestoreSnapshot = {
  id: number
  text: string
  mentions: ComposerMention[]
}

export type UsePromptOptimizeOptions = {
  sessionId: string | null
  disabled: boolean
  getDraft: () => { text: string; mentions: ComposerMention[] }
  applyDraft: (text: string, mentions: ComposerMention[], options?: { flash?: boolean }) => void
}

export type PromptOptimizeController = {
  isOptimizing: boolean
  restoreSnapshot: PromptOptimizeRestoreSnapshot | null
  optimize: () => Promise<void>
  cancel: () => void
  restore: () => void
  dismissRestore: () => void
  notifyDraftChanged: () => void
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { name?: string; code?: string }
  return (
    candidate.name === 'AbortError' ||
    candidate.code === 'ABORT_ERR' ||
    candidate.code === 'PROMPT_OPTIMIZE_CANCELLED'
  )
}

function createRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, char => {
    const rand = Math.floor(Math.random() * 16)
    const value = char === 'x' ? rand : (rand & 0x3) | 0x8
    return value.toString(16)
  })
}

export function isOptimizablePrompt(text: string): boolean {
  const trimmed = text.trim()
  return trimmed.length > 0 && !trimmed.startsWith('/')
}

export function usePromptOptimize({
  sessionId,
  disabled,
  getDraft,
  applyDraft,
}: UsePromptOptimizeOptions): PromptOptimizeController {
  const t = useTranslation()
  const [isOptimizing, setIsOptimizing] = useState(false)
  const [restoreSnapshot, setRestoreSnapshot] = useState<PromptOptimizeRestoreSnapshot | null>(null)
  const activeRef = useRef<{
    requestId: string
    sessionId: string
    controller: AbortController
    baselineText: string
    baselineMentions: ComposerMention[]
  } | null>(null)
  const applyingRef = useRef(false)
  const noticeIdRef = useRef(0)
  const sessionIdRef = useRef(sessionId)
  sessionIdRef.current = sessionId

  const cancel = useCallback(() => {
    const active = activeRef.current
    if (!active) return
    activeRef.current = null
    active.controller.abort()
    setIsOptimizing(false)
    void sessionsApi.cancelOptimizePrompt(active.sessionId, active.requestId).catch(() => {})
  }, [])

  const dismissRestore = useCallback(() => {
    setRestoreSnapshot(null)
  }, [])

  const notifyDraftChanged = useCallback(() => {
    if (applyingRef.current) return
    if (activeRef.current) cancel()
    setRestoreSnapshot(null)
  }, [cancel])

  // Switching tabs/sessions or unmounting aborts any in-flight optimization so
  // a late response can never overwrite another chat's composer draft.
  useEffect(() => {
    setRestoreSnapshot(null)
    return () => {
      cancel()
    }
  }, [sessionId, cancel])

  const optimize = useCallback(async () => {
    const targetSessionId = sessionIdRef.current
    if (!targetSessionId || disabled || activeRef.current) return
    const draft = getDraft()
    if (!isOptimizablePrompt(draft.text)) return

    const requestId = createRequestId()
    const controller = new AbortController()
    const active = {
      requestId,
      sessionId: targetSessionId,
      controller,
      baselineText: draft.text,
      baselineMentions: draft.mentions,
    }
    activeRef.current = active
    setRestoreSnapshot(null)
    setIsOptimizing(true)

    try {
      const rewrite = prepareMentionsForRewrite(active.baselineText, active.baselineMentions)
      const response = await sessionsApi.optimizePrompt(
        targetSessionId,
        { requestId, prompt: rewrite.requestPrompt },
        controller.signal,
      )
      if (activeRef.current !== active || controller.signal.aborted) return
      if (sessionIdRef.current !== targetSessionId) return
      // Guard against any edit that slipped in without going through onChange.
      const current = getDraft()
      if (current.text !== active.baselineText || !mentionsEqual(current.mentions, active.baselineMentions)) return

      const { text: optimizedText, mentions: reconciledMentions } = rewrite.restore(response.optimizedPrompt.trim())
      if (!optimizedText) return

      if (optimizedText === active.baselineText.trim() && mentionsEqual(reconciledMentions, active.baselineMentions)) {
        useUIStore.getState().addToast({
          type: 'info',
          message: t('chat.promptOptimize.unchanged'),
        })
        return
      }

      applyingRef.current = true
      try {
        applyDraft(optimizedText, reconciledMentions, { flash: true })
      } finally {
        applyingRef.current = false
      }
      setRestoreSnapshot({
        id: ++noticeIdRef.current,
        text: active.baselineText,
        mentions: active.baselineMentions,
      })
    } catch (error) {
      if (activeRef.current !== active || controller.signal.aborted || isAbortError(error)) {
        return
      }
      const message =
        error instanceof Error && error.message.trim()
          ? error.message
          : t('chat.promptOptimize.failed')
      useUIStore.getState().addToast({ type: 'error', message })
    } finally {
      if (activeRef.current === active) {
        activeRef.current = null
        setIsOptimizing(false)
      }
    }
  }, [applyDraft, disabled, getDraft, t])

  const restore = useCallback(() => {
    if (!restoreSnapshot) return
    const snapshot = restoreSnapshot
    setRestoreSnapshot(null)
    applyingRef.current = true
    try {
      applyDraft(snapshot.text, snapshot.mentions)
    } finally {
      applyingRef.current = false
    }
  }, [applyDraft, restoreSnapshot])

  return {
    isOptimizing,
    restoreSnapshot,
    optimize,
    cancel,
    restore,
    dismissRestore,
    notifyDraftChanged,
  }
}
