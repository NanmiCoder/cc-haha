/** Where a trajectory row lives in the chat transcript. */
export type ChatNavigationTarget = {
  toolUseId?: string
  /** Transcript entry uuids of the row; any one of them identifies its chat item. */
  uuids?: string[]
}

type ToolCallLike = { toolUseId?: string; originalToolUseId?: string }
type MessageLike = ToolCallLike & { id: string; type: string; transcriptMessageId?: string }

/** Structural view of MessageList's render items, so this stays testable without it. */
export type ChatRenderItemLike =
  | { kind: 'message'; message: MessageLike }
  | { kind: 'tool_group'; id: string; toolCalls: readonly ToolCallLike[] }
  | { kind: 'team_card'; id: string; coordinationToolCalls: readonly ToolCallLike[] }

function findToolUse(calls: readonly ToolCallLike[], toolUseId: string): ToolCallLike | undefined {
  return calls.find((call) => call.toolUseId === toolUseId || call.originalToolUseId === toolUseId)
}

/**
 * Where `target` renders: the render item's index, plus — when it was found by
 * a tool call — the id that call renders under. A group folds its calls away,
 * so scrolling to the group alone shows nothing; the caller needs the call's
 * own id to open the group and point at that row.
 */
export type ChatRenderTarget = {
  index: number
  /** The matched call's rendered `toolUseId` (not necessarily the requested original id). */
  toolUseId?: string
}

export function findChatRenderTarget(items: readonly ChatRenderItemLike[], target: ChatNavigationTarget): ChatRenderTarget {
  const { toolUseId } = target
  if (toolUseId) {
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]!
      const call = item.kind === 'tool_group'
        ? findToolUse(item.toolCalls, toolUseId)
        : item.kind === 'team_card'
          ? findToolUse(item.coordinationToolCalls, toolUseId)
          : item.message.type === 'tool_use' ? findToolUse([item.message], toolUseId) : undefined
      if (call) return { index, toolUseId: call.toolUseId }
    }
  }
  const uuids = new Set(target.uuids ?? [])
  if (!uuids.size) return { index: -1 }
  return {
    index: items.findIndex((item) => item.kind === 'message' && (
      uuids.has(item.message.id) || (item.message.transcriptMessageId !== undefined && uuids.has(item.message.transcriptMessageId))
    )),
  }
}

/** Index of the render item that shows `target`, or -1 when it is not loaded. */
export function findChatRenderIndex(items: readonly ChatRenderItemLike[], target: ChatNavigationTarget): number {
  return findChatRenderTarget(items, target).index
}
