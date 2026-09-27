import { useCallback, useEffect, useRef, useState } from 'react'
import { subagentsApi } from '../../api/subagents'
import { mapHistoryMessagesToUiMessages } from '../../stores/chatStore'
import type { MessageEntry } from '../../types/session'
import type { UIMessage } from '../../types/chat'

type ToolCall = Extract<UIMessage, { type: 'tool_use' }>
type ToolResult = Extract<UIMessage, { type: 'tool_result' }>

export type AgentRunActivity = {
  toolCalls: ToolCall[]
  resultMap: Map<string, ToolResult>
  childToolCallsByParent: Map<string, ToolCall[]>
  /** The inline stream was cut down to head + tail; the full run lives on its own page. */
  truncated: boolean
}

export type AgentRunActivityState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; activity: AgentRunActivity }

/**
 * How many runs stay expanded-in-memory after they are fetched. A finished run
 * is immutable, so the cache only exists to make re-expanding a card free; it
 * is capped because a single run can carry megabytes of tool output.
 */
const MAX_CACHED_RUNS = 8
/**
 * Runs are capped by message count too, not just by run count: one run can
 * carry thousands of tool results, and 8 such runs would otherwise sit in the
 * heap for the life of the window.
 */
const MAX_CACHED_MESSAGES = 8_000
/**
 * A run's transcript file is append-only while the agent lives, and a teammate
 * can be resumed after it finished. Entries older than this are re-fetched so
 * a cached snapshot cannot outlive the run it describes.
 */
const ACTIVITY_CACHE_TTL_MS = 5 * 60_000
/** Mirror of the server's `truncateSubagentMessages`: >1000 keeps first 50 + last 950. */
const TRUNCATE_THRESHOLD = 1000
const TRUNCATE_HEAD = 50
const TRUNCATE_TAIL = 950

type CachedActivity = {
  activity: AgentRunActivity
  messageCount: number
  cachedAt: number
}

// Module scope on purpose: expanding a card, collapsing it, and expanding it
// again must not re-download the run, and two cards asking for the same run at
// once must share one request.
const activityCache = new Map<string, CachedActivity>()
const activityRequests = new Map<string, Promise<AgentRunActivity>>()

function activityKey(sessionId: string, toolUseId: string, taskId?: string | null) {
  return `${sessionId}\u0000${toolUseId}\u0000${taskId ?? ''}`
}

function cachedMessageTotal() {
  let total = 0
  for (const entry of activityCache.values()) total += entry.messageCount
  return total
}

function readCachedActivity(key: string): AgentRunActivity | undefined {
  const cached = activityCache.get(key)
  if (!cached) return undefined
  if (Date.now() - cached.cachedAt > ACTIVITY_CACHE_TTL_MS) {
    activityCache.delete(key)
    return undefined
  }
  // Refresh recency: Map iteration order is insertion order, and eviction
  // always drops the oldest entry.
  activityCache.delete(key)
  activityCache.set(key, cached)
  return cached.activity
}

function writeCachedActivity(key: string, activity: AgentRunActivity, messageCount: number) {
  activityCache.set(key, { activity, messageCount, cachedAt: Date.now() })
  // Keep at least the newest entry even if it alone exceeds the budget.
  while (
    activityCache.size > 1 &&
    (activityCache.size > MAX_CACHED_RUNS || cachedMessageTotal() > MAX_CACHED_MESSAGES)
  ) {
    const oldest = activityCache.keys().next()
    if (oldest.done) break
    activityCache.delete(oldest.value)
  }
}

function truncateActivityMessages(messages: MessageEntry[]): {
  messages: MessageEntry[]
  truncated: boolean
} {
  if (messages.length <= TRUNCATE_THRESHOLD) {
    return { messages, truncated: false }
  }
  return {
    messages: [
      ...messages.slice(0, TRUNCATE_HEAD),
      ...messages.slice(-TRUNCATE_TAIL),
    ],
    truncated: true,
  }
}

