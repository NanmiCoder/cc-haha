import type { UIMessage } from '../types/chat'

export type TurnCompletion = {
  /** Time of the turn's last message, i.e. when the turn ended. */
  completedAt: number
  /** Time from the user prompt to the end of the turn; omitted when start or end is unreliable. */
  durationMs?: number
}

/**
 * A duration over a day is not a real wait: turns spanning days in history are usually
 * sessions resumed after an interruption, and showing 18 hours as model run time misleads.
 */
const MAX_PLAUSIBLE_TURN_MS = 24 * 60 * 60 * 1000

type OpenTurn = {
  startedAt: number
  completedAt: number
  lastAssistantTextId: string | null
  /** Whether real content follows the last assistant text (if so, the turn did not end with a reply). */
  hasWorkAfterLastReply: boolean
}

function isTurnStart(message: UIMessage): boolean {
  // pending is a teammate-session placeholder and optimisticQueued a queued message not yet sent:
  // neither has started, so treating them as a turn start would mark the previous turn done too early.
  return (
    message.type === 'user_text' &&
    message.pending !== true &&
    message.optimisticQueued !== true
  )
}

/**
 * These are extra cards hanging off the end of a turn, not progress within it: the task
 * summary is written on the next send, and background tasks run outside the main turn.
 * Following the final reply, they do not stop the turn from counting as answered.
 */
function isTrailingCard(message: UIMessage): boolean {
  return message.type === 'task_summary' || message.type === 'background_task'
}

/**
 * Compute each turn's end time and attach it to the assistant reply that closes the turn.
 *
 * A turn is every message from one user prompt to the next. Only turns that end with an
 * assistant reply count as complete: if tool calls follow the last reply, the assistant
 * kept working after speaking, and a "done" stamp under a mid-way transition line is wrong and odd.
 *
 * When `turnActive` is true the last turn yields nothing: it is still running, so any "done time" now would be false.
 */
export function buildTurnCompletionByMessageId(
  messages: UIMessage[],
  options: { turnActive?: boolean } = {},
): Map<string, TurnCompletion> {
  const completions = new Map<string, TurnCompletion>()
  const turns: OpenTurn[] = []
  let current: OpenTurn | null = null

  for (const message of messages) {
    if (isTurnStart(message)) {
      const startedAt = Number.isFinite(message.timestamp) ? message.timestamp : Number.NaN
      current = {
        startedAt,
        completedAt: startedAt,
        lastAssistantTextId: null,
        hasWorkAfterLastReply: false,
      }
      turns.push(current)
      continue
    }

    // Messages before the first user prompt belong to no turn; with no start there is no duration.
    if (!current) continue
    if (isTrailingCard(message)) continue

    if (Number.isFinite(message.timestamp)) {
      current.completedAt = Number.isFinite(current.completedAt)
        ? Math.max(current.completedAt, message.timestamp)
        : message.timestamp
    }
    if (message.type === 'assistant_text') {
      current.lastAssistantTextId = message.id
      current.hasWorkAfterLastReply = false
    } else {
      current.hasWorkAfterLastReply = true
    }
  }

  const lastTurnIndex = turns.length - 1
  turns.forEach((turn, index) => {
    if (options.turnActive === true && index === lastTurnIndex) return
    if (!turn.lastAssistantTextId || turn.hasWorkAfterLastReply) return
    if (!Number.isFinite(turn.completedAt)) return

    const durationMs = turn.completedAt - turn.startedAt
    const plausible = Number.isFinite(durationMs) && durationMs >= 0 && durationMs <= MAX_PLAUSIBLE_TURN_MS
    completions.set(turn.lastAssistantTextId, {
      completedAt: turn.completedAt,
      ...(plausible ? { durationMs } : {}),
    })
  })

  return completions
}
