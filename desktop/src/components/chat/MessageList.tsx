import { useRef, useEffect, useLayoutEffect, useMemo, memo, useState, useCallback } from 'react'
import { ApiError } from '../../api/client'
import { sessionsApi, type SessionTurnCheckpoint } from '../../api/sessions'
import { useChatStore } from '../../stores/chatStore'
import { useTabStore } from '../../stores/tabStore'
import { useTeamStore } from '../../stores/teamStore'
import { useUIStore } from '../../stores/uiStore'
import { useTranslation } from '../../i18n'
import type { TranslationKey } from '../../i18n/locales/en'
import { UserMessage } from './UserMessage'
import { AssistantMessage } from './AssistantMessage'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolCallBlock } from './ToolCallBlock'
import { ToolCallGroup } from './ToolCallGroup'
import { ToolResultBlock } from './ToolResultBlock'
import { PermissionDialog } from './PermissionDialog'
import { AskUserQuestion } from './AskUserQuestion'
import { StreamingIndicator } from './StreamingIndicator'
import { InlineTaskSummary } from './InlineTaskSummary'
import { CurrentTurnChangeCard } from './CurrentTurnChangeCard'
import type { AgentTaskNotification, AutoRetryState, UIMessage } from '../../types/chat'
import { ConfirmDialog } from '../shared/ConfirmDialog'

type ToolCall = Extract<UIMessage, { type: 'tool_use' }>
type ToolResult = Extract<UIMessage, { type: 'tool_result' }>

type RenderItem =
  | { kind: 'tool_group'; toolCalls: ToolCall[]; id: string }
  | { kind: 'message'; message: UIMessage }

type RenderModel = {
  renderItems: RenderItem[]
  toolResultMap: Map<string, ToolResult>
  childToolCallsByParent: Map<string, ToolCall[]>
}

type RewindTurnTarget = {
  messageId: string
  userMessageIndex: number
  content: string
  expectedContent: string
  attachments?: Extract<UIMessage, { type: 'user_text' }>['attachments']
}

type TurnChangeCardModel = {
  target: RewindTurnTarget
  checkpoint: SessionTurnCheckpoint
  workDir: string | null
  isLatest: boolean
}

type RewindConfirmRequest = {
  target: RewindTurnTarget
  isLatest: boolean
  source: 'message' | 'change-card'
}

function appendChildToolCall(
  childToolCallsByParent: Map<string, ToolCall[]>,
  parentToolUseId: string,
  toolCall: ToolCall,
) {
  const siblings = childToolCallsByParent.get(parentToolUseId)
  if (siblings) {
    siblings.push(toolCall)
  } else {
    childToolCallsByParent.set(parentToolUseId, [toolCall])
  }
}

export function buildRenderModel(messages: UIMessage[]): RenderModel {
  const items: RenderItem[] = []
  const toolResultMap = new Map<string, ToolResult>()
  const childToolCallsByParent = new Map<string, ToolCall[]>()
  const toolUseIds = new Set<string>()
  let pendingToolCalls: ToolCall[] = []

  const flushGroup = () => {
    if (pendingToolCalls.length > 0) {
      items.push({
        kind: 'tool_group',
        toolCalls: [...pendingToolCalls],
        id: `group-${pendingToolCalls[0]!.id}`,
      })
      pendingToolCalls = []
    }
  }

  for (const msg of messages) {
    if (msg.type === 'tool_use') {
      toolUseIds.add(msg.toolUseId)
    }
    if (msg.type === 'tool_result') {
      toolResultMap.set(msg.toolUseId, msg)
    }
  }

  for (const msg of messages) {
    if (msg.type === 'assistant_text' && !msg.content.trim()) {
      continue
    }

    if (msg.type === 'tool_result' && toolUseIds.has(msg.toolUseId)) {
      continue
    }
    if (msg.type === 'tool_result' && msg.parentToolUseId && toolUseIds.has(msg.parentToolUseId)) {
      continue
    }

    if (msg.type === 'tool_use') {
      if (msg.parentToolUseId && toolUseIds.has(msg.parentToolUseId)) {
        flushGroup()
        appendChildToolCall(childToolCallsByParent, msg.parentToolUseId, msg)
        continue
      }
      if (msg.toolName === 'AskUserQuestion') {
        flushGroup()
        items.push({ kind: 'message', message: msg })
      } else {
        pendingToolCalls.push(msg)
      }
    } else {
      flushGroup()
      items.push({ kind: 'message', message: msg })
    }
  }

  flushGroup()
  return { renderItems: items, toolResultMap, childToolCallsByParent }
}

