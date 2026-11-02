import type { ComputerUseHostAdapter, ComputerUseSessionContext } from './types.js'
import type { CuCallToolResult } from './toolCalls.js'
import { parseAgentDesktopInput } from './agentDesktopProtocol.js'

const error = (message: string): CuCallToolResult => ({ isError: true, content: [{ type: 'text', text: message }] })

export function bindAgentDesktopSession(adapter: ComputerUseHostAdapter, ctx: ComputerUseSessionContext) {
  let tail: Promise<unknown> = Promise.resolve()
  return (name: string, args: unknown, signal?: AbortSignal): Promise<CuCallToolResult> => {
    const pending = tail.then(async () => {
      if (adapter.isDisabled() || ctx.isAborted?.() || signal?.aborted) return error('Computer Use is disabled or cancelled. No command was dispatched.')
      if (name !== 'desktop' || !adapter.agentDesktop) return error('Unknown native desktop tool.')
      let input
      try { input = parseAgentDesktopInput(args) } catch (cause) {
        return error(cause instanceof Error ? cause.message : 'Invalid desktop arguments')
      }
      if (ctx.checkCuLock) {
        const lock = await ctx.checkCuLock()
        if (lock.holder && !lock.isSelf) return error(ctx.formatLockHeldMessage?.(lock.holder)
          ?? 'Another session is using Computer Use. Wait until it finishes.')
        if (!lock.holder) await ctx.acquireCuLock?.()
        const owned = await ctx.checkCuLock()
        if (!owned.isSelf) return error('Computer Use ownership changed before dispatch. No command was dispatched.')
      }
      if (adapter.isDisabled() || ctx.isAborted?.() || signal?.aborted) return error('Computer Use is disabled or cancelled. No command was dispatched.')
      return adapter.agentDesktop.execute(input, signal, ctx.getAgentId?.() ?? 'main')
    }).catch(cause => error(cause instanceof Error ? cause.message : 'Native desktop command failed'))
    tail = pending.catch(() => {})
    return pending
  }
}
