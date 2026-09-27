import { z } from 'zod/v4'
import { ApiError } from '../middleware/errorHandler.js'

export const sideQuestionInputSchema = z.strictObject({
  questionId: z.uuid(),
  question: z.string().trim().min(1).max(16_000),
  history: z.array(z.strictObject({
    question: z.string().trim().min(1).max(16_000),
    response: z.string().min(1).max(64_000),
  })).max(20).default([]),
})
export type SideQuestionInput = z.infer<typeof sideQuestionInputSchema>

type Dependencies = {
  ensure: (sessionId: string, url: URL) => Promise<void>
  control: (sessionId: string, request: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal) => Promise<Record<string, unknown>>
}
type Pending = { id: string; controller: AbortController; started: boolean; cancel?: Promise<void> }

// Ephemeral control work only. This service never sends user messages, touches
// the queue, writes a transcript, or interrupts the session's main controller.
export class SideQuestionService {
  private pending = new Map<string, Pending>()
  private seen = new Map<string, Set<string>>()
  constructor(private dependencies: Dependencies, private timeoutMs = 300_000) {}

  private remember(sessionId: string, questionId: string): void {
    const seen = this.seen.get(sessionId) ?? new Set<string>()
    seen.add(questionId)
    if (seen.size > 1000) seen.delete(seen.values().next().value!)
    this.seen.set(sessionId, seen)
  }

  private abort(sessionId: string, entry: Pending): Promise<void> {
    if (entry.cancel) return entry.cancel
    entry.controller.abort()
    entry.cancel = entry.started
      ? this.dependencies.control(sessionId, { subtype: 'cancel_side_question', question_id: entry.id }, 10_000).then(() => {}, () => {})
      : Promise.resolve()
    return entry.cancel
  }

  async cancel(sessionId: string, questionId: string): Promise<boolean> {
    const entry = this.pending.get(sessionId)
    if (!entry || entry.id !== questionId) {
      // DELETE can arrive before its POST has finished parsing/startup. Keep a
      // recent tombstone so that request cannot start after cancellation.
      if (z.uuid().safeParse(questionId).success) this.remember(sessionId, questionId)
      return false
    }
    await this.abort(sessionId, entry)
    return true
  }

  async ask(sessionId: string, input: SideQuestionInput, url: URL, signal: AbortSignal) {
    if (signal.aborted) throw new ApiError(499, 'Side question cancelled', 'SIDE_QUESTION_CANCELLED')
    if (this.pending.has(sessionId)) throw ApiError.conflict('A side question is already running in this session')
    const seen = this.seen.get(sessionId) ?? new Set<string>()
    if (seen.has(input.questionId)) throw ApiError.conflict('This side question ID has already been used')
    // Keep a bounded recent-ID retry guard; it is not a lifetime usage limit.
    this.remember(sessionId, input.questionId)
    const entry: Pending = { id: input.questionId, controller: new AbortController(), started: false }
    this.pending.set(sessionId, entry)
    let timedOut = false
    const cancel = () => { void this.abort(sessionId, entry) }
    signal.addEventListener('abort', cancel, { once: true })
    const timer = setTimeout(() => { timedOut = true; cancel() }, this.timeoutMs)
    let rejectAbort: (() => void) | undefined
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(new Error('Side question aborted'))
      entry.controller.signal.addEventListener('abort', rejectAbort, { once: true })
    })
    try {
      if (signal.aborted) cancel()
      await Promise.race([this.dependencies.ensure(sessionId, url), aborted])
      if (entry.controller.signal.aborted) throw new Error('Side question aborted')
      entry.started = true
      const result = await Promise.race([this.dependencies.control(sessionId, {
        subtype: 'side_question', question_id: input.questionId,
        question: input.question, history: input.history,
      }, this.timeoutMs, entry.controller.signal), aborted])
      if (entry.controller.signal.aborted) throw new Error('Side question aborted')
      if (typeof result.response !== 'string') throw new Error('CLI returned an invalid side question response')
      return { questionId: input.questionId, response: result.response }
    } catch (error) {
      if (entry.controller.signal.aborted) {
        throw new ApiError(timedOut ? 504 : 499, timedOut ? 'Side question timed out' : 'Side question cancelled', timedOut ? 'SIDE_QUESTION_TIMEOUT' : 'SIDE_QUESTION_CANCELLED')
      }
      if (error instanceof ApiError) throw error
      throw new ApiError(502, error instanceof Error ? error.message : 'Side question failed', 'SIDE_QUESTION_FAILED')
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', cancel)
      if (rejectAbort) entry.controller.signal.removeEventListener('abort', rejectAbort)
      await entry.cancel
      if (this.pending.get(sessionId) === entry) this.pending.delete(sessionId)
    }
  }
}
