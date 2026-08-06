/**
 * Golden scenarios for `translateCliMessage`.
 *
 * `src/server/ws/handler.ts` is 4984 lines with an 86% fix rate, and
 * `translateCliMessage` is the 612-line reducer at its core: every CLI frame the
 * desktop, H5, and IM adapters ever render passes through it. Its existing tests are
 * hand-picked examples, so most of its 8 top-level types and 16 `system` subtypes
 * have no assertion pinning their output shape at all. Splitting the file safely
 * needs the opposite of examples: a snapshot of the *whole* observable output for
 * realistic frame sequences, so a refactor that changes anything says so.
 *
 * The reducer looks pure but is not — it reads per-session stream state,
 * `sessionSlashCommands`, `sessionStopRequested`, and `agentStopRequestedSessions`.
 * Every one of those is keyed by session id, so giving each scenario its own id is
 * enough to isolate it without touching production code.
 */

export type GoldenScenario = {
  id: string
  description: string
  /** CLI frames in arrival order; state accumulates across them. */
  messages: Array<Record<string, unknown>>
  /**
   * Set only when the reducer is *supposed* to forward nothing. Declaring it keeps
   * the vacuity guard meaningful: every other scenario must emit, so a change that
   * silently stopped forwarding frames cannot regenerate into a passing golden.
   */
  expectsNoClientOutput?: boolean
}

const TEXT_BLOCK_START = {
  type: 'stream_event',
  event: {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  },
}

