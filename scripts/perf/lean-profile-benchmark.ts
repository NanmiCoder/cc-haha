/**
 * Manual live benchmark. Never included in CI; requires --allow-live.
 *
 * bun run scripts/perf/lean-profile-benchmark.ts --allow-live \
 *   --baseline /tmp/old-source --output /tmp/lean-benchmark
 *
 * The baseline is a git archive made before the change, with node_modules linked
 * read-only by convention. Three profiles run identical disposable projects:
 * baseline standard, baseline lean, current lean. Only the proxy holds a real
 * provider key. CLI homes contain fake credentials and no real user settings.
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { getClaudeCodeModelCapabilities } from '../../src/shared/modelReasoning.js'
import { buildSandboxLaneEnv, describeUserStateMutations, fingerprintUserState, realUserConfigDir, sandboxTranscriptEvidence } from '../quality-gate/sandbox.js'
import { getProviderIndexPath } from '../quality-gate/providerTargets.js'
import { startRecorder, type RawInteraction } from '../quality-gate/replay/recorder.js'
import { fingerprintRequest, responseToolNames } from '../quality-gate/replay/wire.js'
import { BENCHMARK_FIXTURES, WEB_BENCHMARK_FIXTURE, type BenchmarkFixture } from './lean-profile-benchmark-fixtures.js'

type Profile = 'standard' | 'lean-original' | 'lean-enhanced'
type SavedProvider = { id: string; name: string; apiKey?: string; baseUrl?: string; apiFormat?: string; models?: { main?: string } }
export type Usage = {
  inputUncached: number
  inputCacheRead: number
  inputCacheWrite: number
  inputTotal: number
  output: number
}
const emptyUsage = (): Usage => ({ inputUncached: 0, inputCacheRead: 0, inputCacheWrite: 0, inputTotal: 0, output: 0 })

/** Anthropic message_delta replaces cumulative counters; it is not another bill. */
export function usageOf(raw: RawInteraction): Usage | null {
  let found = false
  const cumulative: Record<string, number> = {}
  const take = (value: unknown) => {
    if (!value || typeof value !== 'object') return
    for (const field of ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens']) {
      const count = (value as Record<string, unknown>)[field]
      if (typeof count === 'number' && Number.isFinite(count) && count >= 0) {
        found = true
        cumulative[field] = Math.max(cumulative[field] ?? 0, count)
      }
    }
  }
  take((raw.response.json as { usage?: unknown } | undefined)?.usage)
  for (const event of raw.response.events ?? []) {
    const data = event.data as { type?: string; message?: { usage?: unknown }; usage?: unknown }
    if (data?.type === 'message_start') take(data.message?.usage)
    if (data?.type === 'message_delta') take(data.usage)
  }
  if (!found) return null
  const inputUncached = cumulative.input_tokens ?? 0
  const inputCacheRead = cumulative.cache_read_input_tokens ?? 0
  const inputCacheWrite = cumulative.cache_creation_input_tokens ?? 0
  return {
    inputUncached, inputCacheRead, inputCacheWrite,
    inputTotal: inputUncached + inputCacheRead + inputCacheWrite,
    output: cumulative.output_tokens ?? 0,
  }
}

export function sumUsage(values: Array<Usage | null>): Usage {
  const total = emptyUsage()
  for (const value of values) if (value) for (const key of Object.keys(total) as Array<keyof Usage>) total[key] += value[key]
  return total
}

