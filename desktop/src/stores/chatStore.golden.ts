import type { ServerMessage } from '../types/chat'

/**
 * Golden scenarios for `useChatStore.handleServerMessage`.
 *
 * `chatStore.ts` is 4858 lines with an 87% fix rate — the highest in the repository.
 * Its 191 existing tests are hand-picked examples, so most transitions have no
 * assertion pinning the resulting session state. Splitting the file safely needs a
 * snapshot of the whole rendered slice for realistic frame sequences.
 *
 * Two properties of the store make a naive snapshot unstable, and the harness deals
 * with both rather than changing production code:
 *   - `nextId()` is `msg-${++msgCounter}-${Date.now()}`, so ids carry a process-wide
 *     counter and a wall clock. The harness normalizes them per scenario, which
 *     still fails if message count or order changes.
 *   - Text and tool-input deltas are batched behind a 50ms `setTimeout`. The harness
 *     drives fake timers so the flush is deterministic instead of racy.
 */

export type ChatStoreGoldenScenario = {
  id: string
  description: string
  messages: ServerMessage[]
  /**
   * Set only for pure state transitions that are *supposed* to render nothing in the
   * transcript. Declaring it keeps the vacuity guard meaningful for every other
   * scenario.
   */
  expectsNoRenderedMessages?: boolean
}

const TOOL_USE_ID = 'toolu_golden_store'