function buildActivity(messages: MessageEntry[], truncated: boolean): AgentRunActivity {
  const uiMessages = mapHistoryMessagesToUiMessages(messages, {
    includeTeammateMessages: true,
  })
  const toolCalls: ToolCall[] = []
  const resultMap = new Map<string, ToolResult>()
  const childToolCallsByParent = new Map<string, ToolCall[]>()

  for (const message of uiMessages) {
    if (message.type === 'tool_result') {
      resultMap.set(message.toolUseId, message)
      continue
    }
    if (message.type !== 'tool_use') continue
    if (message.parentToolUseId) {
      const siblings = childToolCallsByParent.get(message.parentToolUseId)
      if (siblings) siblings.push(message)
      else childToolCallsByParent.set(message.parentToolUseId, [message])
      continue
    }
    toolCalls.push(message)
  }

  return { toolCalls, resultMap, childToolCallsByParent, truncated }
}

async function loadActivity(
  key: string,
  sessionId: string,
  toolUseId: string,
  taskId?: string | null,
): Promise<AgentRunActivity> {
  const pending = activityRequests.get(key)
  if (pending) return pending

  const request = subagentsApi
    .getRunByTool(sessionId, toolUseId, taskId ?? undefined)
    .then((run) => {
      // The server omits `activityMessages` unless it differs from `messages`
      // (i.e. unless truncation kicked in), so the fallback is the same stream.
      const source = run.activityMessages ?? run.messages
      const truncated = truncateActivityMessages(source)
      // Servers predating `activityMessages` only send the possibly-truncated
      // `messages`; their own flag is then the only honest signal left.
      const truncatedByServer = run.activityMessages === undefined && run.truncated === true
      const activity = buildActivity(
        truncated.messages,
        truncated.truncated || truncatedByServer,
      )
      // A live run keeps producing; caching it would freeze the timeline at
      // whatever the first expand saw.
      if (run.status !== 'running') {
        writeCachedActivity(key, activity, truncated.messages.length)
      }
      return activity
    })
    .finally(() => {
      if (activityRequests.get(key) === request) activityRequests.delete(key)
    })

  activityRequests.set(key, request)
  return request
}

/**
 * Fetch one subagent run's tool stream when its Agent card is expanded.
 *
 * The session timeline deliberately no longer carries child tool messages —
 * merging them into `/messages` made one real session 542 MB, past the
 * 536,870,888-character response limit where Chromium hands back an empty body.
 * Expanding a card is the point where that detail is actually wanted, so the
 * run is read straight from `/subagents/by-tool` instead.
 */
export function useAgentRunActivity(params: {
  enabled: boolean
  sessionId?: string | null
  toolUseId?: string | null
  taskId?: string | null
}): { state: AgentRunActivityState; retry: () => void } {
  const { enabled, sessionId, toolUseId, taskId } = params
  const [state, setState] = useState<AgentRunActivityState>({ status: 'idle' })
  const [attempt, setAttempt] = useState(0)
  const requestIdRef = useRef(0)

  const retry = useCallback(() => {
    setAttempt((value) => value + 1)
  }, [])

  useEffect(() => {
    if (!enabled || !sessionId || !toolUseId) {
      // Bump the generation so an in-flight response cannot land on a card
      // that has since collapsed or switched to another run.
      requestIdRef.current += 1
      setState({ status: 'idle' })
      return
    }

    const key = activityKey(sessionId, toolUseId, taskId)
    const cached = readCachedActivity(key)
    if (cached) {
      requestIdRef.current += 1
      setState({ status: 'ready', activity: cached })
      return
    }

    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId
    setState({ status: 'loading' })

    void loadActivity(key, sessionId, toolUseId, taskId).then(
      (activity) => {
        if (requestIdRef.current !== requestId) return
        setState({ status: 'ready', activity })
      },
      () => {
        if (requestIdRef.current !== requestId) return
        setState({ status: 'error' })
      },
    )
  }, [attempt, enabled, sessionId, taskId, toolUseId])

  return { state, retry }
}

/** Test seam: module-level caches would otherwise leak between test cases. */
export function resetAgentRunActivityCache() {
  activityCache.clear()
  activityRequests.clear()
}
