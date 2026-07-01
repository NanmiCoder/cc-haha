import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { APIError } from '@anthropic-ai/sdk'
import { withStreamRetry } from './streamRetry.js'
import { RetriableStreamError } from './withRetry.js'

const RETRY_ENV = 'CLAUDE_STREAM_TRANSIENT_RETRY_MAX'

// getAssistantMessageFromError() (invoked when retries are exhausted) consults
// isClaudeAISubscriber(), which throws if no auth is configured. We only assert
// that an assistant error message is produced, so a dummy key suffices. In
// production this path always runs with real auth already in place.
let priorApiKey: string | undefined
beforeAll(() => {
  priorApiKey = process.env.ANTHROPIC_API_KEY
  process.env.ANTHROPIC_API_KEY ??= 'sk-ant-test'
})
afterAll(() => {
  if (priorApiKey === undefined) {
    delete process.env.ANTHROPIC_API_KEY
  }
})

/** A RetriableStreamError wrapping a realistic mid-stream api_error (no status). */
function retriableError(): RetriableStreamError {
  const body = {
    type: 'error',
    error: {
      type: 'api_error',
      message: 'Failed to generate a valid tool call.',
    },
  }
  return new RetriableStreamError(
    new APIError(undefined, body, JSON.stringify(body), undefined),
  )
}

// biome-ignore lint/suspicious/noExplicitAny: test harness collects heterogeneous stream messages
async function collect(gen: AsyncGenerator<any, void>): Promise<any[]> {
  // biome-ignore lint/suspicious/noExplicitAny: see above
  const out: any[] = []
  for await (const m of gen) out.push(m)
  return out
}

describe('withStreamRetry', () => {
  test('retries after a transient mid-stream error and yields the successful attempt', async () => {
    process.env[RETRY_ENV] = '2'
    let calls = 0
    const attempt = () =>
      // biome-ignore lint/suspicious/noExplicitAny: mock stream messages
      (async function* (): AsyncGenerator<any, void> {
        calls++
        if (calls === 1) {
          // A failed attempt may have already emitted partials before throwing.
          yield { type: 'stream_event', event: { type: 'message_start' } }
          throw retriableError()
        }
        yield { type: 'assistant', message: { content: [] }, uuid: 'ok' }
      })()

    const out = await collect(withStreamRetry(attempt, 'test-model', []))

    expect(calls).toBe(2)
    const assistants = out.filter(m => m.type === 'assistant')
    expect(assistants).toHaveLength(1)
    expect(assistants[0].uuid).toBe('ok')
    // The successful retry must NOT be reported as an API error.
    expect(out.some(m => m.isApiErrorMessage)).toBe(false)
    delete process.env[RETRY_ENV]
  })

  test('exhausts retries and surfaces an API-error assistant message', async () => {
    process.env[RETRY_ENV] = '2'
    let calls = 0
    const attempt = () =>
      // biome-ignore lint/suspicious/noExplicitAny: mock stream messages
      (async function* (): AsyncGenerator<any, void> {
        calls++
        throw retriableError()
      })()

    const out = await collect(withStreamRetry(attempt, 'test-model', []))

    expect(calls).toBe(3) // 1 initial attempt + 2 retries
    const last = out.at(-1)
    expect(last?.type).toBe('assistant')
    expect(last?.isApiErrorMessage).toBe(true)
    // User-visible error message must be yielded EXACTLY ONCE — no matter
    // how many retries fired in the middle. Per user requirement: "重试可以
    // 但是只显示一次报错消息出就行". Without this assertion, a future
    // refactor that yields per-attempt error messages could regress the UI
    // to show a stack of red error chips.
    const errorMessages = out.filter(
      (m) => m.type === 'assistant' && m.isApiErrorMessage === true,
    )
    expect(errorMessages).toHaveLength(1)
    delete process.env[RETRY_ENV]
  })

  test('retry attempts do not leak any error messages mid-stream (transparent retry)', async () => {
    // attempt 1 throws RetriableStreamError, attempt 2 succeeds. The user
    // must see ZERO error messages — the retry should be invisible.
    process.env[RETRY_ENV] = '2'
    let calls = 0
    const attempt = () =>
      // biome-ignore lint/suspicious/noExplicitAny: mock stream messages
      (async function* (): AsyncGenerator<any, void> {
        calls++
        if (calls === 1) {
          throw retriableError()
        }
        yield { type: 'assistant', message: { content: [] }, uuid: 'recovered' }
      })()

    const out = await collect(withStreamRetry(attempt, 'test-model', []))

    expect(calls).toBe(2)
    expect(
      out.some(
        (m) => m.type === 'assistant' && m.isApiErrorMessage === true,
      ),
    ).toBe(false)
    delete process.env[RETRY_ENV]
  })

  test('does not retry a non-RetriableStreamError; rethrows it', async () => {
    let calls = 0
    const attempt = () =>
      // biome-ignore lint/suspicious/noExplicitAny: mock stream messages
      (async function* (): AsyncGenerator<any, void> {
        calls++
        throw new Error('fatal')
      })()

    await expect(
      collect(withStreamRetry(attempt, 'test-model', [])),
    ).rejects.toThrow('fatal')
    expect(calls).toBe(1)
  })

  test('maxRetries=0 makes a single attempt, then surfaces the error', async () => {
    process.env[RETRY_ENV] = '0'
    let calls = 0
    const attempt = () =>
      // biome-ignore lint/suspicious/noExplicitAny: mock stream messages
      (async function* (): AsyncGenerator<any, void> {
        calls++
        throw retriableError()
      })()

    const out = await collect(withStreamRetry(attempt, 'test-model', []))

    expect(calls).toBe(1)
    expect(out.at(-1)?.type).toBe('assistant')
    expect(out.at(-1)?.isApiErrorMessage).toBe(true)
    delete process.env[RETRY_ENV]
  })

  test('passes through a clean attempt without retrying', async () => {
    let calls = 0
    const attempt = () =>
      // biome-ignore lint/suspicious/noExplicitAny: mock stream messages
      (async function* (): AsyncGenerator<any, void> {
        calls++
        yield { type: 'assistant', message: { content: [] }, uuid: 'clean' }
      })()

    const out = await collect(withStreamRetry(attempt, 'test-model', []))

    expect(calls).toBe(1)
    expect(out).toHaveLength(1)
    expect(out[0].uuid).toBe('clean')
  })
})
