import type {
  CancelPromptOptimizeResponse,
  PromptOptimizeRequest,
  PromptOptimizeResponse,
} from './promptOptimizeApi'

export type PromptOptimizeRestoreSnapshot = {
  id: number
  text: string
}

export type PromptOptimizeIssue = {
  code: string
  message: string
}

export type PromptOptimizeState = {
  phase: 'idle' | 'optimizing'
  restoreSnapshot: PromptOptimizeRestoreSnapshot | null
  notice: string | null
  issue: PromptOptimizeIssue | null
}

export type PromptOptimizeDraft<TClient = unknown> = {
  key: string
  client: TClient | null
  sessionId: string | null
  text: string
  blocked: boolean
}

type Dependencies<TClient = unknown> = {
  read(): PromptOptimizeDraft<TClient>
  write(text: string): void
  focus(): void
  changed(state: PromptOptimizeState): void
  newRequestId(): string
  optimize(
    client: TClient,
    sessionId: string,
    body: PromptOptimizeRequest,
    signal: AbortSignal,
  ): Promise<PromptOptimizeResponse>
  cancel(
    client: TClient,
    sessionId: string,
    requestId: string,
  ): Promise<CancelPromptOptimizeResponse | unknown>
}

type Run<TClient> = {
  key: string
  client: TClient
  sessionId: string
  requestId: string
  baselineText: string
  abort: AbortController
}

/** Matches server promptOptimizeInputSchema max character count. */
export const PROMPT_OPTIMIZE_MAX_CHARS = 32_000
/** Mobile has no hover-pause or Cmd+Z undo, so give readers a comfortable restore window. */
export const PROMPT_OPTIMIZE_RESTORE_MS = 15_000
export const PROMPT_OPTIMIZE_NOTICE_MS = 4_000

export const initialPromptOptimizeState = (): PromptOptimizeState => ({
  phase: 'idle',
  restoreSnapshot: null,
  notice: null,
  issue: null,
})

export function isOptimizablePrompt(text: string): boolean {
  const trimmed = text.trim()
  return trimmed.length > 0 && !trimmed.startsWith('/')
}

export function isPromptOptimizeAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { name?: string; code?: string; status?: number }
  return (
    candidate.name === 'AbortError' ||
    candidate.code === 'ABORT_ERR' ||
    candidate.code === 'ABORTED' ||
    candidate.code === 'PROMPT_OPTIMIZE_CANCELLED' ||
    candidate.status === 499
  )
}

export function promptOptimizeIssue(error: unknown): PromptOptimizeIssue {
  const candidate =
    error && typeof error === 'object'
      ? (error as { code?: unknown; status?: unknown; message?: unknown })
      : {}
  const code = typeof candidate.code === 'string' ? candidate.code : 'failed'
  const status = typeof candidate.status === 'number' ? candidate.status : 0
  const rawMessage =
    typeof candidate.message === 'string' && candidate.message.trim()
      ? candidate.message.trim()
      : error instanceof Error && error.message.trim()
        ? error.message.trim()
        : ''

  if (code === 'TIMEOUT' || code === 'PROMPT_OPTIMIZE_TIMEOUT' || status === 504) {
    return { code, message: '优化提示词超时，请重试。' }
  }
  if (code === 'NETWORK_ERROR') {
    return { code, message: '无法连接电脑，请检查连接后重试。' }
  }
  if (status === 409) {
    return { code, message: '当前会话正在优化提示词，请稍候重试。' }
  }
  if (status === 413 || code === 'BODY_TOO_LARGE' || code === 'PROMPT_TOO_LONG') {
    return { code, message: '提示词过长，精简后再试。' }
  }
  if (status === 405 || (status === 404 && !/^Session not found/i.test(rawMessage))) {
    return {
      code,
      message: '当前电脑端版本暂不支持提示词优化，请更新电脑端后重试。',
    }
  }
  if (status === 404 && /^Session not found/i.test(rawMessage)) {
    return { code, message: '当前会话不存在，请返回后重试。' }
  }
  return {
    code,
    message: rawMessage || '优化提示词失败，请重试。',
  }
}

/**
 * A single composer's prompt optimization lifecycle; no in-flight request or
 * restore snapshot survives a session switch, blur, or user edit.
 */
