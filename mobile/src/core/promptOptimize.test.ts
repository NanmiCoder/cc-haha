import { describe, expect, test } from 'bun:test'
import { ApiClient, ApiError } from './client'
import {
  createPromptOptimize,
  isOptimizablePrompt,
  isPromptOptimizeAbortError,
  PROMPT_OPTIMIZE_MAX_CHARS,
  promptOptimizeIssue,
  type PromptOptimizeState,
} from './promptOptimize'
import {
  cancelOptimizePrompt,
  optimizePrompt,
  PROMPT_OPTIMIZE_TIMEOUT_MS,
} from './promptOptimizeApi'
import type { Host } from './types'

const host: Host = {
  id: 'host-1',
  name: 'Mac Studio',
  url: 'http://192.168.1.10:3456',
  auth: 'lan',
}

describe('isOptimizablePrompt', () => {
  test('allows non-empty regular prompts and rejects blank or slash commands', () => {
    expect(isOptimizablePrompt('')).toBe(false)
    expect(isOptimizablePrompt('   \n\t  ')).toBe(false)
    expect(isOptimizablePrompt('/compact')).toBe(false)
    expect(isOptimizablePrompt('  /review src/index.ts')).toBe(false)
    expect(isOptimizablePrompt('帮我梳理一下登录接口的重试逻辑')).toBe(true)
    expect(isOptimizablePrompt('refactor login flow')).toBe(true)
  })
})

describe('promptOptimizeApi', () => {
  test('POSTs optimize-prompt with 120s timeout and caches support so subsequent DELETE skips probe', async () => {
    const calls: { url: string; method: string; body?: string }[] = []
    const client = new ApiClient(host, 'lan-token', {
      fetch: async (input, init) => {
        calls.push({
          url: input,
          method: init.method,
          body: typeof init.body === 'string' ? init.body : undefined,
        })
        if (init.method === 'POST') {
          return {
            ok: true,
            status: 200,
            url: input,
            redirected: false,
            text: async () =>
              JSON.stringify({
                requestId: 'req-1',
                optimizedPrompt: 'Optimized prompt text',
              }),
          }
        }
        return {
          ok: true,
          status: 200,
          url: input,
          redirected: false,
          text: async () =>
            JSON.stringify({
              requestId: 'req-1',
              cancelled: true,
            }),
        }
      },
    })

    const result = await optimizePrompt(client, 'sess/1', {
      requestId: 'req-1',
      prompt: 'fix auth',
    })
    expect(result).toEqual({
      requestId: 'req-1',
      optimizedPrompt: 'Optimized prompt text',
    })
    expect(calls[0]).toEqual({
      url: 'http://192.168.1.10:3456/api/sessions/sess%2F1/optimize-prompt',
      method: 'POST',
      body: JSON.stringify({ requestId: 'req-1', prompt: 'fix auth' }),
    })

    const cancelled = await cancelOptimizePrompt(client, 'sess/1', 'req-1')
    expect(cancelled).toEqual({ requestId: 'req-1', cancelled: true })
    expect(calls).toHaveLength(2)
    expect(calls[1]).toEqual({
      url: 'http://192.168.1.10:3456/api/sessions/sess%2F1/optimize-prompt/req-1',
      method: 'DELETE',
      body: undefined,
    })
    expect(PROMPT_OPTIMIZE_TIMEOUT_MS).toBe(120_000)
  })

  test('never sends DELETE to a pre-v0.8.0 desktop server whose GET probe falls through to getSession', async () => {
    const calls: { url: string; method: string }[] = []
    const legacyClient = new ApiClient(host, 'lan-token', {
      fetch: async (input, init) => {
        calls.push({ url: input, method: init.method })
        if (init.method === 'GET') {
          // Pre-v0.8.0 handleSessionsApi falls through to GET /api/sessions/:id
          return {
            ok: true,
            status: 200,
            url: input,
            redirected: false,
            text: async () => JSON.stringify({ id: 'sess-legacy', title: 'Old chat' }),
          }
        }
        throw new Error(`Unexpected ${init.method} on legacy server`)
      },
    })

    expect(await cancelOptimizePrompt(legacyClient, 'sess-legacy', 'req-1')).toEqual({
      requestId: 'req-1',
      cancelled: false,
    })
    expect(await cancelOptimizePrompt(legacyClient, 'sess-legacy', 'req-2')).toEqual({
      requestId: 'req-2',
      cancelled: false,
    })
    // Probed once via safe GET; cached as unsupported; DELETE never sent.
    expect(calls).toEqual([
      { url: 'http://192.168.1.10:3456/api/sessions/sess-legacy/optimize-prompt', method: 'GET' },
    ])
  })

  test('probes v0.8.0+ server via GET 405 signature before first DELETE and caches support', async () => {
    const calls: { url: string; method: string }[] = []
    const modernClient = new ApiClient(host, 'lan-token', {
      fetch: async (input, init) => {
        calls.push({ url: input, method: init.method })
        if (init.method === 'GET') {
          return {
            ok: false,
            status: 405,
            url: input,
            redirected: false,
            text: async () =>
              JSON.stringify({
                error: 'METHOD_NOT_ALLOWED',
                message: 'Unsupported prompt optimization route',
              }),
          }
        }
        return {
          ok: true,
          status: 200,
          url: input,
          redirected: false,
          text: async () => JSON.stringify({ requestId: 'req-1', cancelled: true }),
        }
      },
    })

    expect(await cancelOptimizePrompt(modernClient, 's1', 'req-1')).toEqual({
      requestId: 'req-1',
      cancelled: true,
    })
    expect(await cancelOptimizePrompt(modernClient, 's1', 'req-2')).toEqual({
      requestId: 'req-1',
      cancelled: true,
    })
    expect(calls).toEqual([
      { url: 'http://192.168.1.10:3456/api/sessions/s1/optimize-prompt', method: 'GET' },
      { url: 'http://192.168.1.10:3456/api/sessions/s1/optimize-prompt/req-1', method: 'DELETE' },
      { url: 'http://192.168.1.10:3456/api/sessions/s1/optimize-prompt/req-2', method: 'DELETE' },
    ])
  })
})

