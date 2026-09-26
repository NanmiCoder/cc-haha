import { afterEach, describe, expect, test } from 'bun:test'
import {
  __resetWebSocketHandlerStateForTests,
  translateCliMessage,
} from '../ws/handler.js'

type AgentRunRoute = {
  runAgentId: string
  streamId: string
  targetAgentId: string
  targetAgentScopeId?: string
}

function agentRunMessage(
  route: AgentRunRoute,
  message: unknown,
) {
  return {
    type: 'system',
    subtype: 'agent_run_message',
    run_agent_id: route.runAgentId,
    stream_id: route.streamId,
    target_agent_id: route.targetAgentId,
    ...(route.targetAgentScopeId
      ? { target_agent_scope_id: route.targetAgentScopeId }
      : {}),
    event_kind: 'message',
    message,
  }
}

function terminalAgentRunMessage(
  route: AgentRunRoute,
  eventKind: 'complete' | 'cancelled' | 'error',
  error?: string,
) {
  return {
    type: 'system',
    subtype: 'agent_run_message',
    run_agent_id: route.runAgentId,
    stream_id: route.streamId,
    target_agent_id: route.targetAgentId,
    ...(route.targetAgentScopeId
      ? { target_agent_scope_id: route.targetAgentScopeId }
      : {}),
    event_kind: eventKind,
    ...(error ? { error } : {}),
  }
}

function stream(event: unknown) {
  return { type: 'stream_event', event }
}

afterEach(() => {
  __resetWebSocketHandlerStateForTests()
})