function parseArgs(argv: string[]) {
  const args = new Map<string, string>()
  const flags = new Set(['--allow-live', '--dry-run', '--inspect'])
  const values = new Set(['--baseline', '--source', '--output', '--provider', '--only', '--profiles', '--rounds'])
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index]!
    if (flags.has(key)) args.set(key, '1')
    else if (values.has(key) && argv[index + 1] && !argv[index + 1]!.startsWith('--')) args.set(key, argv[++index]!)
    else throw new Error(`Unknown or incomplete argument: ${key}`)
  }
  const profiles = (args.get('--profiles') ?? 'standard,lean-original,lean-enhanced').split(',') as Profile[]
  if (profiles.some(profile => !['standard', 'lean-original', 'lean-enhanced'].includes(profile))) throw new Error('Invalid --profiles')
  const rounds = Number(args.get('--rounds') ?? '1')
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 2) throw new Error('--rounds must be 1 or 2 (bounded live quota)')
  const only = args.get('--only')?.split(',')
  const availableFixtures = [...BENCHMARK_FIXTURES, WEB_BENCHMARK_FIXTURE]
  if (only?.some(id => !availableFixtures.some(fixture => fixture.id === id))) throw new Error('Invalid --only fixture')
  const source = resolve(args.get('--source') ?? join(import.meta.dir, '../..'))
  const baseline = args.get('--baseline') ? resolve(args.get('--baseline')!) : undefined
  const output = args.get('--output') ? resolve(args.get('--output')!) : undefined
  if (!args.has('--inspect') && (!output || !/^\/(?:private\/)?tmp\//.test(output))) throw new Error('--output must be an explicit directory under /tmp')
  if (!args.has('--inspect') && !baseline) throw new Error('--baseline must point at an unchanged source snapshot')
  if (!args.has('--allow-live') && !args.has('--dry-run') && !args.has('--inspect')) throw new Error('Live quota requires --allow-live; use --dry-run for offline fixture validation')
  return { args, profiles, rounds, source, baseline, output, provider: args.get('--provider') ?? 'DeepSeek', fixtures: only ? availableFixtures.filter(fixture => only.includes(fixture.id)) : BENCHMARK_FIXTURES }
}

function readProvider(name: string): SavedProvider {
  const index = JSON.parse(readFileSync(getProviderIndexPath(), 'utf8')) as { providers?: SavedProvider[] }
  const matches = (index.providers ?? []).filter(provider => provider.name === name || provider.id === name)
  if (matches.length !== 1) throw new Error(`Expected one saved provider named ${name}, found ${matches.length}`)
  const provider = matches[0]!
  if ((provider.apiFormat ?? 'anthropic') !== 'anthropic') throw new Error('This benchmark requires an Anthropic-format saved provider')
  if (!provider.baseUrl || !provider.apiKey) throw new Error('Selected provider has no base URL or API key')
  if (provider.models?.main?.replace(/\[1m\]$/, '') !== 'deepseek-flash') throw new Error('Selected provider must use deepseek-flash; no fallback is permitted')
  return provider
}

function seedFixture(fixture: BenchmarkFixture, work: string, acceptancePath: string) {
  mkdirSync(work, { recursive: true })
  for (const [path, contents] of Object.entries(fixture.files)) {
    mkdirSync(dirname(join(work, path)), { recursive: true })
    writeFileSync(join(work, path), contents)
  }
  writeFileSync(acceptancePath, fixture.acceptance)
}

async function runCheck(command: string[], cwd: string, env: Record<string, string>) {
  const child = Bun.spawn(command, { cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const timer = setTimeout(() => child.kill('SIGKILL'), 15_000)
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    return { passed: code === 0, code, stdout, stderr }
  } finally { clearTimeout(timer) }
}

function requestSummary(raw: RawInteraction, mainPrompt: string) {
  const fingerprint = fingerprintRequest('anthropic', raw.body)
  const isAgentLoop = fingerprint.toolNames.some(name => ['Read', 'Bash', 'Edit'].includes(name))
  return {
    sequence: raw.seq,
    kind: !isAgentLoop ? 'auxiliary' : fingerprint.firstUserText.includes(mainPrompt) ? 'main' : 'subagent',
    loop: createHash('sha256').update(fingerprint.firstUserText).digest('hex').slice(0, 12),
    model: fingerprint.model,
    systemBytes: Buffer.byteLength(JSON.stringify(raw.body.system ?? [])),
    toolSchemaBytes: Buffer.byteLength(JSON.stringify(raw.body.tools ?? [])),
    requestBytes: Buffer.byteLength(JSON.stringify(raw.body)),
    offeredTools: fingerprint.toolNames,
    calledTools: responseToolNames('anthropic', raw.response.events ?? [], raw.response.json),
    effort: (raw.body.output_config as { effort?: unknown } | undefined)?.effort ?? null,
    thinking: raw.body.thinking ?? null,
    maxOutputTokens: raw.body.max_tokens ?? null,
    status: raw.response.status,
    firstByteMs: raw.response.firstByteMs ?? null,
    usage: usageOf(raw),
  }
}

type RunResult = Awaited<ReturnType<typeof runBenchmarkCase>>

export async function runBenchmarkCase(options: {
  fixture: BenchmarkFixture
  profile: Profile
  round: number
  source: string
  baseline: string
  output: string
  provider: SavedProvider
  totalRequests: { count: number }
  deadline: number
  /** Offline harness validation, never supplied by the CLI live path. */
  fetchUpstream?: typeof fetch
}) {
  const { fixture, profile, round, provider } = options
  const runDir = join(options.output, `${fixture.id}-${profile}-r${round}`)
  if (existsSync(runDir)) throw new Error(`Refusing to overwrite ${runDir}`)
  mkdirSync(runDir, { recursive: true })
  const work = join(runDir, 'project')
  const home = join(runDir, 'home')
  const acceptancePath = join(runDir, 'acceptance.mjs')
  seedFixture(fixture, work, acceptancePath)
  const model = 'deepseek-flash'
  const source = profile === 'lean-enhanced' ? options.source : options.baseline
  let requests = 0
  const stopUpstream = new AbortController()
  const recorder = startRecorder({
    format: 'anthropic', upstreamBase: provider.baseUrl!, apiKey: provider.apiKey!,
    fetchUpstream: (async (input, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { model?: string }
      if (body.model !== model) throw new Error(`Blocked unexpected model ${body.model ?? '(none)'}`)
      if (++requests > 40 || ++options.totalRequests.count > 180 || Date.now() > options.deadline) throw new Error('Benchmark request/time quota reached')
      return (options.fetchUpstream ?? fetch)(input, { ...init, signal: AbortSignal.any([stopUpstream.signal, AbortSignal.timeout(120_000)]) })
    }) as typeof fetch,
  })
  const capabilities = getClaudeCodeModelCapabilities(model, 'anthropic')
  // Keep capability detection pointed at the genuine endpoint. The same seam
  // used by nativeSearch.test.ts redirects its fetches to our recording proxy.
  // No production gate or tool description is altered for the benchmark.
  const interceptPath = join(runDir, 'recording-preload.ts')
  writeFileSync(interceptPath, `const originalFetch = globalThis.fetch
const upstream = new URL(process.env.CC_HAHA_BENCH_UPSTREAM_BASE!)
const recorder = process.env.CC_HAHA_BENCH_RECORDER_URL!
globalThis.fetch = (async (input, init) => {
  const request = new Request(input, init)
  const url = new URL(request.url)
  if (process.env.CC_HAHA_BENCH_ALLOW_DOCS === '1' && url.protocol === 'https:' && url.hostname === 'api-docs.deepseek.com') {
    request.headers.delete('authorization')
    request.headers.delete('x-api-key')
    return originalFetch(request)
  }
  if (url.origin !== upstream.origin || !url.pathname.startsWith(upstream.pathname.replace(/\\/$/, '') + '/')) throw new Error('Benchmark blocks unrelated network access')
  const path = url.pathname.slice(upstream.pathname.replace(/\\/$/, '').length)
  return originalFetch(new Request(recorder + path + url.search, request))
}) as typeof fetch
`)
  const env = buildSandboxLaneEnv(home, {
    CALLER_DIR: work, CC_HAHA_SKIP_DOTENV: '1',
    ANTHROPIC_BASE_URL: provider.baseUrl!, ANTHROPIC_API_KEY: 'benchmark-fake-key',
    CC_HAHA_BENCH_UPSTREAM_BASE: provider.baseUrl!, CC_HAHA_BENCH_RECORDER_URL: recorder.url,
    CC_HAHA_BENCH_ALLOW_DOCS: fixture.kind === 'web' ? '1' : '0',
    ANTHROPIC_MODEL: model, ANTHROPIC_SMALL_FAST_MODEL: model,
    ANTHROPIC_DEFAULT_FABLE_MODEL: model, ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model, ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES: capabilities,
    ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES: capabilities,
    ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES: capabilities,
    ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES: capabilities,
    CLAUDE_CODE_MODEL_CONTEXT_WINDOWS: JSON.stringify({ [model]: 1_000_000 }),
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '16384',
    CLAUDE_CODE_EFFORT_LEVEL: 'medium', CLAUDE_CODE_ENABLE_TASKS: '1',
    CC_HAHA_AGENT_TEAMS_ENABLED: '0', ENABLE_TOOL_SEARCH: 'false',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '1', CLAUDE_CODE_MAX_RETRIES: '0', CI: '1',
  })
  mkdirSync(env.CLAUDE_CONFIG_DIR!, { recursive: true })
  const sanitize = (text: string) => text
    .split(provider.apiKey!).join('[REDACTED]')
    .split(homedir()).join('<real-home>')
  const command = [
    process.execPath, '--no-env-file', '--feature=TRANSCRIPT_CLASSIFIER', '--preload', join(source, 'preload.ts'), '--preload', interceptPath, join(source, 'src/entrypoints/cli.tsx'),
    '--print', '--agent-profile', profile === 'standard' ? 'standard' : 'lean',
    '--session-id', randomUUID(), '--model', model, '--effort', 'medium',
    '--permission-mode', 'bypassPermissions', '--max-turns', '28', '--output-format', 'stream-json', '--verbose', fixture.prompt,
  ]
  console.log(`[benchmark] START ${fixture.id} / ${profile} / round ${round}`)
  const start = performance.now()
  const child = Bun.spawn(command, { cwd: work, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    stopUpstream.abort()
    child.kill('SIGKILL')
  }, Math.min(300_000, Math.max(1, options.deadline - Date.now())))
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    const durationMs = Math.round(performance.now() - start)
    await recorder.settle(200, 5000).catch(() => {})
    const raw = recorder.take()
    const requestDetails = raw.map(interaction => requestSummary(interaction, fixture.prompt))
    writeFileSync(join(runDir, 'cli.stdout.jsonl'), sanitize(stdout))
    writeFileSync(join(runDir, 'cli.stderr.log'), sanitize(stderr))
    writeFileSync(join(runDir, 'requests.json'), sanitize(JSON.stringify(requestDetails, null, 2)) + '\n')
    const first = raw.find(interaction => Array.isArray(interaction.body.tools) && interaction.body.tools.length > 0)
    if (first) writeFileSync(join(runDir, 'first-request-prefix.json'), sanitize(JSON.stringify({ system: first.body.system, tools: first.body.tools, thinking: first.body.thinking, output_config: first.body.output_config }, null, 2)) + '\n')
    const checkedTests = fixture.kind === 'web' ? { passed: true, code: 0, stdout: 'Not applicable: documentation smoke', stderr: '' } : await runCheck(['npm', 'test'], work, env)
    const acceptance = await runCheck(['node', acceptancePath, work], work, env)
    const originalTestsPreserved = Object.entries(fixture.files).filter(([path]) => path.startsWith('test/')).every(([path, contents]) => readFileSync(join(work, path), 'utf8') === contents)
    const regressionTestAdded = fixture.kind === 'web' || readdirSync(join(work, 'test')).some(path => path.endsWith('.test.mjs') && !fixture.files[`test/${path}`])
    const messages = stdout.split('\n').flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
    const cliResult = messages.findLast(message => message.type === 'result')
    const usage = sumUsage(requestDetails.map(request => request.usage))
    const expectedTools = profile === 'lean-original'
      ? ['Bash', 'Read', 'Glob', 'Grep', 'Edit', 'Write', 'Skill']
      : ['Bash', 'Read', 'Glob', 'Grep', 'Edit', 'Write', 'Skill', 'Agent', 'TaskOutput', 'TaskStop', 'WebSearch', 'WebFetch', 'TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList', ...(profile === 'lean-enhanced' ? ['SendMessage'] : [])]
    const offeredTools = requestDetails.find(request => request.kind !== 'auxiliary')?.offeredTools ?? []
    const missingExpectedTools = expectedTools.filter(name => !offeredTools.includes(name))
    const unexpectedLeanTools = profile === 'standard' ? [] : offeredTools.filter(name => !expectedTools.includes(name))
    const calledTools = requestDetails.flatMap(request => request.calledTools)
    const requiredToolsUsed = fixture.kind !== 'web' || ['WebSearch', 'WebFetch', 'Write'].every(name => calledTools.includes(name))
    const agentCalls = calledTools.filter(name => name === 'Agent').length
    const subagentUsage = sumUsage(requestDetails.filter(request => request.kind === 'subagent').map(request => request.usage))
    const collaboration = fixture.id !== 'parallel-import' ? 'not requested'
      : profile === 'lean-original' ? 'not available; completed by main agent'
        : agentCalls >= 2 && requestDetails.some(request => request.kind === 'subagent') ? 'two or more Agent calls observed' : 'requested delegation not observed'
    const success = code === 0 && !timedOut && cliResult?.subtype === 'success' && checkedTests.passed && acceptance.passed && originalTestsPreserved && regressionTestAdded && missingExpectedTools.length === 0 && unexpectedLeanTools.length === 0 && requiredToolsUsed
    const result = {
      fixture: fixture.id, title: fixture.title, profile, round, status: success ? 'passed' : 'failed',
      durationMs, cliExitCode: code, cliSubtype: cliResult?.subtype ?? null, timedOut,
      source, work, requests: requestDetails.length,
      agentLoops: new Set(requestDetails.filter(request => request.kind !== 'auxiliary').map(request => request.loop)).size,
      subagentRequests: requestDetails.filter(request => request.kind === 'subagent').length,
      agentCalls, subagentUsage, collaboration,
      usage, usageCoverage: `${requestDetails.filter(request => request.usage).length}/${requestDetails.length}`,
      firstRequest: requestDetails.find(request => request.kind !== 'auxiliary') ?? null,
      toolsCalled: calledTools, requiredToolsUsed,
      originalTestsPreserved, regressionTestAdded,
      missingExpectedTools, unexpectedLeanTools,
      publicTests: { ...checkedTests, stdout: sanitize(checkedTests.stdout), stderr: sanitize(checkedTests.stderr) },
      acceptance: { ...acceptance, stdout: sanitize(acceptance.stdout), stderr: sanitize(acceptance.stderr) },
      transcripts: sandboxTranscriptEvidence(env.CLAUDE_CONFIG_DIR!),
    }
    writeFileSync(join(runDir, 'result.json'), sanitize(JSON.stringify(result, null, 2)) + '\n')
    console.log(`[benchmark] ${result.status.toUpperCase()} ${fixture.id} / ${profile}: ${durationMs} ms, ${requestDetails.length} requests, input ${usage.inputTotal}, output ${usage.output}, loops ${result.agentLoops}`)
    return result
  } finally {
    clearTimeout(timer)
    stopUpstream.abort()
    await recorder.stop()
  }
}

export function writeReport(output: string, results: RunResult[], metadata: Record<string, unknown>) {
  writeFileSync(join(output, 'results.json'), JSON.stringify({ ...metadata, results }, null, 2) + '\n')
  const profiles = ['standard', 'lean-original', 'lean-enhanced'] as const
  const totals = profiles.map(profile => {
    const runs = results.filter(result => result.profile === profile)
    return { profile, runs: runs.length, passed: runs.filter(result => result.status === 'passed').length, durationMs: runs.reduce((sum, run) => sum + run.durationMs, 0), requests: runs.reduce((sum, run) => sum + run.requests, 0), usage: sumUsage(runs.map(run => run.usage)) }
  })
  const rows = results.map(run => `| ${run.title} | ${run.profile} | ${run.status} | ${(run.durationMs / 1000).toFixed(1)} | ${run.requests} | ${run.usage.inputTotal} | ${run.usage.inputCacheRead} | ${run.usage.output} | ${run.agentLoops} |`)
  const aggregate = totals.map(total => `| ${total.profile} | ${total.passed}/${total.runs} | ${(total.durationMs / 1000).toFixed(1)} | ${total.requests} | ${total.usage.inputTotal} | ${total.usage.inputUncached} | ${total.usage.inputCacheRead} | ${total.usage.output} |`)
  const report = [
    '# DeepSeek Flash：精简模式真实任务比较', '',
    `模型 deepseek-flash；所有主代理、子代理和辅助模型槽位一致；medium effort；每项任务每种模式一份全新 /tmp 项目和 HOME。`,
    '真实 API usage 包含所有请求及子代理；输入总量 = 未缓存输入 + 缓存读取 + 缓存写入。首轮字节是固定前缀体积，不能当 token 或费用。',
    '每次运行最多 40 次上游请求、28 个主循环 turn、300 秒；全实验最多 180 次请求、30 分钟。没有自动重试失败任务。',
    '所有文件任务要求不联网；WebSearch/WebFetch 的 live 效果不包含在本组代码任务验收中。运行顺序轮换，缓存由服务商控制且未清空。样本较少，不是统计显著性结论。', '',
    '| 任务 | 模式 | 验收 | 秒 | 请求 | 总输入 token | 缓存读取 | 输出 token | Agent 循环数 |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |', ...rows, '',
    '| 模式 | 通过/运行 | 总秒 | 请求 | 总输入 | 未缓存输入 | 缓存读取 | 输出 |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |', ...aggregate, '',
    '验收要求：CLI 正常结束、原测试保留、新增回归测试、项目测试通过、独立验收脚本通过。明细见 results.json 和各运行目录的 requests.json / result.json。', '',
  ].join('\n')
  writeFileSync(join(output, 'report.md'), report)
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.args.has('--dry-run')) {
    mkdirSync(options.output!, { recursive: true })
    for (const fixture of options.fixtures) {
      const directory = join(options.output!, `dry-${fixture.id}`)
      mkdirSync(directory, { recursive: true })
      const work = join(directory, 'project')
      const acceptance = join(directory, 'acceptance.mjs')
      seedFixture(fixture, work, acceptance)
      const env = buildSandboxLaneEnv(join(directory, 'home'), {}, { PATH: process.env.PATH, SHELL: process.env.SHELL })
      const before = await runCheck(['node', acceptance, work], work, env)
      if (before.passed) throw new Error(`${fixture.id} already passes before implementation`)
      console.log(`[dry-run] ${fixture.id}: fixture ready; initial independent acceptance fails as intended`)
    }
    return
  }
  const provider = readProvider(options.provider)
  const providerMetadata = { provider: provider.name, model: 'deepseek-flash', host: new URL(provider.baseUrl!).host, apiFormat: 'anthropic', effort: 'medium' }
  if (options.args.has('--inspect')) {
    console.log(JSON.stringify({ ...providerMetadata, credentialAvailable: true }, null, 2))
    return
  }
  mkdirSync(options.output!, { recursive: true })
  const realConfig = realUserConfigDir()
  const before = fingerprintUserState(realConfig)
  const totalRequests = { count: 0 }
  const results: RunResult[] = []
  const metadata = { ...providerMetadata, startedAt: new Date().toISOString(), baseline: options.baseline, source: options.source, rounds: options.rounds, runOrder: 'rotate profile order by task and round', estimatedTokens: false }
  const deadline = Date.now() + 30 * 60_000
  try {
    for (let round = 1; round <= options.rounds; round++) {
      for (let index = 0; index < options.fixtures.length; index++) {
        const offset = (index + round - 1) % options.profiles.length
        const profiles = [...options.profiles.slice(offset), ...options.profiles.slice(0, offset)]
        for (const profile of profiles) {
          if (Date.now() > deadline || totalRequests.count >= 180) throw new Error('Global benchmark bound reached')
          results.push(await runBenchmarkCase({ fixture: options.fixtures[index]!, profile, round, source: options.source, baseline: options.baseline!, output: options.output!, provider, totalRequests, deadline }))
          writeReport(options.output!, results, metadata)
        }
      }
    }
  } finally {
    const after = fingerprintUserState(realConfig)
    const mutations = describeUserStateMutations(before, after)
    writeFileSync(join(options.output!, 'user-state-guard.json'), JSON.stringify({ realConfigMutations: mutations, before, after, note: 'Only a saved DeepSeek key was read; sandbox processes had fake keys and isolated HOME/config paths. Concurrent external writes, if any, require attribution.' }, null, 2) + '\n')
    writeReport(options.output!, results, { ...metadata, completedAt: new Date().toISOString(), liveRequests: totalRequests.count, userStateMutations: mutations })
    if (mutations.length) process.exitCode = 1
  }
  if (results.some(result => result.status !== 'passed')) process.exitCode = 1
  console.log(`[benchmark] report: ${join(options.output!, 'report.md')}`)
}

if (import.meta.main) main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
