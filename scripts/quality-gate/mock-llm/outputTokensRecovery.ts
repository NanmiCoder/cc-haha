import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { OPENAI_CODEX_STREAM_MARKER_HEADER } from '../../../src/services/openaiAuth/streamPolicy'
import { createQualityGateSandbox } from '../sandbox'

const STEP_TIMEOUT_MS = 60_000
const PROMPT = 'OUTPUT_RECOVERY_FIXTURE: finish the deterministic response.'
const DONE = 'OUTPUT_RECOVERY_COMPLETE'
const stalledCodexToolEnv = {
  CLAUDE_ENABLE_STREAM_WATCHDOG: '1',
  CLAUDE_STREAM_TOOL_INPUT_MAX_DURATION_MS: '350',
  CLAUDE_STREAM_MAX_DURATION_MS: '10000',
  CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '1',
  CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8000',
}

type MessagesRequest = {
  model: string
  max_tokens: number
  stream?: boolean
  messages: Array<{ role: string; content: unknown }>
  tools?: Array<{ name: string }>
}

type InterruptedTool = 'max_tokens' | 'stall' | 'empty_input_stall'

type RecoveryCase = {
  id: string
  model: string
  limit: number
  expectedBudgets: number[]
  cleanReplay: boolean
  mode?: 'enabled' | 'disabled'
  env?: Record<string, string>
  interruptedTool?: InterruptedTool
  fallback?: 'stream-404' | 'stream-error'
  expectedStreamBudgets?: number[]
}

const cases: RecoveryCase[] = [
  {
    id: 'nonstream-after-stream-404', model: 'claude-opus-4-1-20250805', limit: 32_000,
    expectedBudgets: [8_000, 32_000], cleanReplay: true, fallback: 'stream-404',
  },
  {
    id: 'nonstream-after-stream-error', model: 'claude-opus-4-1-20250805', limit: 32_000,
    expectedBudgets: [8_000, 32_000], cleanReplay: true, fallback: 'stream-error',
  },
  {
    id: 'nonstream-explicit-budget', model: 'fixture-provider-model', limit: 96_000,
    // The pre-existing non-streaming ceiling is 64K. This is continuation
    // after that actual JSON budget, rather than escalation of a default cap.
    expectedBudgets: [64_000, 64_000], expectedStreamBudgets: [96_000, 96_000],
    cleanReplay: false, fallback: 'stream-404', env: { CLAUDE_CODE_PROVIDER_MAX_OUTPUT_TOKENS: '96000' },
  },
  {
    id: 'bounded-escalation-and-continuation', model: 'claude-opus-4-1-20250805', limit: 32_000,
    expectedBudgets: [8_000, 32_000, 32_000, 32_000, 32_000], cleanReplay: true,
  },
  {
    id: 'native-limit-continuation', model: 'claude-3-opus-20240229', limit: 4_096,
    expectedBudgets: [4_096, 4_096], cleanReplay: false,
  },
  {
    id: 'truncated-tool-clean-replay', model: 'claude-opus-4-1-20250805', limit: 32_000,
    expectedBudgets: [8_000, 32_000, 8_000], cleanReplay: true, interruptedTool: 'max_tokens',
  },
  {
    id: 'stalled-codex-tool-input-replay', model: 'gpt-6.1-terra', limit: 32_000,
    expectedBudgets: [8_000, 8_000, 8_000], cleanReplay: true, interruptedTool: 'stall',
    env: stalledCodexToolEnv,
  },
  {
    id: 'empty-codex-tool-input-stall', model: 'gpt-6.1-terra', limit: 32_000,
    expectedBudgets: [8_000], cleanReplay: false, interruptedTool: 'empty_input_stall',
    env: stalledCodexToolEnv,
  },
  {
    id: 'explicit-global-budget', model: 'claude-opus-4-1-20250805', limit: 32_000,
    expectedBudgets: [12_000, 12_000], cleanReplay: false,
    env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '12000' },
  },
  {
    id: 'explicit-provider-budget', model: 'fixture-provider-model', limit: 96_000,
    expectedBudgets: [96_000, 96_000], cleanReplay: false,
    env: { CLAUDE_CODE_PROVIDER_MAX_OUTPUT_TOKENS: '96000' },
  },
  {
    id: 'disabled-continuation', model: 'claude-opus-4-1-20250805', limit: 32_000,
    expectedBudgets: [32_000, 32_000], cleanReplay: false, mode: 'disabled',
  },
]