function isTurnResponseMessage(message: UIMessage) {
  return (
    message.type === 'assistant_text' ||
    message.type === 'tool_use' ||
    message.type === 'tool_result' ||
    message.type === 'error' ||
    message.type === 'task_summary'
  )
}

export function getCompletedTurnTargets(messages: UIMessage[]): RewindTurnTarget[] {
  let userMessageIndex = -1
  const completedTurns: RewindTurnTarget[] = []
  let currentTarget: RewindTurnTarget | null = null
  let hasResponseForCurrentTarget = false

  for (const message of messages) {
    if (message.type === 'user_text' && !message.pending) {
      if (currentTarget && hasResponseForCurrentTarget) {
        completedTurns.push(currentTarget)
      }
      userMessageIndex += 1
      currentTarget = {
        messageId: message.id,
        userMessageIndex,
        content: message.content,
        expectedContent: message.modelContent ?? message.content,
        attachments: message.attachments,
      }
      hasResponseForCurrentTarget = false
      continue
    }

    if (currentTarget && isTurnResponseMessage(message)) {
      hasResponseForCurrentTarget = true
    }
  }

  if (currentTarget && hasResponseForCurrentTarget) {
    completedTurns.push(currentTarget)
  }

  return completedTurns
}

export function getLatestCompletedTurnTarget(messages: UIMessage[]): RewindTurnTarget | null {
  const completedTurns = getCompletedTurnTargets(messages)
  return completedTurns.length > 0 ? completedTurns[completedTurns.length - 1] ?? null : null
}

export function getLatestUserTurnTarget(messages: UIMessage[]): RewindTurnTarget | null {
  let userMessageIndex = -1
  let latestTarget: RewindTurnTarget | null = null

  for (const message of messages) {
    if (message.type !== 'user_text' || message.pending) continue
    userMessageIndex += 1
    latestTarget = {
      messageId: message.id,
      userMessageIndex,
      content: message.content,
      expectedContent: message.modelContent ?? message.content,
      attachments: message.attachments,
    }
  }

  return latestTarget
}

function buildTurnCardInsertionMap(
  renderItems: RenderItem[],
  turnChangeCards: TurnChangeCardModel[],
) {
  const lastResponseIndexByTurnId = new Map<string, number>()
  const userIndexByTurnId = new Map<string, number>()
  let activeTurnId: string | null = null

  renderItems.forEach((item, index) => {
    if (item.kind === 'message' && item.message.type === 'user_text' && !item.message.pending) {
      activeTurnId = item.message.id
      userIndexByTurnId.set(activeTurnId, index)
      return
    }

    if (activeTurnId) {
      lastResponseIndexByTurnId.set(activeTurnId, index)
    }
  })

  const cardsByRenderIndex = new Map<number, TurnChangeCardModel[]>()
  turnChangeCards.forEach((card) => {
    const renderIndex =
      lastResponseIndexByTurnId.get(card.target.messageId) ??
      userIndexByTurnId.get(card.target.messageId)
    if (renderIndex === undefined) return
    const existing = cardsByRenderIndex.get(renderIndex)
    if (existing) {
      existing.push(card)
    } else {
      cardsByRenderIndex.set(renderIndex, [card])
    }
  })

  return cardsByRenderIndex
}

function getApiErrorMessage(error: unknown) {
  return error instanceof ApiError
    ? typeof error.body === 'object' && error.body && 'message' in error.body
      ? String((error.body as { message: unknown }).message)
      : error.message
    : error instanceof Error
      ? error.message
      : String(error)
}

function isLocalOnlyRewindMiss(error: unknown) {
  if (!(error instanceof ApiError)) return false
  const message = getApiErrorMessage(error)
  return (
    error.status === 404 ||
    message.includes('This session has no user messages to rewind') ||
    message.includes('Invalid rewind target') ||
    message.includes('Message not found in active session chain')
  )
}

