import { useRef, useEffect, useMemo, memo, useState, useCallback } from 'react'
import { ApiError } from '../../api/client'
import { sessionsApi, type SessionRewindResponse } from '../../api/sessions'
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
import type { AgentTaskNotification, UIMessage } from '../../types/chat'
import { Modal } from '../shared/Modal'
import { Button } from '../shared/Button'

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
  const inlineParentToolUseIds = new Set<string>()

  const flushGroup = (resetInlineParents = false) => {
    if (pendingToolCalls.length > 0) {
      items.push({
        kind: 'tool_group',
        toolCalls: [...pendingToolCalls],
        id: `group-${pendingToolCalls[0]!.id}`,
      })
      for (const toolCall of pendingToolCalls) {
        inlineParentToolUseIds.add(toolCall.toolUseId)
      }
      pendingToolCalls = []
    }

    if (resetInlineParents) {
      inlineParentToolUseIds.clear()
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
    if (msg.type === 'tool_result' && toolUseIds.has(msg.toolUseId)) {
      continue
    }

    if (msg.type === 'tool_use') {
      const parentIsPending = msg.parentToolUseId
        ? pendingToolCalls.some((toolCall) => toolCall.toolUseId === msg.parentToolUseId)
        : false

      if (msg.parentToolUseId && (inlineParentToolUseIds.has(msg.parentToolUseId) || parentIsPending)) {
        flushGroup()
        appendChildToolCall(childToolCallsByParent, msg.parentToolUseId, msg)
        inlineParentToolUseIds.add(msg.toolUseId)
        continue
      }
      if (msg.toolName === 'AskUserQuestion') {
        flushGroup(true)
        items.push({ kind: 'message', message: msg })
      } else {
        pendingToolCalls.push(msg)
      }
    } else {
      flushGroup(true)
      items.push({ kind: 'message', message: msg })
    }
  }

  flushGroup()
  return { renderItems: items, toolResultMap, childToolCallsByParent }
}

type MessageListProps = {
  sessionId?: string | null
}

const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 48

function isNearScrollBottom(element: HTMLElement) {
  return (
    element.scrollHeight - element.scrollTop - element.clientHeight <=
    AUTO_SCROLL_BOTTOM_THRESHOLD_PX
  )
}

