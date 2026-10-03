/**
 * Replays the requests the desktop sends when a session is opened, against a
 * real server booted in a quality-gate sandbox, and reports how long each one
 * takes. Local diagnostic only: it is not part of any PR lane.
 *
 *   bun run scripts/perf/session-open-benchmark.ts --transcript a.jsonl [--transcript b.jsonl] [--rounds 2] [--sidebar]
 *
 * Each `--transcript` is copied (read-only) into the sandbox and concatenated
 * into one session, with `sessionId`/`cwd` rewritten so nothing points back at
 * the source. The sandbox is deleted afterwards.
 */
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { createQualityGateSandbox } from '../quality-gate/sandbox.js'
import { sanitizePath } from '../../src/utils/sessionStoragePortable.js'

const REQUEST_TIMEOUT_MS = 120_000
const SESSION_ID = '0b0e1c5e-5e55-4a11-9b0b-0000000b0e1c'

type Timing = { name: string; ms: number; status: number | 'timeout' | 'error'; bytes: number }

function parseArgs(argv: string[]) {
  const transcripts: string[] = []
  let rounds = 2
  let sidebar = false
  let keep = false
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--transcript') transcripts.push(resolve(argv[++index]!))
    else if (arg === '--rounds') rounds = Number(argv[++index])
    else if (arg === '--sidebar') sidebar = true
    else if (arg === '--keep') keep = true
    else throw new Error(`Unknown argument: ${arg}`)
  }
  if (transcripts.length === 0) throw new Error('Pass at least one --transcript <path>')
  return { transcripts, rounds, sidebar, keep }
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => resolvePort(typeof address === 'object' && address ? address.port : 0))
    })
  })
}

async function copyTranscripts(sources: string[], target: string, workDir: string) {
  const output = createWriteStream(target)
  let records = 0
  let conversation = 0
  for (const source of sources) {
    const lines = createInterface({ input: createReadStream(source), crlfDelay: Infinity })
    for await (const line of lines) {
      if (!line.trim()) continue
      let text = line
      try {
        const entry = JSON.parse(line) as Record<string, unknown>
        if ('sessionId' in entry) entry.sessionId = SESSION_ID
        if ('cwd' in entry) entry.cwd = workDir
        const message = entry.message as { role?: unknown } | undefined
        if ((entry.type === 'user' || entry.type === 'assistant') && message?.role) conversation++
        text = JSON.stringify(entry)
      } catch {
        // Keep malformed lines byte-for-byte; the server must tolerate them.
      }
      if (!output.write(text + '\n')) await new Promise(done => output.once('drain', done))
      records++
    }
  }
  await new Promise<void>((done, reject) => output.end((error?: Error | null) => error ? reject(error) : done()))
  return { records, conversation, bytes: (await stat(target)).size }
}

async function timed(base: string, name: string, path: string): Promise<{ timing: Timing; body: unknown }> {
  const started = performance.now()
  try {
    const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    const text = await response.text()
    let body: unknown = null
    try { body = JSON.parse(text) } catch { /* non-JSON error bodies are still timed */ }
    return { timing: { name, ms: performance.now() - started, status: response.status, bytes: text.length }, body }
  } catch (error) {
    const status = (error as Error).name === 'TimeoutError' ? 'timeout' : 'error'
    return { timing: { name, ms: performance.now() - started, status, bytes: 0 }, body: null }
  }
}

type HistoryPage = { messages?: unknown[]; page?: { nextCursor?: string | null } }

/** Mirrors desktop/src/api/sessions.ts getFullHistory: mode=full, then every cursor page. */
async function fullHistory(base: string, timings: Timing[]) {
  const started = performance.now()
  const first = await timed(base, 'messages?mode=full', `/api/sessions/${SESSION_ID}/messages?mode=full`)
  timings.push(first.timing)
  let cursor = (first.body as HistoryPage | null)?.page?.nextCursor ?? null
  let messages = (first.body as HistoryPage | null)?.messages?.length ?? 0
  let pages = 0
  let slowestPage = 0
  let failed = first.timing.status !== 200
  while (cursor && !failed) {
    const page = await timed(base, 'messages?cursor', `/api/sessions/${SESSION_ID}/messages?${new URLSearchParams({ cursor })}`)
    pages++
    slowestPage = Math.max(slowestPage, page.timing.ms)
    if (page.timing.status !== 200) {
      timings.push(page.timing)
      failed = true
      break
    }
    messages += (page.body as HistoryPage | null)?.messages?.length ?? 0
    cursor = (page.body as HistoryPage | null)?.page?.nextCursor ?? null
  }
  timings.push({ name: `history total (${pages} cursor pages, slowest ${Math.round(slowestPage)}ms, ${messages} msgs)`, ms: performance.now() - started, status: failed ? 'error' : 200, bytes: 0 })
}

