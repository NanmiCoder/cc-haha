import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createQualityGateSandbox } from '../sandbox'

const MODEL = 'deepseek-flash'
const USED_TOKENS = 816_404
const COMPACT_THRESHOLD = 967_000
const SKILL_NAME = 'context-meter-fixture'
const STEP_TIMEOUT_MS = 45_000

type ContextSnapshot = {
  summaryOnly?: boolean
  totalTokens: number
  rawMaxTokens: number
  percentage: number
  model: string
  autoCompactThreshold: number
  memoryFiles: unknown[]
  mcpTools: unknown[]
  agents: unknown[]
  skills?: { skillFrontmatter: Array<{ name: string }> }
}

function assertHeader(snapshot: ContextSnapshot) {
  assert.equal(snapshot.totalTokens, USED_TOKENS, 'history estimate replaced the current provider total')
  assert.equal(snapshot.rawMaxTokens, 1_000_000)
  assert.equal(snapshot.percentage, 82)
  assert.equal(snapshot.model, MODEL)
  assert.equal(snapshot.autoCompactThreshold, COMPACT_THRESHOLD)
}

/** Real resumed CLI and SDK controls; no model response or product function is mocked. */
export async function runContextUsageScenario(rootDir: string, artifactDir: string) {
  mkdirSync(artifactDir, { recursive: true })
  const sandbox = createQualityGateSandbox({
    label: 'context-summary', seedProviders: false,
    sourceConfigDir: join(artifactDir, 'unused-user-config'),
    source: { PATH: process.env.PATH, SHELL: process.env.SHELL, SYSTEMROOT: process.env.SYSTEMROOT },
  })
  const workDir = join(sandbox.home, 'project')
  const skillDir = join(workDir, '.claude', 'skills', SKILL_NAME)
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), [
    '---', `name: ${SKILL_NAME}`,
    'description: Inert metadata fixture for the context meter; this skill has no commands or external actions.',
    '---', 'CONTEXT_METER_INERT_SKILL_BODY',
  ].join('\n'))

  const sessionId = randomUUID()
  const transcript = join(sandbox.configDir, 'projects', 'context-meter-fixture', `${sessionId}.jsonl`)
  mkdirSync(join(sandbox.configDir, 'projects', 'context-meter-fixture'), { recursive: true })
  const ids = Array.from({ length: 4 }, () => randomUUID())
  const base = { sessionId, cwd: workDir, version: '9.9.9', timestamp: new Date().toISOString(), isSidechain: false, userType: 'external' }
  const rows = [
    { ...base, uuid: ids[0], parentUuid: null, type: 'user', message: { role: 'user', content: 'Persisted fixture conversation.' } },
    {
      ...base, uuid: ids[1], parentUuid: ids[0], type: 'assistant',
      message: {
        id: 'msg_qwen_history', type: 'message', role: 'assistant', model: 'qwen4.0-max-preview',
        content: [{ type: 'text', text: '中'.repeat(987_192) }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 950_000, output_tokens: 1_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    },
    { ...base, uuid: ids[2], parentUuid: ids[1], type: 'user', message: { role: 'user', content: 'Continue with DeepSeek.' } },
    {
      ...base, uuid: ids[3], parentUuid: ids[2], type: 'assistant',
      message: {
        id: 'msg_deepseek_current', type: 'message', role: 'assistant', model: MODEL,
        content: [{ type: 'text', text: 'Continued.' }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 235, output_tokens: 937, cache_read_input_tokens: 815_232, cache_creation_input_tokens: 0 },
      },
    },
  ]
  writeFileSync(transcript, rows.map(row => JSON.stringify(row)).join('\n') + '\n')

  // Any count-token/model/background request fails the scenario. Startup may
  // preconnect with HEAD /; record that separately from actual API requests.
  // The endpoint is loopback, fake credentials only, and no reply is generated.
  const upstreamRequests: Array<{ method: string; path: string }> = []
  const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const path = new URL(request.url).pathname
    upstreamRequests.push({ method: request.method, path })
    if (request.method === 'HEAD' && path === '/') return new Response(null, { status: 204 })
    return Response.json({ error: { type: 'invalid_request_error', message: 'Context inspection must not request a model' } }, { status: 503 })
  } })
  const child = Bun.spawn([
    process.execPath, '--no-env-file', '--feature=TRANSCRIPT_CLASSIFIER', '--preload', join(rootDir, 'preload.ts'),
    join(rootDir, 'src/entrypoints/cli.tsx'), '--print', '--resume', transcript,
    '--model', MODEL, '--permission-mode', 'bypassPermissions',
    '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence',
  ], {
    cwd: workDir, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    env: {
      ...sandbox.env, CALLER_DIR: workDir, CC_HAHA_SKIP_DOTENV: '1',
      ANTHROPIC_BASE_URL: upstream.url.origin, ANTHROPIC_API_KEY: 'context-meter-fake-key',
      ANTHROPIC_MODEL: MODEL, CI: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
    },
  })
  const responses = new Map<string, { subtype: string; response?: ContextSnapshot; error?: string }>()
  let stdout = ''
  let stderr = ''
  const drains = Promise.all([
    (async () => {
      const decoder = new TextDecoder()
      let pending = ''
      for await (const chunk of child.stdout) {
        const text = decoder.decode(chunk, { stream: true })
        stdout += text
        pending += text
        for (;;) {
          const newline = pending.indexOf('\n')
          if (newline < 0) break
          const line = pending.slice(0, newline)
          pending = pending.slice(newline + 1)
          try {
            const message = JSON.parse(line)
            if (message.type === 'control_response') responses.set(message.response.request_id, message.response)
          } catch {}
        }
      }
    })(),
    (async () => { stderr = await new Response(child.stderr).text() })(),
  ])
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, STEP_TIMEOUT_MS)
  const timings: Array<{ kind: string; durationMs: number }> = []
  const request = async (id: string, summaryOnly: boolean) => {
    const started = performance.now()
    child.stdin.write(JSON.stringify({ type: 'control_request', request_id: id, request: {
      subtype: 'get_context_usage', estimateOnly: true, summaryOnly,
    } }) + '\n')
    await child.stdin.flush()
    while (!responses.has(id) && child.exitCode === null && !timedOut) await Bun.sleep(5)
    const response = responses.get(id)
    assert.ok(response, `${id}: missing CLI control response: ${stderr}\n${stdout.slice(-6000)}`)
    assert.equal(response.subtype, 'success', `${id}: ${JSON.stringify(response)}`)
    assert.ok(response.response, `${id}: empty context snapshot`)
    timings.push({ kind: id, durationMs: Math.round((performance.now() - started) * 100) / 100 })
    return response.response
  }
  try {
    const first = await request('summary-including-startup', true)
    assertHeader(first)
    assert.equal(first.summaryOnly, true)
    assert.equal(first.skills, undefined, 'meter response expanded skill metadata')
    assert.deepEqual([first.memoryFiles, first.mcpTools, first.agents], [[], [], []])

    const full = await request('full-details', false)
    assertHeader(full)
    assert.notEqual(full.summaryOnly, true)
    assert.ok(full.skills?.skillFrontmatter.some(skill => skill.name === SKILL_NAME), 'full details did not discover the inert skill fixture')

    for (let sample = 0; sample < 3; sample++) {
      const summary = await request(`warm-summary-${sample + 1}`, true)
      assertHeader(summary)
      assert.equal(summary.summaryOnly, true)
      assert.equal(summary.skills, undefined)
    }
    child.stdin.end()
    const exitCode = await child.exited
    await drains
    assert.equal(timedOut, false, 'context summary CLI exceeded the liveness timeout')
    assert.equal(exitCode, 0, `CLI failed: ${stderr}\n${stdout.slice(-6000)}`)
    const modelRequests = upstreamRequests.filter(request => request.method !== 'HEAD' || request.path !== '/')
    assert.deepEqual(modelRequests, [], 'context controls made an upstream API request')
    writeFileSync(join(artifactDir, 'context-summary.json'), JSON.stringify({
      status: 'passed', sessionId, historicalCharacters: 987_192,
      header: { totalTokens: first.totalTokens, window: first.rawMaxTokens, percentage: first.percentage, autoCompactThreshold: first.autoCompactThreshold },
      fullSkillFixturePresent: true, modelRequests, startupProbes: upstreamRequests,
      timingNote: 'Small local samples, initial summary includes CLI startup; timings are evidence, not wall-clock gates.',
      timings,
    }, null, 2) + '\n')
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null) { child.kill('SIGKILL'); await child.exited }
    await drains
    writeFileSync(join(artifactDir, 'context-summary.log'), `${stdout}\n${stderr}`)
    upstream.stop(true)
    const mutations = sandbox.detectUserStateMutations()
    sandbox.cleanup()
    assert.deepEqual(mutations, [], 'context summary scenario mutated user state')
  }
}