export const goldenScenarios: GoldenScenario[] = [
  {
    id: 'text-stream',
    description: 'A plain streamed text turn from message_start through result.',
    messages: [
      { type: 'stream_event', event: { type: 'message_start' } },
      TEXT_BLOCK_START,
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' world' } } },
      { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
      { type: 'stream_event', event: { type: 'message_stop' } },
      { type: 'result', subtype: 'success', is_error: false, result: 'Hello world', usage: { input_tokens: 10, output_tokens: 4 } },
    ],
  },
  {
    id: 'thinking-then-text',
    description: 'Extended thinking deltas followed by visible text in the same block.',
    messages: [
      { type: 'stream_event', event: { type: 'message_start' } },
      {
        type: 'stream_event',
        event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      },
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Considering options' } } },
      { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
      TEXT_BLOCK_START,
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done thinking.' } } },
      { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
    ],
  },
  {
    id: 'whole-thinking-blocks',
    description: 'A non-streamed assistant message carrying two finished thinking blocks.',
    // The streaming case above covers thinking_delta. This is the other emit site,
    // where the CLI hands over an already-finished block — the client has to tell the
    // two apart to know whether to concatenate or separate them, so `complete` must
    // survive translation. Nothing pinned this path before, and dropping the flag left
    // every check green.
    messages: [
      {
        type: 'assistant',
        message: {
          id: 'msg_whole_thinking',
          content: [
            { type: 'thinking', thinking: 'plan the fix carefully' },
            { type: 'thinking', thinking: 'then run tests' },
            { type: 'text', text: 'Starting now.' },
          ],
        },
      },
    ],
  },
  {
    id: 'tool-use-lifecycle',
    description: 'Streamed tool_use block, accumulated input JSON, then the tool_result frame.',
    messages: [
      { type: 'stream_event', event: { type: 'message_start' } },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_golden_1', name: 'Write', input: {} },
        },
      },
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path":' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"/tmp/a.txt"}' } } },
      { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_golden_1', content: 'wrote 1 line', is_error: false }],
        },
      },
      { type: 'result', subtype: 'success', is_error: false, result: 'ok', usage: { input_tokens: 5, output_tokens: 2 } },
    ],
  },
  {
    id: 'tool-use-error-result',
    description: 'An approved tool that fails must reach the client as an error tool_result.',
    messages: [
      {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_golden_err', name: 'Bash', input: {} },
        },
      },
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"exit 1"}' } } },
      { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_golden_err', content: 'exit code 1', is_error: true }],
        },
      },
    ],
  },
  {
    id: 'subagent-scoped-tool',
    description: 'The same tool lifecycle nested under parent_tool_use_id must stay scoped to the subagent.',
    messages: [
      {
        type: 'stream_event',
        parent_tool_use_id: 'toolu_parent_agent',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_child', name: 'Read', input: {} },
        },
      },
      {
        type: 'stream_event',
        parent_tool_use_id: 'toolu_parent_agent',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path":"/tmp/b.txt"}' } },
      },
      {
        type: 'stream_event',
        parent_tool_use_id: 'toolu_parent_agent',
        event: { type: 'content_block_stop', index: 0 },
      },
      {
        type: 'user',
        parent_tool_use_id: 'toolu_parent_agent',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_child', content: 'file body', is_error: false }],
        },
      },
    ],
  },
  {
    id: 'buffered-assistant',
    description: 'A non-streamed assistant frame carrying both text and tool_use content blocks.',
    messages: [
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          id: 'msg_golden_buffered',
          model: 'golden-model',
          content: [
            { type: 'text', text: 'Running a tool.' },
            { type: 'tool_use', id: 'toolu_buffered', name: 'Glob', input: { pattern: '*.ts' } },
          ],
        },
      },
    ],
  },
  {
    id: 'api-error',
    description: 'A provider API error frame must surface as an error, not as assistant text.',
    messages: [
      {
        type: 'assistant',
        error: 'invalid_request',
        isApiErrorMessage: true,
        message: { role: 'assistant', content: [{ type: 'text', text: 'Prompt is too long' }] },
      },
      { type: 'result', subtype: 'success', is_error: true, result: 'Prompt is too long', usage: { input_tokens: 0, output_tokens: 0 } },
    ],
  },
  {
    id: 'permission-request',
    description: 'can_use_tool becomes a permission_request; the matching cancel resolves it.',
    messages: [
      {
        type: 'control_request',
        request_id: 'req_golden_1',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Write',
          tool_use_id: 'toolu_golden_perm',
          input: { file_path: '/tmp/c.txt' },
          description: 'write a file',
        },
      },
      { type: 'control_cancel_request', request_id: 'req_golden_1' },
    ],
  },
  {
    id: 'system-init-and-slash',
    description: 'Session init advertises slash commands; local command output renders separately.',
    messages: [
      {
        type: 'system',
        subtype: 'init',
        model: 'golden-model',
        slash_commands: [{ name: 'help', description: 'Show help' }],
      },
      { type: 'system', subtype: 'local_command', command: '/cost' },
      { type: 'system', subtype: 'local_command_output', content: 'Total cost: $0.0000' },
    ],
  },
  {
    id: 'system-status-and-fallback',
    description: 'Permission mode changes and streaming fallbacks are client-visible state.',
    messages: [
      { type: 'system', subtype: 'status', status: null, permissionMode: 'acceptEdits' },
      { type: 'system', subtype: 'streaming_fallback', cause: 'watchdog' },
      // Field names are snake_case and all three are mandatory: toApiRetryServerMessage
      // returns null unless attempt, max_retries, and retry_delay_ms all parse.
      { type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 5, retry_delay_ms: 1000, error_status: 529, error: 'overloaded_error' },
    ],
  },
  {
    id: 'compact-boundary',
    description: 'Auto-compact boundaries must be visible so the transcript is not silently truncated.',
    messages: [
      { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 120000 } },
      { type: 'result', subtype: 'success', is_error: false, result: 'compacted', usage: { input_tokens: 1, output_tokens: 1 } },
    ],
  },
  {
    id: 'agent-tool-activity',
    description: 'Subagent tool activity arrives as a system frame rather than a stream event.',
    messages: [
      {
        type: 'system',
        subtype: 'agent_tool_activity',
        parent_tool_use_id: 'toolu_parent_agent',
        activity: { kind: 'tool_use', tool_name: 'Grep', tool_use_id: 'toolu_activity', input: { pattern: 'foo' } },
      },
      {
        type: 'system',
        subtype: 'agent_tool_activity',
        parent_tool_use_id: 'toolu_parent_agent',
        activity: { kind: 'tool_result', tool_use_id: 'toolu_activity', content: '3 matches', is_error: false },
      },
    ],
  },
  {
    id: 'task-lifecycle',
    description: 'Background task frames drive the task cards the desktop and adapters both render.',
    messages: [
      { type: 'system', subtype: 'task_started', task_id: 'task_golden', description: 'build the thing' },
      { type: 'system', subtype: 'task_progress', task_id: 'task_golden', progress: 'halfway' },
      { type: 'system', subtype: 'task_notification', task_id: 'task_golden', message: 'done' },
    ],
  },
  {
    id: 'hook-frames',
    description: 'Hook frames are deliberately not forwarded; forwarding them would leak internals into chat.',
    expectsNoClientOutput: true,
    messages: [
      { type: 'system', subtype: 'hook_started', hook_name: 'PreToolUse' },
      { type: 'system', subtype: 'hook_response', hook_name: 'PreToolUse', decision: 'allow' },
    ],
  },
]
