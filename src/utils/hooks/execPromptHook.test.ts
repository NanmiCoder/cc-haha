import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import {
  getIsInteractive,
  getSessionId,
  setIsInteractive,
} from '../../bootstrap/state.js'
import type { ToolUseContext } from '../../Tool.js'
import type { PromptHook } from '../settings/types.js'
import { addSessionHook } from './sessionHooks.js'

const queryModelWithoutStreamingMock = mock(async (_params?: { signal?: AbortSignal }) => ({
  isApiErrorMessage: false as boolean | undefined,
  apiError: undefined as string | undefined,
  error: undefined as string | undefined,
  message: {
    content: [{ type: 'text', text: 'not json' }],
  },
}))

const claudeApi = await import('../../services/api/claude.js')

mock.module('../../services/api/claude.js', () => ({
  ...claudeApi,
  queryModelWithoutStreaming: queryModelWithoutStreamingMock,
}))

const { execPromptHook } = await import('./execPromptHook.js')
const { executeStopHooks } = await import('../hooks.js')

function makeContext(appStateOverride?: Record<string, unknown>): ToolUseContext {
  let responseLength = 0
  let state: Record<string, unknown> = {
    toolPermissionContext: { mode: 'default' },
    sessionHooks: new Map(),
    ...appStateOverride,
  }
  return {
    abortController: new AbortController(),
    agentId: undefined,
    getAppState: () => state,
    setAppState: (updater: (prev: Record<string, unknown>) => Record<string, unknown>) => {
      state = updater(state)
    },
    options: {
      tools: [],
    },
    setResponseLength: updater => {
      responseLength = updater(responseLength)
    },
  } as unknown as ToolUseContext
}