function sse(type: string, value: unknown) {
  return `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`
}

function responseFor(request: MessagesRequest, text: string, truncated: boolean) {
  const message = {
    id: 'msg_output_recovery_fixture', type: 'message', role: 'assistant', model: request.model,
    content: [{ type: 'text', text }], stop_reason: truncated ? 'max_tokens' : 'end_turn', stop_sequence: null,
    usage: { input_tokens: 12, output_tokens: truncated ? request.max_tokens : 8, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  }
  if (!request.stream) return Response.json(message)
  return new Response([
    sse('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { ...message.usage, output_tokens: 0 } } }),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: message.usage.output_tokens } }),
    sse('message_stop', { type: 'message_stop' }),
  ].join(''), { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } })
}

function toolResponseFor(request: MessagesRequest, filePath: string, outcome: InterruptedTool | 'complete') {
  const discarded = outcome !== 'complete'
  const start = [
    sse('message_start', { type: 'message_start', message: {
      id: 'msg_output_recovery_tool', type: 'message', role: 'assistant', model: request.model,
      content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 12, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    } }),
    sse('content_block_start', { type: 'content_block_start', index: 0,
      content_block: { type: 'tool_use', id: discarded ? 'discarded_fixture_write' : 'completed_fixture_write', name: 'Write', input: {} } }),
  ].join('')
  const toolDelta = (partial_json: string) => sse('content_block_delta', { type: 'content_block_delta', index: 0,
    delta: { type: 'input_json_delta', partial_json } })
  const headers = { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }
  if (outcome === 'stall' || outcome === 'empty_input_stall') {
    const partial = toolDelta(JSON.stringify({ file_path: filePath }).slice(0, -1) + ',"content":"')
    let progressTimer: ReturnType<typeof setTimeout> | undefined
    return new Response(new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder()
        if (outcome === 'empty_input_stall') {
          const emptyTool = sse('content_block_start', { type: 'content_block_start', index: 1,
            content_block: { type: 'tool_use', id: 'empty_fixture_write', name: 'Write', input: {} } })
          controller.enqueue(encoder.encode(start + emptyTool))
          // Refresh block 0's watchdog so block 1, which has no JSON, expires first.
          progressTimer = setTimeout(() => controller.enqueue(encoder.encode(partial)), 100)
        } else {
          controller.enqueue(encoder.encode(start + partial + toolDelta('x').repeat(6_199)))
        }
      },
      cancel() { clearTimeout(progressTimer) },
    }), { headers: { ...headers, [OPENAI_CODEX_STREAM_MARKER_HEADER]: '1' } })
  }
  const truncated = outcome === 'max_tokens'
  const input = JSON.stringify({ file_path: filePath,
    content: truncated ? 'UNCOMMITTED_TRUNCATED_CONTENT'.repeat(512) : 'OUTPUT_RECOVERY_VALID_WRITE' })
  return new Response([
    start,
    toolDelta(truncated ? input.slice(0, -4) : input),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: truncated ? 'max_tokens' : 'tool_use', stop_sequence: null },
      usage: { output_tokens: truncated ? request.max_tokens : 8 } }),
    sse('message_stop', { type: 'message_stop' }),
  ].join(''), { headers })
}