export function MessageList({ sessionId }: MessageListProps = {}) {
  const activeTabId = useTabStore((s) => s.activeTabId)
  const resolvedSessionId = sessionId ?? activeTabId
  const sessionState = useChatStore((s) =>
    resolvedSessionId ? s.sessions[resolvedSessionId] : undefined,
  )
  const stopGeneration = useChatStore((s) => s.stopGeneration)
  const reloadHistory = useChatStore((s) => s.reloadHistory)
  const queueComposerPrefill = useChatStore((s) => s.queueComposerPrefill)
  const isMemberSession = useTeamStore((s) =>
    resolvedSessionId ? Boolean(s.getMemberBySessionId(resolvedSessionId)) : false,
  )
  const addToast = useUIStore((s) => s.addToast)
  const messages = sessionState?.messages ?? []
  const chatState = sessionState?.chatState ?? 'idle'
  const streamingText = sessionState?.streamingText ?? ''
  const activeThinkingId = sessionState?.activeThinkingId ?? null
  const agentTaskNotifications = sessionState?.agentTaskNotifications ?? {}
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const showFullConversation = sessionState?.showFullConversation ?? false
  const bottomRef = useRef<HTMLDivElement>(null)
  const shouldAutoScrollRef = useRef(true)
  const lastSessionIdRef = useRef<string | null | undefined>(resolvedSessionId)
  const t = useTranslation()
  const [rewindTarget, setRewindTarget] = useState<{
    userMessageIndex: number
    content: string
    attachments?: Extract<UIMessage, { type: 'user_text' }>['attachments']
  } | null>(null)
  const [rewindPreview, setRewindPreview] = useState<SessionRewindResponse | null>(null)
  const [rewindError, setRewindError] = useState<string | null>(null)
  const [isLoadingPreview, setIsLoadingPreview] = useState(false)
  const [isExecutingRewind, setIsExecutingRewind] = useState(false)

  const updateAutoScrollState = useCallback(() => {
    const container = scrollContainerRef.current
    if (!container) return
    shouldAutoScrollRef.current = isNearScrollBottom(container)
  }, [])

  useEffect(() => {
    if (lastSessionIdRef.current !== resolvedSessionId) {
      shouldAutoScrollRef.current = true
      lastSessionIdRef.current = resolvedSessionId
    }

    if (!shouldAutoScrollRef.current) return

    bottomRef.current?.scrollIntoView?.({ behavior: 'smooth' })
  }, [messages.length, resolvedSessionId, streamingText])

  useEffect(() => {
    if (!resolvedSessionId || !rewindTarget) return

    let cancelled = false
    setIsLoadingPreview(true)
    setRewindPreview(null)
    setRewindError(null)

    void sessionsApi
      .rewind(resolvedSessionId, {
        userMessageIndex: rewindTarget.userMessageIndex,
        dryRun: true,
      })
      .then((preview) => {
        if (!cancelled) {
          setRewindPreview(preview)
        }
      })
      .catch((error) => {
        if (cancelled) return
        const message =
          error instanceof ApiError
            ? typeof error.body === 'object' && error.body && 'message' in error.body
              ? String((error.body as { message: unknown }).message)
              : error.message
            : error instanceof Error
              ? error.message
              : String(error)
        setRewindError(message)
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingPreview(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [resolvedSessionId, rewindTarget])

  const { toolResultMap, childToolCallsByParent, renderItems } = useMemo(
    () => buildRenderModel(messages),
    [messages],
  )

  const closeRewindModal = useCallback(() => {
    if (isExecutingRewind) return
    setRewindTarget(null)
    setRewindPreview(null)
    setRewindError(null)
    setIsLoadingPreview(false)
  }, [isExecutingRewind])

  const handleConfirmRewind = useCallback(async () => {
    if (!resolvedSessionId || !rewindTarget || isExecutingRewind) return

    setIsExecutingRewind(true)
    setRewindError(null)

    try {
      if (chatState !== 'idle') {
        stopGeneration(resolvedSessionId)
      }

      const result = await sessionsApi.rewind(resolvedSessionId, {
        userMessageIndex: rewindTarget.userMessageIndex,
      })

      await reloadHistory(resolvedSessionId)
      queueComposerPrefill(resolvedSessionId, {
        text: rewindTarget.content,
        attachments: rewindTarget.attachments,
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

      setRewindTarget(null)
      setRewindPreview(null)
    } catch (error) {
      const message =
        error instanceof ApiError
          ? typeof error.body === 'object' && error.body && 'message' in error.body
            ? String((error.body as { message: unknown }).message)
            : error.message
          : error instanceof Error
            ? error.message
            : String(error)
      setRewindError(message)
    } finally {
      setIsExecutingRewind(false)
    }
  }, [
    addToast,
    chatState,
    isExecutingRewind,
    queueComposerPrefill,
    reloadHistory,
    resolvedSessionId,
    rewindTarget,
    stopGeneration,
    t,
  ])

  let visibleUserMessageIndex = -1

  return (
    <div
      ref={scrollContainerRef}
      onScroll={updateAutoScrollState}
      className="flex-1 overflow-y-auto px-4 py-4"
    >
      <div className="mx-auto max-w-[860px]">
        {renderItems.map((item) => {
          if (item.kind === 'tool_group') {
            return (
              <ToolCallGroup
                key={item.id}
                toolCalls={item.toolCalls}
                resultMap={toolResultMap}
                childToolCallsByParent={childToolCallsByParent}
                agentTaskNotifications={agentTaskNotifications}
                isStreaming={
                  chatState === 'tool_executing' &&
                  item.toolCalls.some((tc) => !toolResultMap.has(tc.toolUseId))
                }
                forceExpanded={showFullConversation}
              />
            )
          }

          const msg = item.message
          const rewindableUserIndex =
            msg.type === 'user_text' && !msg.pending
              ? ++visibleUserMessageIndex
              : null
          return (
            <MessageBlock
              key={msg.id}
              message={msg}
              activeThinkingId={activeThinkingId}
              agentTaskNotifications={agentTaskNotifications}
              forceExpanded={showFullConversation}
              toolResult={
                msg.type === 'tool_use'
                  ? (() => {
                      const r = toolResultMap.get(msg.toolUseId)
                      return r ? { content: r.content, isError: r.isError } : null
                    })()
                  : null
              }
              rewindableUserIndex={rewindableUserIndex}
              onRequestRewind={
                !isMemberSession
                  ? (message, userMessageIndex) => {
                      setRewindTarget({
                        userMessageIndex,
                        content: message.content,
                        attachments: message.attachments,
                      })
                    }
                  : undefined
              }
            />
          )
        })}

        {streamingText && (
          <AssistantMessage content={streamingText} isStreaming={chatState === 'streaming'} />
        )}

        {/* Show StreamingIndicator when:
            - tool_executing: tool is running
            - thinking but no active ThinkingBlock yet: the gap between
              sending a message and receiving the first thinking delta */}
        {(chatState === 'tool_executing' || (chatState === 'thinking' && !activeThinkingId)) && (
          <StreamingIndicator />
        )}

        <div ref={bottomRef} />
      </div>

      <Modal
        open={Boolean(rewindTarget)}
        onClose={closeRewindModal}
        title={t('chat.rewindModalTitle')}
        footer={
          <>
            <Button
              variant="ghost"
              onClick={closeRewindModal}
              disabled={isExecutingRewind}
            >
              {t('common.cancel')}
            </Button>
            <Button
              onClick={() => {
                void handleConfirmRewind()
              }}
              loading={isExecutingRewind}
              disabled={isLoadingPreview || Boolean(rewindError)}
              icon={
                !isExecutingRewind ? (
                  <span className="material-symbols-outlined text-[16px]">undo</span>
                ) : undefined
              }
            >
              {t('chat.rewindConfirm')}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-4 py-3">
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--color-text-tertiary)]">
              {t('chat.rewindPromptLabel')}
            </div>
            <div className="whitespace-pre-wrap break-words text-sm leading-relaxed text-[var(--color-text-primary)]">
              {rewindTarget?.content || t('chat.rewindAttachmentOnly')}
            </div>
          </div>

          {isLoadingPreview && (
            <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-4 py-3 text-sm text-[var(--color-text-secondary)]">
              {t('chat.rewindLoading')}
            </div>
          )}

          {!isLoadingPreview && rewindPreview && (
            <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_220px]">
              <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-4 py-3">
                <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-[var(--color-text-primary)]">
                  <span className="material-symbols-outlined text-[16px] text-[var(--color-brand)]">history</span>
                  {t('chat.rewindConversationCardTitle')}
                </div>
                <p className="text-sm leading-relaxed text-[var(--color-text-secondary)]">
                  {t('chat.rewindConversationCardBody', {
                    count: rewindPreview.conversation.messagesRemoved,
                  })}
                </p>
              </div>

              <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-4 py-3">
                <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-[var(--color-text-primary)]">
                  <span className="material-symbols-outlined text-[16px] text-[var(--color-brand)]">code</span>
                  {t('chat.rewindCodeCardTitle')}
                </div>
                {rewindPreview.code.available ? (
                  <div className="space-y-1 text-sm text-[var(--color-text-secondary)]">
                    <div>{t('chat.rewindCodeFiles', { count: rewindPreview.code.filesChanged.length })}</div>
                    <div>{t('chat.rewindCodeInsertions', { count: rewindPreview.code.insertions })}</div>
                    <div>{t('chat.rewindCodeDeletions', { count: rewindPreview.code.deletions })}</div>
                  </div>
                ) : (
                  <p className="text-sm leading-relaxed text-[var(--color-text-secondary)]">
                    {rewindPreview.code.reason || t('chat.rewindCodeUnavailable')}
                  </p>
                )}
              </div>
            </div>
          )}

          {!isLoadingPreview && rewindPreview?.code.available && rewindPreview.code.filesChanged.length > 0 && (
            <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-4 py-3">
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--color-text-tertiary)]">
                {t('chat.rewindFilesLabel')}
              </div>
              <div className="flex flex-wrap gap-2">
                {rewindPreview.code.filesChanged.slice(0, 8).map((filePath) => (
                  <span
                    key={filePath}
                    className="rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1 text-[11px] text-[var(--color-text-secondary)]"
                  >
                    {filePath}
                  </span>
                ))}
                {rewindPreview.code.filesChanged.length > 8 && (
                  <span className="rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1 text-[11px] text-[var(--color-text-secondary)]">
                    {t('chat.rewindFilesMore', {
                      count: rewindPreview.code.filesChanged.length - 8,
                    })}
                  </span>
                )}
              </div>
            </div>
          )}

          {rewindError && (
            <div className="rounded-[var(--radius-lg)] border border-[var(--color-error)]/30 bg-[var(--color-error-container)]/22 px-4 py-3 text-sm text-[var(--color-error)]">
              {rewindError}
            </div>
          )}
        </div>
      </Modal>
    </div>
  )
}

export const MessageBlock = memo(function MessageBlock({
  message,
  activeThinkingId,
  agentTaskNotifications,
  toolResult,
  rewindableUserIndex,
  onRequestRewind,
  forceExpanded = false,
}: {
  message: UIMessage
  activeThinkingId: string | null
  agentTaskNotifications: Record<string, AgentTaskNotification>
  toolResult?: { content: unknown; isError: boolean } | null
  rewindableUserIndex?: number | null
  onRequestRewind?: (
    message: Extract<UIMessage, { type: 'user_text' }>,
    userMessageIndex: number,
  ) => void
  forceExpanded?: boolean
}) {
  const t = useTranslation()

  switch (message.type) {
    case 'user_text':
      return (
        <UserMessage
          content={message.content}
          attachments={message.attachments}
          onRewind={
            typeof rewindableUserIndex === 'number' && onRequestRewind
              ? () => onRequestRewind(message, rewindableUserIndex)
              : undefined
          }
          rewindLabel={t('chat.rewindAction')}
        />
      )
    case 'assistant_text':
      return <AssistantMessage content={message.content} />
    case 'thinking':
      return <ThinkingBlock content={message.content} isActive={message.id === activeThinkingId} forceExpanded={forceExpanded} />
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
          forceExpanded={forceExpanded}
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
