import type {
  ChatItem,
  ChatState,
  HistoryEntry,
  HistoryPage,
  ServerEvent,
} from './types'
import {
  applyImageMetadata,
  attachmentOnlyPlaceholder,
  parseImageMetadata,
  restoreFileReferences,
  restoreImageReplay,
} from './chatComposer'
import { reduceSubagents } from './subagentLive'
import { isTeammateEnvelope, teammateMessages } from './teammateEnvelope'

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}
const string = (value: unknown): value is string => typeof value === 'string'
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(string)
const states = [
  'idle',
  'thinking',
  'compacting',
  'tool_executing',
  'streaming',
  'permission_pending',
]
const permissionModes = [
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
  'dontAsk',
  'auto',
]
function computerUseRequest(value: unknown): boolean {
  const request = record(value)
  return (
    !!request &&
    string(request.requestId) &&
    string(request.reason) &&
    Array.isArray(request.apps) &&
    request.apps.every((value) => {
      const app = record(value)
      const resolved = app && record(app.resolved)
      return (
        !!app &&
        string(app.requestedName) &&
        typeof app.isSentinel === 'boolean' &&
        typeof app.alreadyGranted === 'boolean' &&
        ['read', 'click', 'full'].includes(String(app.proposedTier)) &&
        (app.resolved === undefined ||
          (!!resolved &&
            string(resolved.bundleId) &&
            string(resolved.displayName)))
      )
    }) &&
    !!record(request.requestedFlags) &&
    ['native', 'none'].includes(String(request.screenshotFiltering))
  )
}

/** Unknown future events are ignored; malformed known events cannot enter state. */
export function parseServerEvent(raw: unknown): ServerEvent | null {
  let value = raw
  if (string(raw)) {
    try {
      value = JSON.parse(raw)
    } catch {
      return null
    }
  }
  const v = record(value)
  if (!v || !string(v.type)) return null
  let valid = false
  switch (v.type) {
    case 'connected':
      valid = string(v.sessionId)
      break
    case 'session_state':
      valid =
        ['running', 'idle'].includes(String(v.turnState)) &&
        (v.activeBackgroundTaskIds === undefined ||
          strings(v.activeBackgroundTaskIds))
      break
    case 'content_start':
      valid =
        v.blockType === 'text' ||
        (v.blockType === 'tool_use' &&
          string(v.toolUseId) &&
          string(v.toolName))
      break
    case 'content_delta':
      valid =
        (string(v.text) || string(v.toolInput)) &&
        (v.text === undefined || string(v.text)) &&
        (v.toolInput === undefined || string(v.toolInput))
      break
    case 'tool_use_complete':
      valid = string(v.toolName) && string(v.toolUseId)
      break
    case 'tool_result':
      valid = string(v.toolUseId) && typeof v.isError === 'boolean'
      break
    case 'permission_request':
      valid =
        string(v.requestId) &&
        string(v.toolName) &&
        (v.autoAnswerDeadline === undefined ||
          v.autoAnswerDeadline === null ||
          (typeof v.autoAnswerDeadline === 'number' &&
            Number.isFinite(v.autoAnswerDeadline)))
      break
    case 'computer_use_permission_request':
      valid = string(v.requestId) && computerUseRequest(v.request)
      break
    case 'permission_resolved':
      valid =
        string(v.requestId) &&
        ['tool', 'computer_use'].includes(String(v.permissionType))
      break
    case 'permission_requests_snapshot':
      valid =
        strings(v.toolRequestIds) &&
        strings(v.computerUseRequestIds) &&
        typeof v.turnActive === 'boolean'
      break
    case 'user_message_replay':
      valid = string(v.content)
      break
    case 'thinking':
      valid =
        string(v.text) &&
        (v.complete === undefined || typeof v.complete === 'boolean')
      break
    case 'status':
      valid = states.includes(String(v.state))
      break
    case 'message_complete': {
      const usage = record(v.usage)
      valid =
        !!usage &&
        typeof usage.input_tokens === 'number' &&
        typeof usage.output_tokens === 'number' &&
        Number.isFinite(usage.input_tokens) &&
        Number.isFinite(usage.output_tokens)
      break
    }
    case 'runtime_config_applied':
      valid =
        (v.providerId === null || string(v.providerId)) &&
        string(v.modelId) &&
        (v.effortLevel === undefined || string(v.effortLevel))
      break
    case 'permission_mode_changed':
      valid = permissionModes.includes(String(v.mode))
      break
    case 'error':
      valid = string(v.message) && string(v.code)
      break
    case 'system_notification':
      valid =
        string(v.subtype) && (v.message === undefined || string(v.message))
      break
    case 'session_title_updated':
      valid = string(v.sessionId) && string(v.title)
      break
    case 'pong':
      valid = true
      break
    // These are real protocol events; the first UI keeps them out of the root transcript.
    case 'agent_run_event':
      valid =
        string(v.runAgentId) &&
        string(v.streamId) &&
        string(v.targetAgentId) &&
        parseServerEvent(v.event) !== null
      break
    case 'api_retry':
      valid =
        typeof v.attempt === 'number' &&
        typeof v.maxRetries === 'number' &&
        typeof v.retryDelayMs === 'number'
      break
    case 'streaming_fallback':
      valid = [
        'watchdog',
        'stream_error',
        '404_stream_creation',
        'stream_retry',
        'unknown',
      ].includes(String(v.cause))
      break
    case 'background_task_stop_failed':
      valid = string(v.taskId) && string(v.message)
      break
    case 'task_update':
      valid = string(v.taskId) && string(v.status)
      break
    case 'team_plan_updated':
      valid =
        string(v.sessionId) &&
        string(v.planId) &&
        typeof v.revision === 'number' &&
        string(v.state)
      break
    case 'team_deleted':
      valid =
        string(v.teamName) &&
        (v.leadSessionId === undefined || string(v.leadSessionId)) &&
        (v.incarnationId === undefined || string(v.incarnationId))
      break
  }
  return valid ? (value as ServerEvent) : null
}