/** Real CLI request construction and recovery, with only the loopback model scripted. */
export async function runOutputTokensRecoveryScenario(rootDir: string, artifactDir: string) {
  mkdirSync(artifactDir, { recursive: true })
  const evidence: Array<Record<string, unknown>> = []
  for (const testCase of cases) {
    const expectsToolTimeout = testCase.interruptedTool === 'empty_input_stall'
    const sandbox = createQualityGateSandbox({
      label: `output-recovery-${testCase.id}`, seedProviders: false,
      sourceConfigDir: join(artifactDir, 'unused-user-config'),
      source: { PATH: process.env.PATH, SHELL: process.env.SHELL, SYSTEMROOT: process.env.SYSTEMROOT },
    })
    const workDir = join(sandbox.home, 'project')
    mkdirSync(workDir, { recursive: true })
    writeFileSync(join(sandbox.configDir, 'settings.json'), JSON.stringify({
      maxOutputTokensEscalationMode: testCase.mode ?? 'enabled', alwaysThinkingEnabled: false,
    }))
    const requests: MessagesRequest[] = []
    const attempts: Array<{ streaming: boolean; budget: number }> = []
    const outputFile = join(workDir, 'recovered-write.txt')
    let incompleteWriteExecuted = false
    const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      const path = new URL(request.url).pathname
      if (request.method === 'HEAD') return new Response(null, { status: 204 })
      if (request.method === 'POST' && path.endsWith('/v1/messages/count_tokens')) return Response.json({ input_tokens: 12 })
      if (request.method !== 'POST' || !path.endsWith('/v1/messages')) return new Response('not found', { status: 404 })
      const body = await request.json() as MessagesRequest
      if (!body.tools?.some(tool => tool.name === 'Read')) return responseFor(body, 'Mock auxiliary reply', false)
      attempts.push({ streaming: body.stream === true, budget: body.max_tokens })
      if (testCase.fallback && body.stream) {
        if (testCase.fallback === 'stream-404') return new Response('streaming unavailable', { status: 404 })
        // A malformed event exercises the mid-stream catch rather than the
        // stream-creation 404 catch. No assistant output has been committed.
        return new Response(sse('content_block_stop', { type: 'content_block_stop', index: 99 }),
          { headers: { 'content-type': 'text/event-stream' } })
      }
      requests.push(body)
      if (body.max_tokens > testCase.limit) {
        return Response.json({ type: 'error', error: { type: 'invalid_request_error',
          message: `max_tokens must be at most ${testCase.limit}; received ${body.max_tokens}` } }, { status: 400 })
      }
      if (testCase.interruptedTool && requests.length < 3) {
        if (requests.length === 2) incompleteWriteExecuted = existsSync(outputFile)
        return toolResponseFor(body, outputFile, requests.length === 1 ? testCase.interruptedTool : 'complete')
      }
      const truncated = requests.length < testCase.expectedBudgets.length
      return responseFor(body, truncated ? `OUTPUT_RECOVERY_PARTIAL_${requests.length}` : DONE, truncated)
    } })
    let child: ReturnType<typeof Bun.spawn> | undefined
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let stdout = ''
    let stderr = ''
    try {
      child = Bun.spawn([
        process.execPath, '--no-env-file', '--feature=TRANSCRIPT_CLASSIFIER', '--preload', join(rootDir, 'preload.ts'),
        join(rootDir, 'src/entrypoints/cli.tsx'), '--print', '--model', testCase.model,
        '--permission-mode', 'bypassPermissions', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', PROMPT,
      ], {
        cwd: workDir, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
        env: {
          ...sandbox.env, ...testCase.env, CALLER_DIR: workDir, CC_HAHA_SKIP_DOTENV: '1',
          ANTHROPIC_BASE_URL: upstream.url.origin, ANTHROPIC_API_KEY: 'mock-output-recovery-key', CI: '1',
          // Keep the legacy model whose 32K/4K boundary this scenario verifies.
          CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP: '1',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
          DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
        },
      })
      timer = setTimeout(() => { timedOut = true; child?.kill('SIGKILL') }, STEP_TIMEOUT_MS)
      const [exitCode, output, errors] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ])
      stdout = output
      stderr = errors
      assert.equal(timedOut, false, `${testCase.id}: CLI exceeded ${STEP_TIMEOUT_MS}ms`)
      assert.ok(requests.every(request => request.model === testCase.model), `${testCase.id}: CLI remapped the fixture model`)
      assert.deepEqual(requests.map(request => request.max_tokens), testCase.expectedBudgets,
        `${testCase.id}: output budgets changed or recovery exceeded its request limit`)
      if (testCase.fallback) {
        assert.ok(requests.every(request => request.stream !== true), `${testCase.id}: expected JSON responses after streaming failed`)
        assert.deepEqual(attempts, testCase.expectedBudgets.flatMap((budget, index) => [
          { streaming: true, budget: testCase.expectedStreamBudgets?.[index] ?? budget }, { streaming: false, budget },
        ]), `${testCase.id}: the JSON fallback did not preserve the actual output budget`)
      }
      assert.equal(exitCode, expectsToolTimeout ? 1 : 0, `${testCase.id}: unexpected CLI exit: ${stderr}\n${stdout}`)
      const result = stdout.split('\n').flatMap(line => {
        try { const message = JSON.parse(line); return message.type === 'result' ? [message] : [] } catch { return [] }
      })
      assert.equal(result.length, 1, `${testCase.id}: expected one terminal result`)
      assert.equal(result[0].is_error, expectsToolTimeout, `${testCase.id}: unexpected CLI result state`)
      if (expectsToolTimeout) {
        assert.match(result[0].result ?? result[0].errors?.join('\n') ?? '', /Tool input generation exceeded/)
        assert.ok(!existsSync(outputFile), 'a tool executed despite the incomplete response')
      } else {
        assert.ok(result[0].result.includes(DONE), `${testCase.id}: CLI did not finish recovery`)
      }
      if (testCase.cleanReplay) {
        assert.deepEqual(requests[1]!.messages, requests[0]!.messages, `${testCase.id}: replay appended the truncated response`)
      }
      if (testCase.interruptedTool && !expectsToolTimeout) {
        assert.equal(incompleteWriteExecuted, false, 'incomplete tool input executed before its clean replay')
        assert.equal(readFileSync(outputFile, 'utf8'), 'OUTPUT_RECOVERY_VALID_WRITE', 'the completed retry did not execute the real Write tool')
        const lastHistory = JSON.stringify(requests[2]!.messages)
        assert.ok(!lastHistory.includes('discarded_fixture_write'), 'discarded tool call entered the next request')
        const toolResults = requests[2]!.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
        const writes = toolResults.filter(block => block.type === 'tool_result' && block.tool_use_id === 'completed_fixture_write')
        assert.equal(writes.length, 1, 'the completed Write result must return to the model once')
        assert.ok(!writes[0]!.is_error, 'the completed Write returned an error')
      }
      const continuationStart = testCase.cleanReplay ? 2 : 1
      for (let index = continuationStart; !testCase.interruptedTool && index < requests.length; index++) {
        const history = JSON.stringify(requests[index]!.messages)
        assert.ok(history.includes(`OUTPUT_RECOVERY_PARTIAL_${index}`), `${testCase.id}: continuation lost the previous response`)
        assert.ok(history.includes('Output token limit hit. Resume directly'), `${testCase.id}: missing continuation instruction`)
        if (testCase.cleanReplay) assert.ok(!history.includes('OUTPUT_RECOVERY_PARTIAL_1'), `${testCase.id}: discarded replay response entered continuation history`)
      }
      evidence.push({ id: testCase.id, status: 'passed', budgets: requests.map(request => request.max_tokens),
        messageCounts: requests.map(request => request.messages.length), cleanReplay: testCase.cleanReplay,
        ...(testCase.fallback ? { attempts } : {}) })
    } catch (error) {
      evidence.push({ id: testCase.id, status: 'failed', budgets: requests.map(request => request.max_tokens),
        ...(testCase.fallback ? { attempts } : {}),
        error: error instanceof Error ? error.message : String(error) })
      throw error
    } finally {
      clearTimeout(timer)
      if (child?.exitCode === null) { child.kill('SIGKILL'); await child.exited }
      await upstream.stop(true)
      writeFileSync(join(artifactDir, `${testCase.id}.log`), `${stdout}\n${stderr}`)
      writeFileSync(join(artifactDir, `${testCase.id}-requests.json`), JSON.stringify(requests.map(request => ({
        budget: request.max_tokens, streaming: request.stream === true, messages: request.messages,
      })), null, 2) + '\n')
      writeFileSync(join(artifactDir, 'results.json'), JSON.stringify(evidence, null, 2) + '\n')
      const mutations = sandbox.detectUserStateMutations()
      sandbox.cleanup()
      assert.deepEqual(mutations, [], 'output recovery scenario mutated user state')
    }
  }
}