function isSessionTurnCheckpoint(value: unknown): value is SessionTurnCheckpoint {
  if (!value || typeof value !== 'object') return false
  const checkpoint = value as Partial<SessionTurnCheckpoint>
  return (
    Boolean(checkpoint.target) &&
    typeof checkpoint.target?.targetUserMessageId === 'string' &&
    typeof checkpoint.target?.userMessageIndex === 'number' &&
    Boolean(checkpoint.code) &&
    typeof checkpoint.code?.available === 'boolean' &&
    Array.isArray(checkpoint.code?.filesChanged)
  )
}

function normalizeTurnCheckpoints(response: unknown): SessionTurnCheckpoint[] {
  if (!response || typeof response !== 'object') return []
  const checkpoints = (response as { checkpoints?: unknown }).checkpoints
  if (!Array.isArray(checkpoints)) return []
  return checkpoints.filter(isSessionTurnCheckpoint)
}

type MessageListProps = {
  sessionId?: string | null
  compact?: boolean
}

const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 48
const AUTO_SCROLL_FRAME_PASSES = 2

function isNearScrollBottom(element: HTMLElement) {
  return (
    element.scrollHeight - element.scrollTop - element.clientHeight <=
    AUTO_SCROLL_BOTTOM_THRESHOLD_PX
  )
}

function scrollToElementBottom(
  container: HTMLElement,
  bottomElement: HTMLElement | null,
) {
  bottomElement?.scrollIntoView?.({ behavior: 'auto', block: 'end' })
  container.scrollTop = Math.max(0, container.scrollHeight - container.clientHeight)
}

function getRetryRemainingSeconds(retry: AutoRetryState, now: number) {
  if (!retry.nextRetryAt) return 0
  return Math.max(0, Math.ceil((retry.nextRetryAt - now) / 1000))
}

function formatRetryCountdown(seconds: number) {
  if (seconds >= 60) {
    const minutes = Math.floor(seconds / 60)
    const remainder = seconds % 60
    return `${minutes}:${String(remainder).padStart(2, '0')}`
  }
  return `${seconds}s`
}

function getRetryNoticeTitle(retry: AutoRetryState, now: number) {
  if (retry.paused || retry.status === 'paused') {
    return retry.statusMessage || 'Automatic retry paused'
  }

  if (retry.status === 'attempting' || retry.status === 'resumed' || !retry.nextRetryAt) {
    return `Retrying model request (retry #${retry.failureCount})`
  }

  const remainingSeconds = getRetryRemainingSeconds(retry, now)
  return `Retrying in ${formatRetryCountdown(remainingSeconds)} (retry #${retry.failureCount})`
}

function AutoRetryNotice({ retry }: { retry: AutoRetryState }) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (retry.paused || !retry.nextRetryAt) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [retry.nextRetryAt, retry.paused])

  const title = getRetryNoticeTitle(retry, now)
  const helperText = retry.paused
    ? 'Use /retry resume to continue, /retry now to retry immediately, or /retry clear to clear this state.'
    : 'Use /retry error to view details, /retry pause to pause, or /retry now to retry immediately.'

  return (
    <div
      role="status"
      aria-label="Automatic retry status"
      className="mb-4 rounded-[var(--radius-lg)] border border-[var(--color-warning)]/30 bg-[var(--color-warning-container)]/20 px-4 py-3 text-sm text-[var(--color-text-primary)] shadow-sm"
    >
      <div className="flex items-start gap-3">
        <span className="material-symbols-rounded mt-0.5 text-[18px] text-[var(--color-warning)]">
          autorenew
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-medium">{title}</span>
            <span className="rounded-full bg-[var(--color-surface-container)] px-2 py-0.5 text-[11px] text-[var(--color-text-secondary)]">
              attempt {retry.failureCount}
            </span>
          </div>
          <div className="mt-1 text-xs text-[var(--color-text-secondary)]">
            Last error code: {retry.errorCode}
          </div>
          <div className="mt-2 max-h-24 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--color-surface-container-low)] px-3 py-2 font-mono text-xs text-[var(--color-text-secondary)]">
            {retry.errorMessage}
          </div>
          <div className="mt-2 text-xs text-[var(--color-text-tertiary)]">
            {helperText}
          </div>
        </div>
      </div>
    </div>
  )
}