function resultText(value: unknown): string {
  if (string(value)) return value
  if (Array.isArray(value))
    return value
      .map((block) => {
        const b = record(block)
        return b && string(b.text) ? b.text : ''
      })
      .filter(Boolean)
      .join('\n')
  return value === undefined ? '' : JSON.stringify(value)
}

/** Normalizes real transcript blocks; never synthesizes an assistant answer. */
export function normalizeHistory(
  entries: readonly HistoryEntry[],
  /** 成员之间的消息：队长主对话里不算用户发言（hide），成员页显示正文（show）。 */
  options: { teammates?: 'hide' | 'show' } = {}
): ChatItem[] {
  const items: ChatItem[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    if (seen.has(entry.id)) continue
    seen.add(entry.id)
    const blocks = Array.isArray(entry.content)
      ? entry.content
      : [entry.content]
    const envelope =
      entry.type === 'user' &&
      blocks.every((block) => string(block) || (record(block)?.type === 'text' && string(record(block)?.text)))
        ? teammateMessages(blocks.map((block) => (string(block) ? block : record(block)!.text)).join('\n'))
        : null
    if (envelope) {
      if (options.teammates === 'show')
        envelope.forEach((message, index) =>
          items.push({
            id: `${entry.id}:${index}`,
            sourceMessageId: entry.id,
            timestamp: entry.timestamp,
            type: 'user',
            text: message.text,
            teammateFrom: message.from,
          })
        )
      continue
    }
    if (
      entry.type === 'user' &&
      blocks.some((block) => record(block)?.type === 'image') &&
      blocks.every(
        (block) =>
          string(block) || ['text', 'image'].includes(String(record(block)?.type))
      )
    ) {
      const text: string[] = []
      const images: NonNullable<ChatItem['attachments']> = []
      const metadata: { path?: string }[] = []
      let seenImage = false
      for (const content of blocks) {
        const block = record(content)
        if (block?.type === 'image') {
          seenImage = true
          const source = record(block.source)
          images.push({
            type: 'image',
            ...(string(block.name) ? { name: block.name } : {}),
            ...(source?.type === 'base64' &&
            string(source.data) &&
            string(source.media_type)
              ? { data: source.data, mimeType: source.media_type }
              : {}),
          })
        } else {
          const value = string(content)
            ? content
            : block?.type === 'text' && string(block.text)
              ? block.text
              : undefined
          if (value === undefined) continue
          // buildUserContent appends metadata after the image blocks; the
          // original first text block remains intact even if it quotes this format.
          const generated =
            seenImage && metadata.length < images.length
              ? parseImageMetadata(value)
              : undefined
          if (generated) metadata.push(generated)
          else text.push(value)
        }
      }
      const restored = restoreFileReferences(text.join('\n'))
      items.push({
        id: `${entry.id}:0`,
        sourceMessageId: entry.id,
        timestamp: entry.timestamp,
        model: entry.model,
        parentToolUseId: entry.parentToolUseId,
        type: 'user',
        text: attachmentOnlyPlaceholder(restored.text.trim())
          ? ''
          : restored.text,
        attachments: [
          ...restored.attachments,
          ...applyImageMetadata(images, metadata),
        ],
      })
      continue
    }
    const editableText =
      entry.type === 'user' &&
      blocks.every(
        (block) =>
          string(block) ||
          (record(block)?.type === 'text' && string(record(block)?.text))
      )
        ? blocks
            .map((block) => (string(block) ? block : record(block)!.text))
            .join('\n')
        : undefined
    const role =
      entry.type === 'assistant' || entry.type === 'tool_use'
        ? 'assistant'
        : entry.type === 'user' || entry.type === 'tool_result'
          ? 'user'
          : 'system'
    blocks.forEach((content, index) => {
      const id = `${entry.id}:${index}`
      const base = {
        id,
        sourceMessageId: entry.id,
        ...(editableText !== undefined ? { editableText } : {}),
        timestamp: entry.timestamp,
        model: entry.model,
        parentToolUseId: entry.parentToolUseId,
      }
      const pushText = (text: string) => {
        if (role === 'user' && attachmentOnlyPlaceholder(text) &&
          blocks.some(block => record(block)?.type === 'image')) return
        const restored = role === 'user' ? restoreFileReferences(text) : null
        items.push({
          ...base,
          type: role,
          text: restored?.text ?? text,
          ...(restored?.attachments.length
            ? { attachments: restored.attachments, editableText: undefined }
            : {}),
        })
      }
      if (string(content)) {
        if (content) pushText(content)
        return
      }
      const block = record(content)
      if (!block) return
      const type = block.type ?? entry.type
      if (type === 'text' && string(block.text))
        pushText(block.text)
      else if (
        type === 'thinking' &&
        string(block.thinking) &&
        block.thinking.trim()
      )
        items.push({ ...base, type: 'thinking', text: block.thinking })
      else if (type === 'tool_use' && string(block.id) && string(block.name))
        items.push({
          ...base,
          type: 'tool',
          text: '',
          toolUseId: block.id,
          toolName: block.name,
          input: block.input,
          pending: false,
        })
      else if (type === 'tool_result' && string(block.tool_use_id)) {
        const previous = items.findIndex(
          (item) => item.type === 'tool' && item.toolUseId === block.tool_use_id
        )
        const result = {
          result: block.content,
          text: resultText(block.content),
          isError: block.is_error === true,
          pending: false,
        }
        if (previous >= 0) items[previous] = { ...items[previous], ...result }
        else
          items.push({
            ...base,
            type: 'tool',
            toolUseId: block.tool_use_id,
            ...result,
          })
      } else if (type === 'image') {
        const source = record(block.source)
        const attachment =
          source?.type === 'base64' &&
          string(source.data) &&
          string(source.media_type)
            ? {
                type: 'image' as const,
                data: source.data,
                mimeType: source.media_type,
              }
            : undefined
        items.push({
          ...base,
          type: entry.type === 'user' ? 'user' : 'assistant',
          text: attachment ? '' : '[图片附件]',
          ...(attachment ? { attachments: [attachment] } : {}),
        })
      }
    })
  }
  return items
}

