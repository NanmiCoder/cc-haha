/**
 * Per-turn stream bookkeeping for the session handler.
 *
 * Third cut of `handler.ts`, moved verbatim. These functions own the block/scope
 * accounting a streamed turn needs — which content block is open, which scope it
 * belongs to, and which tool_use ids are nested under which parent — and they operate
 * only on the `SessionStreamState` handed to them. They touch no module-level
 * container, so the move is behavior-preserving.
 *
 * The state container itself (`sessionStreamStates`) and the reducer that consumes
 * this bookkeeping (`translateCliMessage`) stayed in `handler.ts`: the reducer also
 * reads session-control state such as `sessionStopRequested`, so relocating it would
 * mean either an import cycle or moving core session state into a parsing module.
 * Extracting the type here is the groundwork that a later reducer cut would need.
 */

import { cliParentToolUseId } from './cliMessageParsing.js'

export type SessionStreamState = {
  streamedAssistantMessageIds: Set<string>
  unidentifiedStreamScopes: Set<string>
  activeMessageIdsByScope: Map<string, string>
  activeBlockScopesByIndex: Map<number, Set<string>>
  activeBlockTypes: Map<string, 'text' | 'tool_use' | 'thinking'>
  activeToolBlocks: Map<string, { toolName: string; toolUseId: string; inputJson: string; parentToolUseId?: string }>
  pendingLocalCommand?: { name: string; args: string }
  /** Tool blocks whose input JSON failed to parse in content_block_stop.
   *  The assistant message carries the complete input — defer to that. */
  pendingToolBlocks: Map<string, { toolName: string; toolUseId: string; parentToolUseId?: string }>
  toolParentUseIds: Map<string, Set<string>>
  lastApiError?: {
    message: string
    code: string
  }
}

export function resetCurrentStreamAttempt(state: SessionStreamState): void {
  state.streamedAssistantMessageIds.clear()
  state.unidentifiedStreamScopes.clear()
  state.activeMessageIdsByScope.clear()
  state.activeBlockScopesByIndex.clear()
  state.activeBlockTypes.clear()
  state.activeToolBlocks.clear()
  state.pendingToolBlocks.clear()
  state.toolParentUseIds.clear()
}

export function streamBlockKey(scope: string, index: number): string {
  return JSON.stringify([scope, index])
}

export function rememberActiveBlockScope(
  streamState: SessionStreamState,
  index: number,
  scope: string,
): void {
  const scopes = streamState.activeBlockScopesByIndex.get(index) ?? new Set()
  scopes.add(scope)
  streamState.activeBlockScopesByIndex.set(index, scopes)
}

export function forgetActiveBlockScope(
  streamState: SessionStreamState,
  index: number,
  scope: string,
): void {
  const scopes = streamState.activeBlockScopesByIndex.get(index)
  if (!scopes) return
  scopes.delete(scope)
  if (scopes.size === 0) streamState.activeBlockScopesByIndex.delete(index)
}

export function resolveActiveBlockKey(
  streamState: SessionStreamState,
  cliMsg: any,
  index: number,
): { key: string; scope: string } | null {
  const parentToolUseId = cliParentToolUseId(cliMsg)
  if (parentToolUseId) {
    return {
      key: streamBlockKey(parentToolUseId, index),
      scope: parentToolUseId,
    }
  }

  const scopes = streamState.activeBlockScopesByIndex.get(index)
  if (scopes?.size !== 1) return null
  const scope = scopes.values().next().value
  if (typeof scope !== 'string') return null
  return { key: streamBlockKey(scope, index), scope }
}

export function pendingToolBlockKey(
  parentToolUseId: string | undefined,
  toolUseId: string,
): string {
  return JSON.stringify([parentToolUseId ?? null, toolUseId])
}

export function rememberToolParentUseId(
  streamState: SessionStreamState,
  toolUseId: string | undefined,
  parentToolUseId: string | undefined,
): void {
  if (!toolUseId || !parentToolUseId) return
  const parents = streamState.toolParentUseIds.get(toolUseId) ?? new Set()
  parents.add(parentToolUseId)
  streamState.toolParentUseIds.set(toolUseId, parents)
}

export function forgetToolParentUseId(
  streamState: SessionStreamState,
  toolUseId: string | undefined,
  parentToolUseId: string | undefined,
): void {
  if (!toolUseId || !parentToolUseId) return
  const parents = streamState.toolParentUseIds.get(toolUseId)
  if (!parents) return
  parents.delete(parentToolUseId)
  if (parents.size === 0) streamState.toolParentUseIds.delete(toolUseId)
}

export function consumeToolParentUseId(
  streamState: SessionStreamState,
  toolUseId: string | undefined,
): string | undefined {
  if (!toolUseId) return undefined
  const parents = streamState.toolParentUseIds.get(toolUseId)
  streamState.toolParentUseIds.delete(toolUseId)
  if (parents?.size !== 1) return undefined
  return parents.values().next().value
}