function stallUntilAborted({ signal }: { signal?: AbortSignal } = {}) {
  return new Promise<never>((_resolve, reject) => {
    const onAbort = () => reject(new Error('Request was aborted.'))
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

const goalHook = {
  type: 'prompt',
  prompt: [
    '<cc-haha-goal-hook>',
    '<goal-objective>',
    'ship the goal',
    '</goal-objective>',
  ].join('\n'),
  timeout: 1,
} satisfies PromptHook

const ordinaryHook = {
  type: 'prompt',
  prompt: 'ordinary prompt hook',
  timeout: 1,
} satisfies PromptHook

describe('execPromptHook goal failures', () => {
  beforeEach(() => {
    queryModelWithoutStreamingMock.mockClear()
    queryModelWithoutStreamingMock.mockImplementation(async () => ({
      message: {
        content: [{ type: 'text', text: 'not json' }],
      },
    }))
  })

  test('reports invalid /goal evaluator JSON as a non-blocking error instead of looping', async () => {
    const result = await execPromptHook(
      goalHook,
      'Stop',
      'Stop',
      '{}',
      new AbortController().signal,
      makeContext(),
    )

    expect(result.outcome).toBe('non_blocking_error')
    expect(result.preventContinuation).toBeUndefined()
    expect(result.blockingError).toBeUndefined()
    expect(result.message?.attachment.type).toBe('hook_non_blocking_error')
    if (result.message?.attachment.type === 'hook_non_blocking_error') {
      expect(result.message.attachment.stderr).toContain('response was not valid JSON')
      expect(result.message.attachment.stdout).toBe('not json')
    }
  })

  test('preserves upstream API errors without swallowing them as invalid JSON or blocking continuation', async () => {
    const upstreamError =
      'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"reasoning effort \\"disabled\\" is not supported"}}'
    queryModelWithoutStreamingMock.mockImplementation(async () => ({
      isApiErrorMessage: true,
      error: 'unknown',
      message: {
        content: [{ type: 'text', text: upstreamError }],
      },
    }))

    const result = await execPromptHook(
      goalHook,
      'Stop',
      'Stop',
      '{}',
      new AbortController().signal,
      makeContext(),
    )

    expect(result.outcome).toBe('non_blocking_error')
    expect(result.preventContinuation).toBeUndefined()
    expect(result.blockingError).toBeUndefined()
    expect(result.message?.attachment.type).toBe('hook_non_blocking_error')
    if (result.message?.attachment.type === 'hook_non_blocking_error') {
      expect(result.message.attachment.stderr).toContain('Goal evaluator API error:')
      expect(result.message.attachment.stderr).toContain('reasoning effort')
      expect(result.message.attachment.stderr).not.toContain('not valid JSON')
    }
  })

  test('keeps ordinary prompt hook invalid JSON as a non-blocking hook error', async () => {
    const result = await execPromptHook(
      ordinaryHook,
      'Stop',
      'Stop',
      '{}',
      new AbortController().signal,
      makeContext(),
    )

    expect(result.outcome).toBe('non_blocking_error')
    expect(result.preventContinuation).toBeUndefined()
    expect(result.blockingError).toBeUndefined()
    expect(result.message?.attachment.type).toBe('hook_non_blocking_error')
  })

  test('reports /goal evaluator schema failures as a non-blocking error instead of looping', async () => {
    queryModelWithoutStreamingMock.mockImplementation(async () => ({
      message: {
        content: [{ type: 'text', text: '{"ok":"not boolean"}' }],
      },
    }))

    const result = await execPromptHook(
      goalHook,
      'Stop',
      'Stop',
      '{}',
      new AbortController().signal,
      makeContext(),
    )

    expect(result.outcome).toBe('non_blocking_error')
    expect(result.preventContinuation).toBeUndefined()
    expect(result.blockingError).toBeUndefined()
    expect(result.message?.attachment.type).toBe('hook_non_blocking_error')
    if (result.message?.attachment.type === 'hook_non_blocking_error') {
      expect(result.message.attachment.stderr).toContain('expected schema')
    }
  })

  test('reports /goal evaluator timeout as a non-blocking error when parent signal is omitted', async () => {
    queryModelWithoutStreamingMock.mockImplementation(stallUntilAborted)
    const fastGoalHook: PromptHook = { ...goalHook, timeout: 0.05 }

    const result = await execPromptHook(
      fastGoalHook,
      'Stop',
      'Stop',
      '{}',
      undefined,
      makeContext(),
    )

    expect(result.outcome).toBe('non_blocking_error')
    expect(result.preventContinuation).toBeUndefined()
    expect(result.blockingError).toBeUndefined()
    expect(result.message?.attachment.type).toBe('hook_non_blocking_error')
    if (result.message?.attachment.type === 'hook_non_blocking_error') {
      expect(result.message.attachment.stderr).toContain('evaluation timed out')
    }
  })
})

describe('executeStopHooks explicit prompt hook timeout', () => {
  let prevInteractive = false

  beforeEach(() => {
    prevInteractive = getIsInteractive()
    setIsInteractive(false)
    queryModelWithoutStreamingMock.mockClear()
    queryModelWithoutStreamingMock.mockImplementation(stallUntilAborted)
  })

  afterEach(() => {
    setIsInteractive(prevInteractive)
  })

  test('reports evaluation timed out for /goal hook with explicit timeout instead of silently cancelling or looping', async () => {
    const context = makeContext()
    const fastGoalHook: PromptHook = { ...goalHook, timeout: 0.05 }
    addSessionHook(context.setAppState, getSessionId(), 'Stop', '', fastGoalHook)

    const results = []
    for await (const result of executeStopHooks(
      'default',
      context.abortController.signal,
      undefined,
      false,
      undefined,
      context,
      [],
    )) {
      results.push(result)
    }

    expect(results.some(result => result.blockingError)).toBe(false)
    expect(results.some(result => result.preventContinuation)).toBe(false)
    const timeoutError = results.find(
      result =>
        result.message?.type === 'attachment' &&
        result.message.attachment.type === 'hook_non_blocking_error',
    )
    expect(timeoutError).toBeDefined()
    if (
      timeoutError?.message?.type === 'attachment' &&
      timeoutError.message.attachment.type === 'hook_non_blocking_error'
    ) {
      expect(timeoutError.message.attachment.command).toContain('<cc-haha-goal-hook>')
      expect(timeoutError.message.attachment.stderr).toContain('evaluation timed out')
    }
  })

  test('keeps user abort as cancelled without turning it into a timeout continuation', async () => {
    const context = makeContext()
    const slowGoalHook: PromptHook = { ...goalHook, timeout: 5 }
    addSessionHook(context.setAppState, getSessionId(), 'Stop', '', slowGoalHook)

    const abortTimer = setTimeout(() => context.abortController.abort(), 30)
    const results = []
    try {
      for await (const result of executeStopHooks(
        'default',
        context.abortController.signal,
        undefined,
        false,
        undefined,
        context,
        [],
      )) {
        results.push(result)
      }
    } finally {
      clearTimeout(abortTimer)
    }

    expect(results.some(result => result.blockingError)).toBe(false)
    expect(results.some(result => result.preventContinuation)).toBe(false)
  })
})
