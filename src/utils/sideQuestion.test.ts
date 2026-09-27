import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import type { Message } from '../types/message.js'
import type { ForkedAgentParams, CacheSafeParams } from './forkedAgent.js'

describe('side questions with a restored per-test fork spy', async () => {
  let captured: ForkedAgentParams
  let output: any[] = []
  let waitForAbort = false
  const realFork = await import('./forkedAgent.js')
  let forkSpy: ReturnType<typeof spyOn>
  beforeEach(() => {
    output = []
    waitForAbort = false
    forkSpy = spyOn(realFork, 'runForkedAgent').mockImplementation(async (params: ForkedAgentParams) => {
    captured = params
    if (waitForAbort) await new Promise((_resolve, reject) => params.overrides!.abortController!.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))
    for (const message of output) params.onMessage?.(message)
    return { messages: output, totalUsage: {} } as never
    })
  })
  afterEach(() => forkSpy.mockRestore())
  const { runSideQuestion, prepareSideQuestionContext } = await import('./sideQuestion.js')
  const { createUserMessage, createAssistantMessage } = await import('./messages.js')
  const parent = new AbortController()
  const cache = { forkContextMessages: [], systemPrompt: ['shared'], userContext: {}, systemContext: {},
    toolUseContext: { abortController: parent } } as unknown as CacheSafeParams

  test('tool pairing and incomplete groups are fork-only, keeping completed current context', () => {
    const user = createUserMessage({ content: 'latest user question' })
    const tool = createAssistantMessage({ content: [{ type: 'tool_use', id: 'pending', name: 'Read', input: {} }] })
    tool.message.stop_reason = 'tool_use'
    const incomplete = createAssistantMessage({ content: 'partial' })
    incomplete.message.stop_reason = null
    const messages = [user, tool, incomplete, { type: 'system', subtype: 'local_command', content: 'progress marker' } as unknown as Message]
    const before = JSON.stringify(messages)
    const result = prepareSideQuestionContext(messages)
    expect(JSON.stringify(result)).toContain('latest user question')
    expect(JSON.stringify(result)).not.toContain('partial')
    expect(result.at(-1)).toMatchObject({ type: 'user', message: { content: expect.arrayContaining([expect.objectContaining({ type: 'tool_result', tool_use_id: 'pending', is_error: true })]) } })
    expect(JSON.stringify(messages)).toBe(before)
    const completed = createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'pending', content: 'real result' }] })
    expect(prepareSideQuestionContext([user, tool, completed])).toHaveLength(3)
  })
  test('uses most recent 20 history pairs, independent cancellation, one turn and no transcript', async () => {
    output = [createAssistantMessage({ content: 'answer' })]
    const controller = new AbortController()
    parent.abort()
    const history = Array.from({ length: 23 }, (_, index) => ({ question: `question-${index}`, response: `answer-${index}` }))
    const result = await runSideQuestion({ question: 'current', cacheSafeParams: cache, history, signal: controller.signal })
    expect(result.response).toBe('answer')
    expect(captured.promptMessages).toHaveLength(41)
    expect(JSON.stringify(captured.promptMessages[0])).toContain('question-3')
    expect(captured.maxTurns).toBe(1)
    expect(captured.skipTranscript).toBe(true)
    expect(captured.overrides?.requireCanUseTool).toBe(true)
    expect(captured.skipCacheWrite).toBe(true)
    expect(captured.overrides?.abortController?.signal.aborted).toBe(false)
    expect(await captured.canUseTool({} as never, {} as never, {} as never, {} as never, 'fixture')).toMatchObject({ behavior: 'deny' })
    expect(captured.cacheSafeParams.systemPrompt).toBe(cache.systemPrompt)
  })
  test('active cancellation aborts only the fork', async () => {
    const main = new AbortController()
    const side = new AbortController()
    waitForAbort = true
    try {
      const result = runSideQuestion({ question: 'current', cacheSafeParams: { ...cache, toolUseContext: { ...cache.toolUseContext, abortController: main } }, signal: side.signal })
      const outcome = result.then(() => null, error => error)
      await new Promise(resolve => setTimeout(resolve, 0))
      side.abort()
      expect((await outcome)?.message).toBe('cancelled')
      expect(main.signal.aborted).toBe(false)
      expect(captured.overrides?.abortController?.signal.aborted).toBe(true)
    } finally { waitForAbort = false }
  })
  test('pre-aborted side question fails without touching the parent', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(runSideQuestion({ question: 'current', cacheSafeParams: cache, signal: controller.signal })).rejects.toThrow()
  })
  test('successful text after a transient retry error remains a valid answer', async () => {
    output = [{ type: 'system', subtype: 'api_error', error: new Error('retrying') }, createAssistantMessage({ content: 'recovered answer' })]
    expect((await runSideQuestion({ question: 'current', cacheSafeParams: cache })).response).toBe('recovered answer')
  })
  test('API-error assistant text fails instead of becoming an answer', async () => {
    output = [{ ...createAssistantMessage({ content: 'API Error: fixture' }), isApiErrorMessage: true }]
    await expect(runSideQuestion({ question: 'current', cacheSafeParams: cache })).rejects.toThrow('API Error: fixture')
  })
  test('a terminal API error preserves its cause instead of becoming an empty-answer error', async () => {
    output = [{ type: 'system', subtype: 'api_error', error: new Error('fixture unavailable') }]
    await expect(runSideQuestion({ question: 'current', cacheSafeParams: cache })).rejects.toThrow('fixture unavailable')
  })
  test('thinking-only output is not mistaken for a user-facing answer', async () => {
    output = [createAssistantMessage({ content: [{ type: 'thinking', thinking: 'internal', signature: 'fixture' }] })]
    await expect(runSideQuestion({ question: 'current', cacheSafeParams: cache })).rejects.toThrow('No response')
  })
  test('empty and tool-only responses fail explicitly', async () => {
    output = []
    await expect(runSideQuestion({ question: 'current', cacheSafeParams: cache })).rejects.toThrow('No response')
    output = [createAssistantMessage({ content: [{ type: 'tool_use', id: 'forbidden', name: 'Write', input: {} }] })]
    await expect(runSideQuestion({ question: 'current', cacheSafeParams: cache })).rejects.toThrow('Write')
  })
})