describe('promptOptimizeIssue & abort detection', () => {
  test('recognizes abort and 499 cancellation errors', () => {
    expect(isPromptOptimizeAbortError(new ApiError('请求已取消', 0, 'ABORTED'))).toBe(true)
    expect(isPromptOptimizeAbortError(new ApiError('cancelled', 499, 'PROMPT_OPTIMIZE_CANCELLED'))).toBe(true)
    expect(isPromptOptimizeAbortError({ name: 'AbortError' })).toBe(true)
    expect(isPromptOptimizeAbortError(new ApiError('boom', 502, 'PROMPT_OPTIMIZE_FAILED'))).toBe(false)
  })

  test('maps timeout, network, conflict, oversize, and legacy desktop errors to clear copy', () => {
    expect(promptOptimizeIssue(new ApiError('timeout', 504, 'PROMPT_OPTIMIZE_TIMEOUT')).message).toContain('超时')
    expect(promptOptimizeIssue(new ApiError('timeout', 0, 'TIMEOUT')).message).toContain('超时')
    expect(promptOptimizeIssue(new ApiError('offline', 0, 'NETWORK_ERROR')).message).toContain('无法连接电脑')
    expect(promptOptimizeIssue(new ApiError('busy', 409, 'CONFLICT')).message).toContain('正在优化')
    expect(promptOptimizeIssue(new ApiError('too large', 413, 'BODY_TOO_LARGE')).message).toContain('过长')
    expect(promptOptimizeIssue({ code: 'PROMPT_TOO_LONG' }).message).toContain('过长')
    expect(promptOptimizeIssue(new ApiError('Not Found', 404, 'NOT_FOUND')).message).toContain('暂不支持提示词优化')
    expect(promptOptimizeIssue(new ApiError('Session not found: s1', 404, 'NOT_FOUND')).message).toContain('会话不存在')
    expect(promptOptimizeIssue(new Error('Provider unavailable')).message).toBe('Provider unavailable')
  })
})