export function MessageList({ sessionId, compact = false }: MessageListProps = {}) {
  const activeTabId = useTabStore((s) => s.activeTabId)
  const resolvedSessionId = sessionId ?? activeTabId
  const sessionState = useChatStore((s) =>
    resolvedSessionId ? s.sessions[resolvedSessionId] : undefined,
  )
  const stopGeneration = useChatStore((s) => s.stopGeneration)
  const reloadHistory = useChatStore((s) => s.reloadHistory)
  const queueComposerPrefill = useChatStore((s) => s.queueComposerPrefill)
  const discardLocalTurn = useChatStore((s) => s.discardLocalTurn)
  const isMemberSession = useTeamStore((s) =>
    resolvedSessionId ? Boolean(s.getMemberBySessionId(resolvedSessionId)) : false,
  )
  const addToast = useUIStore((s) => s.addToast)
  const messages = sessionState?.messages ?? []
  const chatState = sessionState?.chatState ?? 'idle'
  const streamingText = sessionState?.streamingText ?? ''
  const activeThinkingId = sessionState?.activeThinkingId ?? null
  const retry = sessionState?.retry ?? null
  const agentTaskNotifications = sessionState?.agentTaskNotifications ?? {}
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const scrollContentRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const shouldAutoScrollRef = useRef(true)
  const pendingAutoScrollFramesRef = useRef<number[]>([])
  const lastSessionIdRef = useRef<string | null | undefined>(resolvedSessionId)
  const t = useTranslation()
  const [turnChangeCards, setTurnChangeCards] = useState<TurnChangeCardModel[]>([])
  const [turnChangeLoadError, setTurnChangeLoadError] = useState<string | null>(null)
  const [turnActionErrors, setTurnActionErrors] = useState<Record<string, string>>({})
  const [isLoadingTurnChangeCards, setIsLoadingTurnChangeCards] = useState(false)
  const [rewindingTurnId, setRewindingTurnId] = useState<string | null>(null)
  const [rewindConfirmRequest, setRewindConfirmRequest] = useState<RewindConfirmRequest | null>(null)

  const updateAutoScrollState = useCallback(() => {
    const container = scrollContainerRef.current
    if (!container) return
    shouldAutoScrollRef.current = isNearScrollBottom(container)
  }, [])

  const clearPendingAutoScrollFrames = useCallback(() => {
    if (typeof window === 'undefined' || typeof window.cancelAnimationFrame !== 'function') {
      pendingAutoScrollFramesRef.current = []
      return
    }
    for (const frameId of pendingAutoScrollFramesRef.current) {
      window.cancelAnimationFrame(frameId)
    }
    pendingAutoScrollFramesRef.current = []
  }, [])

  const performAutoScroll = useCallback(() => {
    if (!shouldAutoScrollRef.current) return
    const container = scrollContainerRef.current
    if (!container) return
    scrollToElementBottom(container, bottomRef.current)
  }, [])

  const scheduleAutoScroll = useCallback(() => {
    if (!shouldAutoScrollRef.current) return

    clearPendingAutoScrollFrames()
    performAutoScroll()

    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
      return
    }

    const scheduleFrame = (remainingPasses: number) => {
      if (remainingPasses <= 0) return
      const frameId = window.requestAnimationFrame(() => {
        pendingAutoScrollFramesRef.current = pendingAutoScrollFramesRef.current.filter(
          (id) => id !== frameId,
        )
        performAutoScroll()
        scheduleFrame(remainingPasses - 1)
      })
      pendingAutoScrollFramesRef.current.push(frameId)
    }

    scheduleFrame(AUTO_SCROLL_FRAME_PASSES)
  }, [clearPendingAutoScrollFrames, performAutoScroll])

  useLayoutEffect(() => {
    if (lastSessionIdRef.current !== resolvedSessionId) {
      shouldAutoScrollRef.current = true
      lastSessionIdRef.current = resolvedSessionId
    }

    scheduleAutoScroll()
  }, [
    activeThinkingId,
    agentTaskNotifications,
    chatState,
    messages,
    resolvedSessionId,
    retry,
    scheduleAutoScroll,
    streamingText,
    turnChangeCards,
  ])

  useEffect(() => {
    const content = scrollContentRef.current
    if (!content || typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver(() => {
      scheduleAutoScroll()
    })
    observer.observe(content)

    return () => {
      observer.disconnect()
    }
  }, [resolvedSessionId, scheduleAutoScroll])

  useEffect(() => clearPendingAutoScrollFrames, [clearPendingAutoScrollFrames])

  const { toolResultMap, childToolCallsByParent, renderItems } = useMemo(
    () => buildRenderModel(messages),
    [messages],
  )
  const completedTurnTargets = useMemo(() => getCompletedTurnTargets(messages), [messages])
  const latestUserTurnTarget = useMemo(() => getLatestUserTurnTarget(messages), [messages])
  const latestCompletedTurnId =
    completedTurnTargets.length > 0
      ? completedTurnTargets[completedTurnTargets.length - 1]?.messageId ?? null
      : null
  const turnCardsByRenderIndex = useMemo(
    () => buildTurnCardInsertionMap(renderItems, turnChangeCards),
    [renderItems, turnChangeCards],
  )
  useEffect(() => {
    if (!resolvedSessionId || completedTurnTargets.length === 0 || isMemberSession) {
      setTurnChangeCards([])
      setTurnChangeLoadError(null)
      setIsLoadingTurnChangeCards(false)
      return
    }

    if (chatState !== 'idle') {
      setTurnChangeLoadError(null)
      setIsLoadingTurnChangeCards(false)
      return
    }

    let cancelled = false
    setIsLoadingTurnChangeCards(true)
    setTurnChangeLoadError(null)

    Promise.all([
      sessionsApi.getTurnCheckpoints(resolvedSessionId),
      sessionsApi.getWorkspaceStatus(resolvedSessionId).catch(() => null),
    ])
      .then(([checkpointResponse, workspaceStatus]) => {
        if (cancelled) return
        const targetByMessageId = new Map(
          completedTurnTargets.map((target) => [target.messageId, target] as const),
        )
        const targetByUserMessageIndex = new Map(
          completedTurnTargets.map((target) => [target.userMessageIndex, target] as const),
        )

        setTurnChangeCards(
          normalizeTurnCheckpoints(checkpointResponse).flatMap((checkpoint) => {
            const target =
              targetByMessageId.get(checkpoint.target.targetUserMessageId) ??
              targetByUserMessageIndex.get(checkpoint.target.userMessageIndex)
            if (!target || !checkpoint.code.available || checkpoint.code.filesChanged.length === 0) {
              return []
            }
            return [{
              target,
              checkpoint,
              workDir: checkpoint.workDir ?? workspaceStatus?.workDir ?? null,
              isLatest: target.messageId === latestCompletedTurnId,
            }]
          }),
        )
      })
      .catch((error) => {
        if (cancelled) return
        setTurnChangeCards([])
        setTurnChangeLoadError(getApiErrorMessage(error))
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingTurnChangeCards(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [chatState, completedTurnTargets, isMemberSession, latestCompletedTurnId, resolvedSessionId])

  const handleUndoCurrentTurn = useCallback(async () => {
    if (!resolvedSessionId || !rewindConfirmRequest || rewindingTurnId) return

    const target = rewindConfirmRequest.target
    setRewindingTurnId(target.messageId)
    setTurnActionErrors((current) => {
      if (!(target.messageId in current)) return current
      const next = { ...current }
      delete next[target.messageId]
      return next
    })

    try {
      if (chatState !== 'idle') {
        stopGeneration(resolvedSessionId)
      }

      const result = await sessionsApi.rewind(resolvedSessionId, {
        targetUserMessageId: target.messageId,
        userMessageIndex: target.userMessageIndex,
        expectedContent: target.expectedContent,
      })

      await reloadHistory(resolvedSessionId)
      queueComposerPrefill(resolvedSessionId, {
        text: target.content,
        attachments: target.attachments,
      })

      addToast({
        type: 'success',
        message: result.code.available
          ? t('chat.rewindSuccessWithCode', {
              count: result.conversation.messagesRemoved,
            })
          : t('chat.rewindSuccessConversationOnly', {
              count: result.conversation.messagesRemoved,
          }),
      })

      setRewindConfirmRequest(null)
    } catch (error) {
      const message = getApiErrorMessage(error)
      if (rewindConfirmRequest.source === 'message' && isLocalOnlyRewindMiss(error)) {
        discardLocalTurn(resolvedSessionId, target.messageId)
        queueComposerPrefill(resolvedSessionId, {
          text: target.content,
          attachments: target.attachments,
        })
        addToast({
          type: 'success',
          message: t('chat.recallLocalOnlySuccess'),
        })
        setRewindConfirmRequest(null)
        return
      }

      setTurnActionErrors((current) => ({
        ...current,
        [target.messageId]: message,
      }))
      addToast({
        type: 'error',
        message,
      })
      setRewindConfirmRequest(null)
    } finally {
      setRewindingTurnId(null)
    }
  }, [
    addToast,
    chatState,
    discardLocalTurn,
    queueComposerPrefill,
    reloadHistory,
    resolvedSessionId,
    rewindConfirmRequest,
    rewindingTurnId,
    stopGeneration,
    t,
  ])

  const getConfirmText = useCallback((request: RewindConfirmRequest | null) => {
    if (!request) {
      return {
        title: '',
        body: '',
        confirmLabel: '',
      }
    }

    if (request.source === 'change-card') {
      return {
        title: request.isLatest
          ? t('chat.turnChangesLatestConfirmTitle')
          : t('chat.turnChangesHistoricalConfirmTitle'),
        body: request.isLatest
          ? t('chat.turnChangesLatestConfirmBody')
          : t('chat.turnChangesHistoricalConfirmBody'),
        confirmLabel: request.isLatest
          ? t('chat.turnChangesLatestConfirmUndo')
          : t('chat.turnChangesHistoricalConfirmUndo'),
      }
    }

    return {
      title: t('chat.recallLatestConfirmTitle'),
      body: t('chat.recallLatestConfirmBody'),
      confirmLabel: t('chat.recallConfirmUndo'),
    }
  }, [t])

  const confirmText = getConfirmText(rewindConfirmRequest)

  return (
    <div
      ref={scrollContainerRef}
      onScroll={updateAutoScrollState}
      className={`flex-1 overflow-y-auto ${compact ? 'px-3 py-3 pb-5' : 'px-4 py-4'}`}
    >
      <div
        ref={scrollContentRef}
        className={compact ? 'mx-auto max-w-full' : 'mx-auto max-w-[860px]'}
      >
        {renderItems.map((item, index) => {
          const cardsForItem = turnCardsByRenderIndex.get(index) ?? []

          return (
            <div key={item.kind === 'tool_group' ? item.id : item.message.id}>
              {item.kind === 'tool_group' ? (
                <ToolCallGroup
                  toolCalls={item.toolCalls}
                  resultMap={toolResultMap}
                  childToolCallsByParent={childToolCallsByParent}
                  agentTaskNotifications={agentTaskNotifications}
                  isStreaming={
                    chatState === 'tool_executing' &&
                    item.toolCalls.some((tc) => !toolResultMap.has(tc.toolUseId))
                  }
                />
              ) : (() => {
                const userTurnTarget =
                  item.message.type === 'user_text' &&
                  latestUserTurnTarget?.messageId === item.message.id
                    ? latestUserTurnTarget
                    : null
                const canRecallUserTurn =
                  Boolean(userTurnTarget) &&
                  !isMemberSession

                return (
                  <MessageBlock
                    message={item.message}
                    activeThinkingId={activeThinkingId}
                    agentTaskNotifications={agentTaskNotifications}
                    toolResult={
                      item.message.type === 'tool_use'
                        ? (() => {
                            const result = toolResultMap.get(item.message.toolUseId)
                            return result ? { content: result.content, isError: result.isError } : null
                          })()
                        : null
                    }
                    recallAction={canRecallUserTurn && userTurnTarget
                      ? {
                          label: t('chat.recallToEditAria'),
                          displayLabel: t('chat.recallToEdit'),
                          disabled: rewindingTurnId === userTurnTarget.messageId,
                          onRecall: () => {
                            setRewindConfirmRequest({
                              target: userTurnTarget,
                              isLatest: true,
                              source: 'message',
                            })
                          },
                        }
                      : null}
                  />
                )
              })()}

              {resolvedSessionId && cardsForItem.map((card) => (
                <CurrentTurnChangeCard
                  key={`turn-change-${card.target.messageId}`}
                  sessionId={resolvedSessionId}
                  targetUserMessageId={card.checkpoint.target.targetUserMessageId}
                  checkpoint={card.checkpoint}
                  workDir={card.workDir}
                  error={turnActionErrors[card.target.messageId] ?? null}
                  isUndoing={rewindingTurnId === card.target.messageId}
                  isLatest={card.isLatest}
                  onUndo={() => {
                    setRewindConfirmRequest({
                      target: card.target,
                      isLatest: card.isLatest,
                      source: 'change-card',
                    })
                  }}
                />
              ))}
            </div>
          )
        })}

        {streamingText.trim() && (
          <AssistantMessage content={streamingText} isStreaming={chatState === 'streaming'} />
        )}

        {/* Show StreamingIndicator when:
            - tool_executing: tool is running
            - thinking but no active ThinkingBlock yet: the gap between
              sending a message and receiving the first thinking delta */}
        {(chatState === 'tool_executing' || (chatState === 'thinking' && !activeThinkingId)) && (
          <StreamingIndicator />
        )}

        {retry && <AutoRetryNotice retry={retry} />}

        {!isLoadingTurnChangeCards && turnChangeCards.length === 0 && turnChangeLoadError && (
          <div className="mx-auto mb-5 w-full max-w-[860px] rounded-[var(--radius-lg)] border border-[var(--color-error)]/25 bg-[var(--color-error-container)]/18 px-4 py-3 text-xs text-[var(--color-error)]">
            {turnChangeLoadError}
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      <ConfirmDialog
        open={Boolean(rewindConfirmRequest)}
        onClose={() => {
          if (!rewindingTurnId) {
            setRewindConfirmRequest(null)
          }
        }}
        onConfirm={handleUndoCurrentTurn}
        title={confirmText.title}
        body={confirmText.body}
        confirmLabel={confirmText.confirmLabel}
        cancelLabel={t('common.cancel')}
        confirmVariant="danger"
        loading={Boolean(rewindingTurnId)}
      />
    </div>
  )
}

export const MessageBlock = memo(function MessageBlock({
  message,
  activeThinkingId,
  agentTaskNotifications,
  toolResult,
  recallAction,
}: {
  message: UIMessage
  activeThinkingId: string | null
  agentTaskNotifications: Record<string, AgentTaskNotification>
  toolResult?: { content: unknown; isError: boolean } | null
  recallAction?: {
    label: string
    displayLabel: string
    disabled: boolean
    onRecall: () => void
  } | null
}) {
  const t = useTranslation()

  switch (message.type) {
    case 'user_text':
      return (
        <UserMessage
          content={message.content}
          attachments={message.attachments}
          onRecall={recallAction?.onRecall}
          recallLabel={recallAction?.label}
          recallDisplayLabel={recallAction?.displayLabel}
          recallDisabled={recallAction?.disabled}
        />
      )
    case 'assistant_text':
      return <AssistantMessage content={message.content} />
    case 'thinking':
      return <ThinkingBlock content={message.content} isActive={message.id === activeThinkingId} />
    case 'tool_use':
      if (message.toolName === 'AskUserQuestion') {
        return (
          <AskUserQuestion
            toolUseId={message.toolUseId}
            input={message.input}
            result={toolResult?.content}
          />
        )
      }
      return (
        <ToolCallBlock
          toolName={message.toolName}
          input={message.input}
          result={toolResult}
          agentTaskNotification={
            message.toolName === 'Agent'
              ? agentTaskNotifications[message.toolUseId]
              : undefined
          }
        />
      )
    case 'tool_result':
      return (
        <ToolResultBlock
          content={message.content}
          isError={message.isError}
          standalone
        />
      )
    case 'permission_request':
      return (
        <PermissionDialog
          requestId={message.requestId}
          toolName={message.toolName}
          input={message.input}
          description={message.description}
        />
      )
    case 'error': {
      const errorKey = message.code ? `error.${message.code}` as TranslationKey : null
      const errorText = errorKey ? t(errorKey) : null
      const displayMessage = (errorText && errorText !== errorKey) ? errorText : message.message
      const showRawDetail =
        Boolean(message.message) &&
        message.message.trim() !== '' &&
        message.message !== displayMessage
      return (
        <div className="mb-3 px-4 py-2.5 rounded-lg border border-[var(--color-error)]/20 bg-[var(--color-error-container)]/28 text-sm text-[var(--color-error)]">
          <strong>Error:</strong> {displayMessage}
          {showRawDetail && (
            <div className="mt-1 whitespace-pre-wrap text-xs text-[var(--color-on-error-container)]/85">
              {message.message}
            </div>
          )}
        </div>
      )
    }
    case 'task_summary':
      return <InlineTaskSummary tasks={message.tasks} />
    case 'system':
      return (
        <div className="mb-3 text-center text-xs text-[var(--color-text-tertiary)]">
          {message.content}
        </div>
      )
  }
})