/** Older pages prepend, retaining chronology and preventing duplicate transcript records. */
export function mergeHistoryPages(
  current: HistoryPage,
  older: HistoryPage
): HistoryPage {
  if (
    !current.page ||
    !older.page ||
    current.page.sourceVersion !== older.page.sourceVersion
  )
    throw new Error('HISTORY_PAGE_STALE')
  const seen = new Set<string>()
  const messages = [...older.messages, ...current.messages].filter((entry) => {
    if (seen.has(entry.id)) return false
    seen.add(entry.id)
    return true
  })
  const omitted =
    current.page.omittedOversizedEntries + older.page.omittedOversizedEntries
  const truncated =
    !!current.page.contentTruncated || !!older.page.contentTruncated
  return {
    messages,
    taskNotifications: [
      ...(older.taskNotifications ?? []),
      ...(current.taskNotifications ?? []),
    ],
    page: {
      ...current.page,
      nextCursor: older.page.nextCursor,
      hasMore: older.page.hasMore,
      scannedBytes: current.page.scannedBytes + older.page.scannedBytes,
      omittedOversizedEntries: omitted,
      contentTruncated: truncated,
      historyComplete:
        !older.page.nextCursor &&
        !current.page.previousCursor &&
        omitted === 0 &&
        !truncated,
    },
  }
}