async function openSession(base: string, sidebar: boolean): Promise<Timing[]> {
  const timings: Timing[] = []
  const id = SESSION_ID
  const burst: Array<Promise<void>> = [
    fullHistory(base, timings),
    ...[
      ['summary', `/api/sessions/${id}/summary`],
      ['git-info', `/api/sessions/${id}/git-info`],
      ['slash-commands', `/api/sessions/${id}/slash-commands`],
      ['chat/status', `/api/sessions/${id}/chat/status`],
      ['inspection(context)', `/api/sessions/${id}/inspection?includeContext=1&contextOnly=1`],
      ['workspace/status#1', `/api/sessions/${id}/workspace/status`],
      ['team plan', `/api/teams/session/${id}/plan`],
    ].map(([name, path]) => timed(base, name!, path!).then(result => { timings.push(result.timing) })),
  ]
  if (sidebar) burst.push(timed(base, 'sidebar list', '/api/sessions?limit=60&perProjectLimit=6').then(result => { timings.push(result.timing) }))
  await Promise.all(burst)
  // MessageList asks for these only after history is ready.
  await Promise.all([
    timed(base, 'turn-checkpoints', `/api/sessions/${id}/turn-checkpoints`),
    timed(base, 'workspace/status#2', `/api/sessions/${id}/workspace/status`),
  ].map(request => request.then(result => { timings.push(result.timing) })))
  return timings
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  for (const transcript of options.transcripts) {
    if (!existsSync(transcript)) throw new Error(`Transcript not found: ${transcript}`)
  }
  const sandbox = createQualityGateSandbox({ label: 'session-open' })
  const workDir = join(sandbox.home, 'workdir')
  mkdirSync(workDir, { recursive: true })
  const projectDir = join(sandbox.configDir, 'projects', sanitizePath(workDir))
  mkdirSync(projectDir, { recursive: true })
  const target = join(projectDir, `${SESSION_ID}.jsonl`)
  let server: ReturnType<typeof Bun.spawn> | undefined
  try {
    const copied = await copyTranscripts(options.transcripts, target, workDir)
    console.log(`transcript: ${copied.records} records, ${copied.conversation} conversation messages, ${(copied.bytes / 1048576).toFixed(1)} MiB`)

    const port = await freePort()
    const base = `http://127.0.0.1:${port}`
    const logPath = join(sandbox.home, 'server.log')
    server = Bun.spawn(['bun', 'run', 'src/server/index.ts', '--host', '127.0.0.1', '--port', String(port)], {
      env: { ...sandbox.env, SERVER_PORT: String(port), CLAUDE_CLI_PATH: resolve('src/server/__tests__/fixtures/mock-sdk-cli.ts') },
      stdout: Bun.file(logPath),
      stderr: Bun.file(logPath),
    })
    const bootDeadline = Date.now() + 60_000
    while (true) {
      try {
        if ((await fetch(`${base}/health`)).ok) break
      } catch { /* not listening yet */ }
      if (Date.now() > bootDeadline) throw new Error(`Server did not start; see ${logPath}`)
      await Bun.sleep(200)
    }

    for (let round = 1; round <= options.rounds; round++) {
      const started = performance.now()
      const timings = await openSession(base, options.sidebar)
      console.log(`\nround ${round}: ${((performance.now() - started) / 1000).toFixed(1)}s wall`)
      for (const timing of timings.sort((a, b) => b.ms - a.ms)) {
        const flag = timing.status === 'timeout' || timing.ms >= REQUEST_TIMEOUT_MS ? '  <-- exceeds 120s' : ''
        console.log(`  ${(timing.ms / 1000).toFixed(2).padStart(8)}s  ${String(timing.status).padEnd(7)} ${timing.name}${flag}`)
      }
    }

    const diagnostics = join(sandbox.configDir, 'cc-haha', 'diagnostics', 'diagnostics.jsonl')
    if (existsSync(diagnostics)) {
      const stalls = readFileSync(diagnostics, 'utf8').split('\n').filter(line => line.includes('event_loop'))
      if (stalls.length) console.log(`\nevent-loop stall diagnostics: ${stalls.length}`)
    }
  } finally {
    server?.kill()
    await server?.exited
    const mutations = sandbox.detectUserStateMutations()
    if (mutations.length) console.error(`Real user state changed: ${mutations.join(', ')}`)
    if (options.keep) console.log(`sandbox kept at ${sandbox.home}`)
    else sandbox.cleanup()
    if (mutations.length) process.exitCode = 1
  }
}

await main()