export function createPromptOptimize<TClient = unknown>(deps: Dependencies<TClient>) {
  let state = initialPromptOptimizeState()
  let active: Run<TClient> | undefined
  let snapshotKey: string | undefined
  let snapshotSeq = 0

  const change = (patch: Partial<PromptOptimizeState>) => {
    const next: PromptOptimizeState = { ...state, ...patch }
    if (
      next.phase === state.phase &&
      next.restoreSnapshot === state.restoreSnapshot &&
      next.notice === state.notice &&
      next.issue === state.issue
    ) {
      return
    }
    state = next
    deps.changed(state)
  }

  const cancel = () => {
    const run = active
    if (!run) return
    active = undefined
    run.abort.abort()
    change({ phase: 'idle' })
    void deps.cancel(run.client, run.sessionId, run.requestId).catch(() => {})
  }

  return {
    state: () => state,
    async optimize() {
      const draft = deps.read()
      if (
        !draft.client ||
        !draft.sessionId ||
        draft.blocked ||
        active ||
        !isOptimizablePrompt(draft.text)
      ) {
        return
      }
      if (draft.text.trim().length > PROMPT_OPTIMIZE_MAX_CHARS) {
        snapshotKey = undefined
        change({
          restoreSnapshot: null,
          notice: null,
          issue: promptOptimizeIssue({ code: 'PROMPT_TOO_LONG' }),
        })
        return
      }
      const run: Run<TClient> = {
        key: draft.key,
        client: draft.client,
        sessionId: draft.sessionId,
        requestId: deps.newRequestId(),
        baselineText: draft.text,
        abort: new AbortController(),
      }
      active = run
      snapshotKey = undefined
      change({
        phase: 'optimizing',
        restoreSnapshot: null,
        notice: null,
        issue: null,
      })

      try {
        const response = await deps.optimize(
          run.client,
          run.sessionId,
          { requestId: run.requestId, prompt: run.baselineText },
          run.abort.signal,
        )
        if (active !== run || run.abort.signal.aborted) return
        const latest = deps.read()
        if (
          latest.key !== run.key ||
          latest.client !== run.client ||
          latest.blocked ||
          latest.text !== run.baselineText
        ) {
          return
        }

        const optimizedText =
          typeof response?.optimizedPrompt === 'string'
            ? response.optimizedPrompt.trim()
            : ''
        if (!optimizedText) {
          change({
            phase: 'idle',
            issue: { code: 'INVALID_RESPONSE', message: '未收到有效的优化结果，请重试。' },
          })
          return
        }

        if (optimizedText === run.baselineText.trim()) {
          change({ phase: 'idle', notice: '当前提示词已足够清晰' })
          return
        }

        active = undefined
        snapshotKey = run.key
        deps.write(optimizedText)
        change({
          phase: 'idle',
          restoreSnapshot: { id: ++snapshotSeq, text: run.baselineText },
          notice: null,
          issue: null,
        })
        deps.focus()
      } catch (error) {
        if (active !== run || run.abort.signal.aborted || isPromptOptimizeAbortError(error)) {
          return
        }
        active = undefined
        change({ phase: 'idle', issue: promptOptimizeIssue(error) })
      } finally {
        if (active === run) {
          active = undefined
          change({ phase: 'idle' })
        }
      }
    },
    cancel,
    restore() {
      const snapshot = state.restoreSnapshot
      if (!snapshot) return
      const draft = deps.read()
      if (snapshotKey !== draft.key || draft.blocked) return
      snapshotKey = undefined
      change({ restoreSnapshot: null, notice: null, issue: null })
      deps.write(snapshot.text)
      deps.focus()
    },
    edited() {
      cancel()
      snapshotKey = undefined
      change({ restoreSnapshot: null, notice: null, issue: null })
    },
    dismissRestore() {
      snapshotKey = undefined
      change({ restoreSnapshot: null })
    },
    dismissNotice() {
      change({ notice: null })
    },
    dismissIssue() {
      change({ issue: null })
    },
    abandon() {
      cancel()
      snapshotKey = undefined
      change({ restoreSnapshot: null, notice: null, issue: null })
    },
  }
}

export type PromptOptimizeController<TClient = unknown> = ReturnType<
  typeof createPromptOptimize<TClient>
>