/**
 * 用重新读到的最新一页刷新已经往前翻过的历史，不把翻过的部分丢掉。
 * 会话只追加时，最新一页的第一条一定落在已加载的范围里：把更早的部分接回去，
 * 继续沿用原来那条游标链（服务端校验首尾指纹，只追加时它仍然有效）。
 * 接不上（新增超过一页、或会话被改写）时返回 undefined，由调用方决定补页还是只用最新一页。
 */
export function stitchLatestPage(
  loaded: HistoryPage | undefined,
  latest: HistoryPage
): HistoryPage | undefined {
  const first = latest.messages[0]
  if (!loaded?.page || !loaded.messages.length || !latest.page?.nextCursor || !first)
    return latest
  const start = loaded.messages.findIndex((entry) => entry.id === first.id)
  if (start < 0) return undefined
  const overlap = loaded.messages.slice(start)
  if (
    overlap.length > latest.messages.length ||
    overlap.some((entry, index) => entry.id !== latest.messages[index]!.id)
  )
    return undefined
  if (start === 0) return latest
  const omitted = Math.max(
    loaded.page.omittedOversizedEntries,
    latest.page.omittedOversizedEntries
  )
  const truncated = !!loaded.page.contentTruncated || !!latest.page.contentTruncated
  return {
    messages: [...loaded.messages.slice(0, start), ...latest.messages],
    taskNotifications: latest.taskNotifications,
    page: {
      ...latest.page,
      nextCursor: loaded.page.nextCursor,
      hasMore: loaded.page.hasMore,
      // 再往前翻拿到的页带着游标链的版本，合并时要对得上。
      sourceVersion: loaded.page.sourceVersion,
      omittedOversizedEntries: omitted,
      contentTruncated: truncated,
      historyComplete: !loaded.page.nextCursor && omitted === 0 && !truncated,
    },
  }
}

export function createChatState(
  sessionId: string,
  history: readonly HistoryEntry[] = []
): ChatState {
  return {
    sessionId,
    items: normalizeHistory(history),
    status: 'idle',
    turnActive: false,
    connected: false,
    configPending: false,
    permissions: [],
    computerUsePermissions: [],
    backgroundTaskIds: [],
    nextId: 1,
  }
}

function append(state: ChatState, item: Omit<ChatItem, 'id'>): ChatState {
  return {
    ...state,
    nextId: state.nextId + 1,
    items: [
      ...state.items,
      { ...item, id: `live:${state.sessionId}:${state.nextId}` },
    ],
  }
}
function updateItem(
  state: ChatState,
  id: string,
  patch: Partial<ChatItem>
): ChatState {
  return {
    ...state,
    items: state.items.map((item) =>
      item.id === id ? { ...item, ...patch } : item
    ),
  }
}
function clearActive(state: ChatState): ChatState {
  return {
    ...state,
    activeTextId: undefined,
    activeThinkingId: undefined,
    activeToolId: undefined,
  }
}
function permissionStatus(state: ChatState): ChatState['status'] {
  return state.permissions.length || state.computerUsePermissions.length
    ? 'permission_pending'
    : state.turnActive
      ? state.status === 'permission_pending' || state.status === 'idle'
        ? 'thinking'
        : state.status
      : 'idle'
}

/** Local user intent, separate from server events. Call only after socket.send succeeds. */
export function appendPendingUserMessage(
  state: ChatState,
  text: string,
  attachments?: ChatItem['attachments']
): ChatState {
  return append(
    { ...clearActive(state), error: undefined },
    {
      type: 'user',
      text,
      ...(attachments?.length ? { attachments } : {}),
      pending: true,
      delivery: 'pending',
      awaitingReplay: true,
    }
  )
}

