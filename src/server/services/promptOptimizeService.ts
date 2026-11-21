import { z } from 'zod/v4'
import { ApiError } from '../middleware/errorHandler.js'
import { powerActivityClock } from './powerActivityClock.js'

export const promptOptimizeInputSchema = z.strictObject({
  requestId: z.uuid(),
  prompt: z.string().trim().min(1).max(32_000),
})
export type PromptOptimizeInput = z.infer<typeof promptOptimizeInputSchema>

type Dependencies = {
  ensure: (sessionId: string, url: URL) => Promise<void>
  control: (
    sessionId: string,
    request: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ) => Promise<Record<string, unknown>>
}

type Pending = {
  id: string
  controller: AbortController
  started: boolean
  cancel?: Promise<void>
}

// Ephemeral control work only. Never sends user messages, touches the queue,
// writes a transcript, or interrupts the session's main controller.
export class PromptOptimizeService {
  private pending = new Map<string, Pending>()
  private seen = new Map<string, Set<string>>()

  constructor(
    private dependencies: Dependencies,
    private timeoutMs = 120_000,
  ) {}

  hasPendingWork(): boolean {
    return this.pending.size > 0
  }

  private remember(sessionId: string, requestId: string): void {
    const seen = this.seen.get(sessionId) ?? new Set<string>()
    seen.add(requestId)
    if (seen.size > 1000) seen.delete(seen.values().next().value!)
    this.seen.set(sessionId, seen)
  }

  private abort(sessionId: string, entry: Pending): Promise<void> {
    if (entry.cancel) return entry.cancel
    entry.controller.abort()
    entry.cancel = entry.started
      ? this.dependencies
          .control(
            sessionId,
            { subtype: 'cancel_optimize_prompt', request_id: entry.id },
            10_000,
          )
          .then(
            () => {},
            () => {},
          )
      : Promise.resolve()
    return entry.cancel
  }

  async cancel(sessionId: string, requestId: string): Promise<boolean> {
    const entry = this.pending.get(sessionId)
    if (!entry || entry.id !== requestId) {
      // DELETE can arrive before POST finishes parsing/startup. Keep a recent
      // tombstone so that request cannot start after cancellation.
      if (z.uuid().safeParse(requestId).success) {
        this.remember(sessionId, requestId)
      }
      return false
    }
    await this.abort(sessionId, entry)
    return true
  }

  async optimize(
    sessionId: string,
    input: PromptOptimizeInput,
    url: URL,
    signal: AbortSignal,
  ) {
    if (signal.aborted) {
      throw new ApiError(
        499,
        'Prompt optimization cancelled',
        'PROMPT_OPTIMIZE_CANCELLED',
      )
    }
    if (this.pending.has(sessionId)) {
      throw ApiError.conflict(
        'Prompt optimization is already running in this session',
      )
    }
    const seen = this.seen.get(sessionId) ?? new Set<string>()
    if (seen.has(input.requestId)) {
      throw ApiError.conflict(
        'This prompt optimization request ID has already been used',
      )
    }
    this.remember(sessionId, input.requestId)
    const entry: Pending = {
      id: input.requestId,
      controller: new AbortController(),
      started: false,
    }
    this.pending.set(sessionId, entry)
    powerActivityClock.changed()
    let timedOut = false
    const cancel = () => {
      void this.abort(sessionId, entry)
    }
    signal.addEventListener('abort', cancel, { once: true })
    const timer = setTimeout(() => {
      timedOut = true
      cancel()
    }, this.timeoutMs)
    let rejectAbort: (() => void) | undefined
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(new Error('Prompt optimization aborted'))
      entry.controller.signal.addEventListener('abort', rejectAbort, {
        once: true,
      })
    })
    try {
      if (signal.aborted) cancel()
      await Promise.race([this.dependencies.ensure(sessionId, url), aborted])
      if (entry.controller.signal.aborted) {
        throw new Error('Prompt optimization aborted')
      }
      entry.started = true
      const result = await Promise.race([
        this.dependencies.control(
          sessionId,
          {
            subtype: 'optimize_prompt',
            request_id: input.requestId,
            prompt: input.prompt,
          },
          this.timeoutMs,
          entry.controller.signal,
        ),
        aborted,
      ])
      if (entry.controller.signal.aborted) {
        throw new Error('Prompt optimization aborted')
      }
      if (
        typeof result.optimizedPrompt !== 'string' ||
        !result.optimizedPrompt.trim()
      ) {
        throw new Error('CLI returned an invalid optimized prompt response')
      }
      powerActivityClock.completed()
      return {
        requestId: input.requestId,
        optimizedPrompt: result.optimizedPrompt,
      }
    } catch (error) {
      if (entry.controller.signal.aborted) {
        throw new ApiError(
          timedOut ? 504 : 499,
          timedOut
            ? 'Prompt optimization timed out'
            : 'Prompt optimization cancelled',
          timedOut ? 'PROMPT_OPTIMIZE_TIMEOUT' : 'PROMPT_OPTIMIZE_CANCELLED',
        )
      }
      if (error instanceof ApiError) throw error
      throw new ApiError(
        502,
        error instanceof Error ? error.message : 'Prompt optimization failed',
        'PROMPT_OPTIMIZE_FAILED',
      )
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', cancel)
      if (rejectAbort) {
        entry.controller.signal.removeEventListener('abort', rejectAbort)
      }
      await entry.cancel
      if (this.pending.get(sessionId) === entry) {
        this.pending.delete(sessionId)
      }
      powerActivityClock.changed()
    }
  }
}