export const chatStoreGoldenScenarios: ChatStoreGoldenScenario[] = [
  {
    id: 'text-turn',
    description: 'A streamed assistant text turn lands as one assistant_text message.',
    messages: [
      { type: 'status', state: 'streaming' },
      { type: 'content_start', blockType: 'text' },
      { type: 'content_delta', text: 'Hello' },
      { type: 'content_delta', text: ' world' },
      { type: 'message_complete', usage: { input_tokens: 10, output_tokens: 4 } },
    ],
  },
  {
    id: 'thinking-then-text',
    description: 'Thinking content is kept separate from the visible answer.',
    messages: [
      { type: 'thinking', text: 'Considering options' },
      { type: 'content_start', blockType: 'text' },
      { type: 'content_delta', text: 'Answer.' },
      { type: 'message_complete', usage: { input_tokens: 1, output_tokens: 1 } },
    ],
  },
  {
    id: 'tool-call-success',
    description: 'A tool call renders as a tool card and its result attaches to that card.',
    messages: [
      { type: 'content_start', blockType: 'tool_use', toolName: 'Write', toolUseId: TOOL_USE_ID },
      { type: 'content_delta', toolInput: '{"file_path":"/tmp/a.txt"}' },
      {
        type: 'tool_use_complete',
        toolName: 'Write',
        toolUseId: TOOL_USE_ID,
        input: { file_path: '/tmp/a.txt' },
      },
      { type: 'tool_result', toolUseId: TOOL_USE_ID, content: 'wrote 1 line', isError: false },
      { type: 'message_complete', usage: { input_tokens: 5, output_tokens: 2 } },
    ],
  },
  {
    id: 'tool-call-error',
    description: 'A failed tool result must stay marked as an error on its card.',
    messages: [
      {
        type: 'tool_use_complete',
        toolName: 'Bash',
        toolUseId: TOOL_USE_ID,
        input: { command: 'exit 1' },
      },
      { type: 'tool_result', toolUseId: TOOL_USE_ID, content: 'exit code 1', isError: true },
      { type: 'message_complete', usage: { input_tokens: 1, output_tokens: 1 } },
    ],
  },
  {
    id: 'permission-allow-flow',
    description: 'A permission request becomes pending and clears once the server resolves it.',
    messages: [
      {
        type: 'permission_request',
        requestId: 'req_golden_store',
        toolName: 'Write',
        toolUseId: TOOL_USE_ID,
        input: { file_path: '/tmp/b.txt' },
        description: 'write a file',
      },
      { type: 'permission_resolved', requestId: 'req_golden_store', permissionType: 'tool', allowed: true },
      { type: 'tool_result', toolUseId: TOOL_USE_ID, content: 'ok', isError: false },
      { type: 'message_complete', usage: { input_tokens: 1, output_tokens: 1 } },
    ],
  },
  {
    id: 'permission-deny-flow',
    description: 'A denied permission clears the pending state and leaves an error result.',
    messages: [
      {
        type: 'permission_request',
        requestId: 'req_golden_deny',
        toolName: 'Write',
        toolUseId: TOOL_USE_ID,
        input: { file_path: '/tmp/c.txt' },
      },
      { type: 'permission_resolved', requestId: 'req_golden_deny', permissionType: 'tool', allowed: false },
      { type: 'tool_result', toolUseId: TOOL_USE_ID, content: 'User denied', isError: true },
    ],
  },
  {
    id: 'subagent-scoped-tool',
    description: 'A nested tool call keeps its parent scope so it renders under the subagent card.',
    messages: [
      {
        type: 'tool_use_complete',
        toolName: 'Task',
        toolUseId: 'toolu_parent_agent',
        input: { prompt: 'do work' },
      },
      // Real streaming always opens the block first. Going straight to
      // tool_use_complete skipped the content_start branch entirely, which is where
      // the parent scope is first attached to the card.
      {
        type: 'content_start',
        blockType: 'tool_use',
        toolName: 'Read',
        toolUseId: 'toolu_parent_agent/toolu_child',
        originalToolUseId: 'toolu_child',
        parentToolUseId: 'toolu_parent_agent',
      },
      { type: 'content_delta', toolInput: '{"file_path":"/tmp/d.txt"}' },
      {
        type: 'tool_use_complete',
        toolName: 'Read',
        toolUseId: 'toolu_parent_agent/toolu_child',
        originalToolUseId: 'toolu_child',
        input: { file_path: '/tmp/d.txt' },
        parentToolUseId: 'toolu_parent_agent',
      },
      {
        type: 'tool_result',
        toolUseId: 'toolu_parent_agent/toolu_child',
        originalToolUseId: 'toolu_child',
        content: 'file body',
        isError: false,
        parentToolUseId: 'toolu_parent_agent',
      },
    ],
  },
  {
    id: 'api-error-then-recovery',
    description: 'An API error is rendered and the next turn still streams normally.',
    messages: [
      { type: 'error', message: 'Prompt is too long', code: 'API_ERROR' },
      { type: 'content_start', blockType: 'text' },
      { type: 'content_delta', text: 'Recovered.' },
      { type: 'message_complete', usage: { input_tokens: 1, output_tokens: 1 } },
    ],
  },
  {
    id: 'retry-and-fallback',
    description: 'Retry and streaming-fallback banners are turn state, cleared together.',
    messages: [
      { type: 'api_retry', attempt: 2, maxRetries: 5, retryDelayMs: 1000, errorStatus: 529, errorType: 'overloaded_error' },
      { type: 'streaming_fallback', cause: 'watchdog' },
      { type: 'content_start', blockType: 'text' },
      { type: 'content_delta', text: 'After fallback.' },
      { type: 'message_complete', usage: { input_tokens: 1, output_tokens: 1 } },
    ],
  },
  {
    id: 'permission-mode-and-session-state',
    description: 'Server-driven permission mode and turn state corrections change state without writing transcript entries.',
    expectsNoRenderedMessages: true,
    messages: [
      { type: 'permission_mode_changed', mode: 'acceptEdits' },
      { type: 'session_state', turnState: 'running' },
      { type: 'status', state: 'tool_executing', verb: 'Running' },
      { type: 'session_state', turnState: 'idle' },
    ],
  },
  {
    id: 'reconnect-replay',
    description: 'A replayed user message after reconnect must not duplicate the transcript.',
    messages: [
      { type: 'user_message_replay', content: 'first ask' },
      { type: 'user_message_replay', content: 'first ask' },
      { type: 'content_start', blockType: 'text' },
      { type: 'content_delta', text: 'reply' },
      { type: 'message_complete', usage: { input_tokens: 1, output_tokens: 1 } },
    ],
  },
]