/** 子 Agent 的实时轨迹另存一份（state.subagents），供运行中底单使用。 */
export function chatReducer(state: ChatState, event: ServerEvent): ChatState {
  const next = reduceChat(state, event)
  const subagents = reduceSubagents(next.subagents, event)
  return subagents === next.subagents ? next : { ...next, subagents }
}

function reduceChat(state: ChatState, event: ServerEvent): ChatState {
  switch (event.type) {
    case 'connected':
      return event.sessionId === state.sessionId
        ? { ...state, connected: true }
        : state
    case 'session_state': {
      const next = {
        ...state,
        turnActive: event.turnState === 'running',
        backgroundTaskIds:
          event.activeBackgroundTaskIds ?? state.backgroundTaskIds,
      }
      return { ...next, status: permissionStatus(next) }
    }
    case 'status': {
      // Stops can end with idle alone, without a message_complete event.
      const next =
        event.state === 'idle'
          ? {
              ...clearActive(state),
              items: state.items.map((item) =>
                item.pending
                  ? {
                      ...item,
                      pending: false,
                      ...(item.type === 'user'
                        ? { delivery: 'uncertain' as const }
                        : {}),
                    }
                  : item
              ),
            }
          : state
      return {
        ...next,
        status:
          state.permissions.length || state.computerUsePermissions.length
            ? 'permission_pending'
            : event.state,
        turnActive: event.state !== 'idle',
        ...(event.attemptStart ? { error: undefined } : {}),
      }
    }
    case 'content_start': {
      const next = clearActive(state)
      if (event.blockType === 'text') {
        const result = append(
          { ...next, status: 'streaming', turnActive: true },
          {
            type: 'assistant',
            text: '',
            model: state.runtime?.modelId,
            pending: true,
          }
        )
        return { ...result, activeTextId: result.items.at(-1)?.id }
      }
      if (!event.toolUseId) return state
      const existing = next.items.find(
        (item) => item.type === 'tool' && item.toolUseId === event.toolUseId
      )
      const result = existing
        ? next
        : append(next, {
            type: 'tool',
            text: '',
            toolName: event.toolName,
            toolUseId: event.toolUseId,
            parentToolUseId: event.parentToolUseId,
            partialInput: '',
            pending: true,
          })
      return {
        ...result,
        activeToolId: existing?.id ?? result.items.at(-1)?.id,
        status: 'tool_executing',
        turnActive: true,
      }
    }
    case 'content_delta': {
      let next = state
      if (event.text) {
        let active = next.items.find((item) => item.id === next.activeTextId)
        if (!active) {
          next = append(clearActive(next), {
            type: 'assistant',
            text: '',
            model: next.runtime?.modelId,
            pending: true,
          })
          active = next.items.at(-1)!
          next = { ...next, activeTextId: active.id }
        }
        next = {
          ...updateItem(next, active.id, { text: active.text + event.text }),
          status: 'streaming',
          turnActive: true,
        }
      }
      if (event.toolInput && next.activeToolId) {
        const item = next.items.find((item) => item.id === next.activeToolId)
        if (item)
          next = updateItem(next, item.id, {
            partialInput: (item.partialInput ?? '') + event.toolInput,
          })
      }
      return next
    }
    case 'thinking': {
      const active = state.items.find(
        (item) => item.id === state.activeThinkingId
      )
      if (!event.text.trim() && (event.complete || !active)) return state
      if (event.complete && active?.text === event.text) return state
      if (active)
        return {
          ...updateItem(state, active.id, {
            text: event.complete
              ? `${active.text}\n\n${event.text}`
              : active.text + event.text,
          }),
          status: 'thinking',
          turnActive: true,
        }
      const next = append(clearActive(state), {
        type: 'thinking',
        text: event.text,
      })
      return {
        ...next,
        activeThinkingId: next.items.at(-1)?.id,
        status: 'thinking',
        turnActive: true,
      }
    }
    case 'tool_use_complete': {
      const existing = state.items.find(
        (item) => item.type === 'tool' && item.toolUseId === event.toolUseId
      )
      const item = {
        type: 'tool' as const,
        text: '',
        toolName: event.toolName,
        toolUseId: event.toolUseId,
        parentToolUseId: event.parentToolUseId,
        input: event.input,
        partialInput: undefined,
        pending: true,
      }
      return existing
        ? updateItem(state, existing.id, {
            ...item,
            ...(existing.result !== undefined
              ? { text: existing.text, pending: false }
              : {}),
          })
        : append(clearActive(state), item)
    }
    case 'tool_result': {
      const existing = state.items.find(
        (item) => item.type === 'tool' && item.toolUseId === event.toolUseId
      )
      const patch = {
        result: event.content,
        text: resultText(event.content),
        isError: event.isError,
        pending: false,
      }
      return existing
        ? updateItem(state, existing.id, patch)
        : append(clearActive(state), {
            type: 'tool',
            toolUseId: event.toolUseId,
            parentToolUseId: event.parentToolUseId,
            ...patch,
          })
    }
    case 'permission_request':
      return {
        ...state,
        permissions: [
          ...state.permissions.filter((p) => p.requestId !== event.requestId),
          event,
        ],
        status: 'permission_pending',
        turnActive: true,
      }
    case 'computer_use_permission_request':
      return {
        ...state,
        computerUsePermissions: [
          ...state.computerUsePermissions.filter(
            (p) => p.requestId !== event.requestId
          ),
          event,
        ],
        status: 'permission_pending',
        turnActive: true,
      }
    case 'permission_resolved': {
      const next = {
        ...state,
        permissions:
          event.permissionType === 'tool'
            ? state.permissions.filter((p) => p.requestId !== event.requestId)
            : state.permissions,
        computerUsePermissions:
          event.permissionType === 'computer_use'
            ? state.computerUsePermissions.filter(
                (p) => p.requestId !== event.requestId
              )
            : state.computerUsePermissions,
      }
      return { ...next, status: permissionStatus(next) }
    }
    case 'permission_requests_snapshot': {
      const next = {
        ...state,
        turnActive: event.turnActive,
        permissions: state.permissions.filter((p) =>
          event.toolRequestIds.includes(p.requestId)
        ),
        computerUsePermissions: state.computerUsePermissions.filter((p) =>
          event.computerUseRequestIds.includes(p.requestId)
        ),
      }
      return { ...next, status: permissionStatus(next) }
    }
    case 'user_message_replay': {
      // 成员发给队长的消息开启了队长的新一轮，但不是用户发言（和桌面端一致）。
      if (isTeammateEnvelope(event.content))
        return {
          ...clearActive(state),
          turnActive: true,
          status: state.status === 'idle' ? ('thinking' as const) : state.status,
        }
      const restored = restoreFileReferences(event.content)
      let matchedText = restored.text
      let metadata: { path?: string }[] = []
      const matched = state.items.find((item) => {
        // 回合先结束时 pending 会被清掉，但 awaitingReplay 还留着：回放晚到也要对回原消息。
        if (item.type !== 'user' || !(item.pending || item.awaitingReplay)) return false
        if (item.text === event.content || item.text === restored.text) {
          matchedText = item.text
          return true
        }
        const normalized = restoreImageReplay(
          restored.text,
          item.attachments?.filter((attachment) => attachment.type === 'image')
            .length ?? 0
        )
        if (
          item.text !== normalized.text &&
          !(
            !item.text &&
            item.attachments?.length &&
            attachmentOnlyPlaceholder(normalized.text)
          )
        )
          return false
        matchedText = normalized.text
        metadata = normalized.metadata
        return true
      })
      const next = {
        ...clearActive(state),
        turnActive: true,
        status: state.status === 'idle' ? ('thinking' as const) : state.status,
      }
      return matched
        ? updateItem(next, matched.id, {
            text:
              matched.attachments?.length && attachmentOnlyPlaceholder(matchedText)
                ? matched.text
                : matchedText,
            ...(matched.attachments?.length
              ? { attachments: applyImageMetadata(matched.attachments, metadata) }
              : restored.attachments.length
                ? { attachments: restored.attachments }
                : {}),
            pending: false,
            delivery: 'confirmed',
            awaitingReplay: false,
          })
        : append(next, {
            type: 'user',
            text: restored.text,
            ...(restored.attachments.length ? { attachments: restored.attachments } : {}),
            delivery: 'confirmed',
          })
    }
    case 'message_complete':
      return {
        ...clearActive(state),
        items: state.items.map((item) =>
          item.pending
            ? {
                ...item,
                pending: false,
                ...(item.type === 'user'
                  ? { delivery: 'confirmed' as const }
                  : {}),
              }
            : item
        ),
        status: 'idle',
        turnActive: false,
        permissions: [],
        computerUsePermissions: [],
        usage: event.usage,
      }
    case 'runtime_config_applied':
      return {
        ...state,
        runtime: {
          providerId: event.providerId,
          modelId: event.modelId,
          effortLevel: event.effortLevel,
          openAIFastMode: event.openAIFastMode,
        },
      }
    case 'permission_mode_changed':
      return { ...state, permissionMode: event.mode }
    case 'error': {
      // A rejected settings change leaves the current run intact, matching desktop.
      const configurationRejected = [
        'RUNTIME_CONFIG_INVALID',
        'PERMISSION_MODE_CHANGE_FAILED',
        'LEAN_CAPABILITY_UNAVAILABLE',
        'SIDE_CHAT_RUNTIME_RESTART_UNAVAILABLE',
      ].includes(event.code)
      const next = configurationRejected
        ? state
        : {
            ...clearActive(state),
            status: 'idle' as const,
            turnActive: false,
            permissions: [],
            computerUsePermissions: [],
            items: state.items.map((item) =>
              item.pending ? { ...item, pending: false } : item
            ),
          }
      return append(
        {
          ...next,
          error: {
            message: event.message,
            code: event.code,
            retryable: event.retryable,
          },
        },
        { type: 'error', text: event.message }
      )
    }
    case 'session_title_updated':
      return event.sessionId === state.sessionId
        ? { ...state, title: event.title }
        : state
    // 方案本身走 REST 读取；这里只记下“变了”，让审批入口重新读一次。
    case 'team_plan_updated': {
      if (event.sessionId !== state.sessionId) return state
      const signal = `${event.planId}:${event.revision}:${event.state}`
      return signal === state.teamPlanSignal ? state : { ...state, teamPlanSignal: signal }
    }
    // 团队目录被删时方案也没了；删得太快时电脑来不及推 team_plan_updated，只有这一条。
    case 'team_deleted': {
      if (event.leadSessionId && event.leadSessionId !== state.sessionId) return state
      const signal = `deleted:${event.teamName}:${event.incarnationId ?? event.createdAt ?? ''}`
      return signal === state.teamPlanSignal ? state : { ...state, teamPlanSignal: signal }
    }
    case 'system_notification': {
      const data = record(event.data)
      const taskId = string(data?.task_id) ? data.task_id.trim() : ''
      let next = state
      if (taskId) {
        // Match the server's activeBackgroundTaskIds lifecycle, independently
        // of the foreground turn. A stop bookend need not contain message text.
        const running =
          event.subtype === 'task_started' ||
          (event.subtype === 'task_notification' && data?.status === 'running')
        const terminal =
          event.subtype === 'task_notification' &&
          ['completed', 'failed', 'stopped', 'killed'].includes(
            String(data?.status)
          )
        if (running && !state.backgroundTaskIds.includes(taskId)) {
          next = {
            ...state,
            backgroundTaskIds: [...state.backgroundTaskIds, taskId],
          }
        } else if (terminal && state.backgroundTaskIds.includes(taskId)) {
          next = {
            ...state,
            backgroundTaskIds: state.backgroundTaskIds.filter(
              (id) => id !== taskId
            ),
          }
        }
      }
      // 子 Agent / 后台任务的开始、进度、结束只更新活动底单和顶栏胶囊；它们的说明文字
      // （「Reading src/todo.ts」「Sleep 45 seconds…」）若进主对话流，一个任务会刷出几十行灰字。
      const taskEvent =
        event.subtype === 'task_started' ||
        event.subtype === 'task_progress' ||
        event.subtype === 'task_notification'
      return event.message && !taskEvent
        ? append(next, { type: 'system', text: event.message })
        : next
    }
    // Subagent events belong to their own run, never to the parent's text stream.
    default:
      return state
  }
}