describe('createPromptOptimize', () => {
  type FakeClient = { id: string }

  function setup(
    initial?: Partial<{
      key: string
      client: FakeClient | null
      sessionId: string | null
      text: string
      blocked: boolean
    }>,
  ) {
    const draft = {
      key: 'host-1:s1',
      client: { id: 'client-1' } as FakeClient | null,
      sessionId: 's1' as string | null,
      text: '修一下登录超时',
      blocked: false,
      ...initial,
    }
    const states: PromptOptimizeState[] = []
    const cancelled: { client: FakeClient; sessionId: string; requestId: string }[] = []
    let focuses = 0
    let seq = 0
    let optimizeImpl: (
      client: FakeClient,
      sessionId: string,
      body: { requestId: string; prompt: string },
      signal: AbortSignal,
    ) => Promise<{ requestId: string; optimizedPrompt: string }> = async (_client, _sid, body) => ({
      requestId: body.requestId,
      optimizedPrompt: '请排查登录请求超时问题，定位阻塞原因并补充回归测试。',
    })

    const controller = createPromptOptimize<FakeClient>({
      read: () => ({ ...draft }),
      write: (text) => {
        draft.text = text
      },
      focus: () => {
        focuses++
      },
      changed: (next) => {
        states.push(next)
      },
      newRequestId: () => `00000000-0000-4000-8000-00000000000${++seq}`,
      optimize: (client, sessionId, body, signal) => optimizeImpl(client, sessionId, body, signal),
      cancel: async (client, sessionId, requestId) => {
        cancelled.push({ client, sessionId, requestId })
        return { requestId, cancelled: true }
      },
    })

    return {
      draft,
      states,
      cancelled,
      getFocuses: () => focuses,
      setOptimize: (fn: typeof optimizeImpl) => {
        optimizeImpl = fn
      },
      controller,
    }
  }

  test('optimizes draft, exposes restore snapshot, and restores exact original text', async () => {
    const { draft, controller, getFocuses } = setup()

    await controller.optimize()
    expect(draft.text).toBe('请排查登录请求超时问题，定位阻塞原因并补充回归测试。')
    expect(controller.state().phase).toBe('idle')
    expect(controller.state().restoreSnapshot).toEqual({
      id: 1,
      text: '修一下登录超时',
    })
    expect(getFocuses()).toBe(1)

    controller.restore()
    expect(draft.text).toBe('修一下登录超时')
    expect(controller.state().restoreSnapshot).toBeNull()
    expect(getFocuses()).toBe(2)
  })

  test('shows unchanged notice when optimized prompt equals trimmed original', async () => {
    const { draft, controller, setOptimize } = setup({ text: '  整理单元测试  ' })
    setOptimize(async (_client, _sid, body) => ({
      requestId: body.requestId,
      optimizedPrompt: '整理单元测试',
    }))

    await controller.optimize()
    expect(draft.text).toBe('  整理单元测试  ')
    expect(controller.state().restoreSnapshot).toBeNull()
    expect(controller.state().notice).toBe('当前提示词已足够清晰')
  })

  test('cancels in-flight optimization via abort and server DELETE on originating client', async () => {
    const { draft, controller, cancelled, setOptimize } = setup()
    const originalClient = draft.client!
    let signalRef: AbortSignal | undefined
    setOptimize((_client, _sid, _body, signal) => {
      signalRef = signal
      return new Promise(() => {})
    })

    const pending = controller.optimize()
    expect(controller.state().phase).toBe('optimizing')

    // Even if client changes before cancel fires, cancel targets the originating client.
    draft.client = { id: 'client-2' }
    controller.cancel()
    expect(signalRef?.aborted).toBe(true)
    expect(controller.state().phase).toBe('idle')
    expect(cancelled).toEqual([
      {
        client: originalClient,
        sessionId: 's1',
        requestId: '00000000-0000-4000-8000-000000000001',
      },
    ])
    expect(draft.text).toBe('修一下登录超时')
    expect(controller.state().issue).toBeNull()
    void pending
  })

  test('editing draft while optimizing cancels and ignores late responses', async () => {
    const { draft, controller, cancelled, setOptimize } = setup({ text: '初版草稿' })
    let resolveOptimize!: (value: { requestId: string; optimizedPrompt: string }) => void
    setOptimize(
      () =>
        new Promise((resolve) => {
          resolveOptimize = resolve
        }),
    )

    const pending = controller.optimize()
    expect(controller.state().phase).toBe('optimizing')

    draft.text = '初版草稿，再补充一句'
    controller.edited()
    expect(controller.state().phase).toBe('idle')
    expect(cancelled).toHaveLength(1)

    resolveOptimize({
      requestId: '00000000-0000-4000-8000-000000000001',
      optimizedPrompt: '过期的优化结果',
    })
    await pending
    expect(draft.text).toBe('初版草稿，再补充一句')
    expect(controller.state().restoreSnapshot).toBeNull()
  })

  test('switching sessions abandons in-flight optimization and never overwrites the new chat', async () => {
    const { draft, controller, cancelled, setOptimize } = setup({
      key: 'host-1:s1',
      sessionId: 's1',
      text: '会话一的草稿',
    })
    let resolveOptimize!: (value: { requestId: string; optimizedPrompt: string }) => void
    setOptimize(
      () =>
        new Promise((resolve) => {
          resolveOptimize = resolve
        }),
    )

    const pending = controller.optimize()
    draft.key = 'host-1:s2'
    draft.sessionId = 's2'
    draft.text = '会话二的草稿'
    controller.abandon()

    resolveOptimize({
      requestId: '00000000-0000-4000-8000-000000000001',
      optimizedPrompt: '会话一优化结果',
    })
    await pending
    expect(cancelled).toHaveLength(1)
    expect(draft.text).toBe('会话二的草稿')
    expect(controller.state().restoreSnapshot).toBeNull()
  })

  test('preserves original draft and surfaces inline issue on failure, empty response, or oversized prompt', async () => {
    let calls = 0
    const { draft, controller, setOptimize } = setup({ text: '保留原文' })
    setOptimize(async () => {
      calls++
      throw new ApiError('Provider unavailable', 502, 'PROMPT_OPTIMIZE_FAILED')
    })

    await controller.optimize()
    expect(calls).toBe(1)
    expect(draft.text).toBe('保留原文')
    expect(controller.state().phase).toBe('idle')
    expect(controller.state().issue).toEqual({
      code: 'PROMPT_OPTIMIZE_FAILED',
      message: 'Provider unavailable',
    })

    controller.dismissIssue()
    expect(controller.state().issue).toBeNull()

    setOptimize(async (_client, _sid, body) => {
      calls++
      return { requestId: body.requestId, optimizedPrompt: '   ' }
    })
    await controller.optimize()
    expect(calls).toBe(2)
    expect(draft.text).toBe('保留原文')
    expect(controller.state().issue?.code).toBe('INVALID_RESPONSE')

    draft.text = 'a'.repeat(PROMPT_OPTIMIZE_MAX_CHARS + 1)
    await controller.optimize()
    expect(calls).toBe(2)
    expect(controller.state().issue?.code).toBe('PROMPT_TOO_LONG')
    expect(controller.state().issue?.message).toContain('过长')
  })

  test('ignores optimize requests when blocked, missing client/sessionId, or drafting a slash command', async () => {
    let calls = 0
    const { draft, controller, setOptimize } = setup({ sessionId: null, text: '普通文本' })
    setOptimize(async (_client, _sid, body) => {
      calls++
      return { requestId: body.requestId, optimizedPrompt: 'ok' }
    })

    await controller.optimize()
    draft.sessionId = 's1'
    draft.client = null
    await controller.optimize()
    draft.client = { id: 'client-1' }
    draft.text = '/compact'
    await controller.optimize()
    draft.text = '普通文本'
    draft.blocked = true
    await controller.optimize()
    expect(calls).toBe(0)
  })
})
