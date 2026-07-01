import { beforeEach, describe, expect, mock, test } from 'bun:test'

const compactConversationMock = mock(async () => fakeCompactionResult())

mock.module('./compact.js', () => ({
  compactConversation: compactConversationMock,
  ERROR_MESSAGE_PROMPT_TOO_LONG:
    'Conversation too long. Press esc twice to go up a few messages and try again.',
  ERROR_MESSAGE_USER_ABORT: 'API Error: Request was aborted.',
}))

const reactiveCompact = await import('./reactiveCompact.js')

function fakeAssistantMessage(text: string, isApiErrorMessage = true) {
  return {
    type: 'assistant',
    isApiErrorMessage,
    message: {
      content: [{ type: 'text', text }],
    },
  } as any
}

function fakeUserMessage(content: string) {
  return {
    type: 'user',
    message: { content },
  } as any
}

function fakeCompactBoundary() {
  return {
    type: 'system',
    subtype: 'compact_boundary',
  } as any
}

function fakeCompactionResult() {
  return {
    boundaryMarker: fakeCompactBoundary(),
    summaryMessages: [fakeUserMessage('summary')],
    attachments: [],
    hookResults: [],
  } as any
}

function fakeCacheSafeParams(messages = [fakeUserMessage('hello')]) {
  return {
    systemPrompt: [] as any,
    userContext: {},
    systemContext: {},
    toolUseContext: {
      abortController: new AbortController(),
    } as any,
    forkContextMessages: messages,
  }
}

describe('reactiveCompact prompt-too-long recovery', () => {
  beforeEach(() => {
    compactConversationMock.mockClear()
    compactConversationMock.mockImplementation(async () => fakeCompactionResult())
  })

  test('withholds canonical prompt-too-long API errors', () => {
    expect(
      reactiveCompact.isWithheldPromptTooLong(
        fakeAssistantMessage('Prompt is too long'),
      ),
    ).toBe(true)
    expect(
      reactiveCompact.isWithheldPromptTooLong(
        fakeAssistantMessage('Some other API error'),
      ),
    ).toBe(false)
    expect(
      reactiveCompact.isWithheldPromptTooLong(
        fakeAssistantMessage('Prompt is too long', false),
      ),
    ).toBe(false)
    expect(reactiveCompact.isWithheldPromptTooLong(fakeUserMessage('hi'))).toBe(
      false,
    )
  })

  test('does not withhold media errors in the prompt-too-long recovery shim', () => {
    expect(
      reactiveCompact.isWithheldMediaSizeError(
        fakeAssistantMessage('image exceeds maximum'),
      ),
    ).toBe(false)
  })

  test('does not compact after a previous recovery attempt', async () => {
    const result = await reactiveCompact.tryReactiveCompact({
      hasAttempted: true,
      aborted: false,
      messages: [fakeUserMessage('hello')],
      cacheSafeParams: fakeCacheSafeParams(),
    })

    expect(result).toBeNull()
    expect(compactConversationMock).not.toHaveBeenCalled()
  })

  test('does not compact after abort', async () => {
    const result = await reactiveCompact.tryReactiveCompact({
      hasAttempted: false,
      aborted: true,
      messages: [fakeUserMessage('hello')],
      cacheSafeParams: fakeCacheSafeParams(),
    })

    expect(result).toBeNull()
    expect(compactConversationMock).not.toHaveBeenCalled()
  })

  test('compacts messages after the latest compact boundary and marks it automatic', async () => {
    const beforeBoundary = fakeUserMessage('old')
    const boundary = fakeCompactBoundary()
    const afterBoundary = fakeUserMessage('new')
    const cacheSafeParams = fakeCacheSafeParams([beforeBoundary, boundary, afterBoundary])

    const result = await reactiveCompact.tryReactiveCompact({
      hasAttempted: false,
      aborted: false,
      messages: [beforeBoundary, boundary, afterBoundary],
      cacheSafeParams,
    })

    expect(result).toEqual(fakeCompactionResult())
    expect(compactConversationMock).toHaveBeenCalledTimes(1)
    expect(compactConversationMock.mock.calls[0]?.[0]).toEqual([
      boundary,
      afterBoundary,
    ])
    expect(compactConversationMock.mock.calls[0]?.[2].forkContextMessages).toEqual([
      boundary,
      afterBoundary,
    ])
    expect(compactConversationMock.mock.calls[0]?.[3]).toBe(true)
    expect(compactConversationMock.mock.calls[0]?.[4]).toBeUndefined()
    expect(compactConversationMock.mock.calls[0]?.[5]).toBe(true)
  })

  test('returns null when compaction fails', async () => {
    compactConversationMock.mockImplementation(async () => {
      throw new Error('compact failed')
    })

    const result = await reactiveCompact.tryReactiveCompact({
      hasAttempted: false,
      aborted: false,
      messages: [fakeUserMessage('hello')],
      cacheSafeParams: fakeCacheSafeParams(),
    })

    expect(result).toBeNull()
  })
})