describe('translateCliMessage: agent_run_message', () => {
  test('keeps text, thinking, tool input and tool result inside the targeted scoped run', () => {
    const sessionId = 'agent-run-stream-session'
    const route: AgentRunRoute = {
      runAgentId: 'physical-agent',
      streamId: 'physical-agent-invocation-1',
      targetAgentId: 'logical-agent',
      targetAgentScopeId: '["team-a","lead-session",123]',
    }
    const translated = [
      ...translateCliMessage(agentRunMessage(
        route,
        stream({ type: 'message_start', message: { id: 'message-1', usage: {} } }),
      ), sessionId),
      ...translateCliMessage(agentRunMessage(
        route,
        stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }),
      ), sessionId),
      ...translateCliMessage(agentRunMessage(
        route,
        stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'checking' } }),
      ), sessionId),
      ...translateCliMessage(agentRunMessage(
        route,
        stream({ type: 'content_block_start', index: 1, content_block: { type: 'text' } }),
      ), sessionId),
      ...translateCliMessage(agentRunMessage(
        route,
        stream({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'live answer' } }),
      ), sessionId),
      ...translateCliMessage(agentRunMessage(
        route,
        stream({
          type: 'content_block_start',
          index: 2,
          content_block: { type: 'tool_use', id: 'tool-1', name: 'Read' },
        }),
      ), sessionId),
      ...translateCliMessage(agentRunMessage(
        route,
        stream({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"file_path":"a.ts"}' } }),
      ), sessionId),
      ...translateCliMessage(agentRunMessage(
        route,
        stream({ type: 'content_block_stop', index: 2 }),
      ), sessionId),
      ...translateCliMessage(agentRunMessage(
        route,
        {
          type: 'user',
          message: {
            content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'contents' }],
          },
        },
      ), sessionId),
    ]

    expect(translated).toEqual(expect.arrayContaining([
      { type: 'agent_run_event', ...route, event: expect.objectContaining({ type: 'thinking', text: 'checking' }) },
      { type: 'agent_run_event', ...route, event: { type: 'content_delta', text: 'live answer' } },
      {
        type: 'agent_run_event',
        ...route,
        event: { type: 'content_delta', toolInput: '{"file_path":"a.ts"}' },
      },
      {
        type: 'agent_run_event',
        ...route,
        event: {
          type: 'tool_use_complete',
          toolName: 'Read',
          toolUseId: 'tool-1',
          input: { file_path: 'a.ts' },
          parentToolUseId: undefined,
        },
      },
      {
        type: 'agent_run_event',
        ...route,
        event: {
          type: 'tool_result',
          toolUseId: 'tool-1',
          content: 'contents',
          isError: false,
          parentToolUseId: undefined,
        },
      },
    ]))
    expect(translated.every(message => message.type === 'agent_run_event')).toBe(true)
  })

  test('isolates interleaved tool JSON by invocation stream, even for the same physical agent', () => {
    const sessionId = 'parallel-agent-run-streams'
    const routeFor = (streamId: string): AgentRunRoute => ({
      runAgentId: 'same-physical-agent',
      streamId,
      targetAgentId: 'same-logical-agent',
    })
    const startTool = (route: AgentRunRoute, toolName: string) => translateCliMessage(
      agentRunMessage(route, stream({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'same-id', name: toolName },
      })),
      sessionId,
    )
    const delta = (route: AgentRunRoute, partialJson: string) => translateCliMessage(
      agentRunMessage(route, stream({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: partialJson },
      })),
      sessionId,
    )
    const stop = (route: AgentRunRoute) => translateCliMessage(
      agentRunMessage(route, stream({ type: 'content_block_stop', index: 0 })),
      sessionId,
    )
    const first = routeFor('invocation-a')
    const second = routeFor('invocation-b')

    startTool(first, 'Read')
    startTool(second, 'Write')
    delta(first, '{"a":1}')
    delta(second, '{"b":2}')

    expect(stop(first)).toEqual([expect.objectContaining({
      streamId: first.streamId,
      event: expect.objectContaining({ toolName: 'Read', input: { a: 1 } }),
    })])
    expect(stop(second)).toEqual([expect.objectContaining({
      streamId: second.streamId,
      event: expect.objectContaining({ toolName: 'Write', input: { b: 2 } }),
    })])
  })

  test('wraps retry and fallback status without leaking them into the root conversation', () => {
    const sessionId = 'agent-run-retry-fallback'
    const route: AgentRunRoute = {
      runAgentId: 'retrying-agent',
      streamId: 'retrying-agent-invocation',
      targetAgentId: 'retrying-agent',
    }

    expect(translateCliMessage(agentRunMessage(route, {
      type: 'system',
      subtype: 'api_retry',
      attempt: 2,
      max_retries: 4,
      retry_delay_ms: 750,
      error_status: 529,
      error: 'overloaded_error',
    }), sessionId)).toEqual([{
      type: 'agent_run_event',
      ...route,
      event: {
        type: 'api_retry',
        attempt: 2,
        maxRetries: 4,
        retryDelayMs: 750,
        errorStatus: 529,
        errorType: 'overloaded_error',
      },
    }])

    expect(translateCliMessage(agentRunMessage(route, {
      type: 'system',
      subtype: 'streaming_fallback',
      cause: 'watchdog',
    }), sessionId)).toEqual([{
      type: 'agent_run_event',
      ...route,
      event: { type: 'streaming_fallback', cause: 'watchdog' },
    }])
  })

  test('keeps child stream deduplication state out of the root conversation', () => {
    const sessionId = 'agent-run-root-isolation'
    const route: AgentRunRoute = {
      runAgentId: 'child-agent',
      streamId: 'child-stream',
      targetAgentId: 'child-agent',
    }
    const messageId = 'same-provider-message-id'

    translateCliMessage(agentRunMessage(
      route,
      stream({ type: 'message_start', message: { id: messageId, usage: {} } }),
    ), sessionId)
    translateCliMessage(agentRunMessage(
      route,
      stream({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
    ), sessionId)
    translateCliMessage(agentRunMessage(
      route,
      stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'child text' } }),
    ), sessionId)

    expect(translateCliMessage({
      type: 'assistant',
      message: {
        id: messageId,
        content: [{ type: 'text', text: 'root buffered text' }],
      },
    }, sessionId)).toEqual([
      { type: 'content_start', blockType: 'text' },
      { type: 'content_delta', text: 'root buffered text' },
    ])
  })

  test('settles complete, cancelled and error terminals on the targeted stream only', () => {
    const route: AgentRunRoute = {
      runAgentId: 'physical-agent',
      streamId: 'physical-agent-invocation',
      targetAgentId: 'logical-agent',
      targetAgentScopeId: '["team-a","lead-session",123]',
    }

    expect(translateCliMessage(
      terminalAgentRunMessage(route, 'complete'),
      'agent-run-complete-session',
    )).toEqual([{
      type: 'agent_run_event',
      ...route,
      event: { type: 'status', state: 'idle' },
    }])
    expect(translateCliMessage(
      terminalAgentRunMessage(route, 'cancelled'),
      'agent-run-cancelled-session',
    )).toEqual([
      {
        type: 'agent_run_event',
        ...route,
        event: { type: 'streaming_fallback', cause: 'stream_retry' },
      },
      {
        type: 'agent_run_event',
        ...route,
        event: { type: 'status', state: 'idle' },
      },
    ])
    expect(translateCliMessage(
      terminalAgentRunMessage(route, 'error', 'child failed'),
      'agent-run-error-session',
    )).toEqual([{
      type: 'agent_run_event',
      ...route,
      event: {
        type: 'error',
        message: 'child failed',
        code: 'AGENT_RUN_ERROR',
      },
    }])
  })

  test('drops frames that do not identify an exact run, stream and target', () => {
    const base = {
      type: 'system',
      subtype: 'agent_run_message',
      run_agent_id: 'physical-agent',
      stream_id: 'invocation',
      target_agent_id: 'logical-agent',
      event_kind: 'complete',
    }

    for (const field of ['run_agent_id', 'stream_id', 'target_agent_id'] as const) {
      expect(translateCliMessage({ ...base, [field]: '   ' }, `missing-${field}`)).toEqual([])
    }
  })
})
