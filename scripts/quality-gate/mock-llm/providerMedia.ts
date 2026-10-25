import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildProviderManagedEnv } from '../../../src/server/services/providerRuntimeEnv'
import { createQualityGateSandbox } from '../sandbox'
import { MOCK_IMAGE_PNG_BASE64, startMockLlmServer } from './server'
import type { MockReply, MockRequest } from './scriptedModel'

const MIB = 1024 * 1024
const MODEL = 'deepseek-flash'
const FILE_ID = 'file_mock_provider_media'
const TOOL_ID = 'provider_media_read'
const FIRST_DONE = 'PROVIDER_MEDIA_FIRST_DONE'
const LARGE_DONE = 'PROVIDER_MEDIA_LARGE_DONE'
const REUSE_DONE = 'PROVIDER_MEDIA_REUSE_DONE'
const TIMEOUT_MS = 60_000

type Block = { type?: string; id?: string; tool_use_id?: string; is_error?: boolean; content?: unknown; source?: { type?: string; data?: string; file_id?: string } }
type MediaEvidence = { bytes: number; fileIds: string[]; base64Images: number; pairedRead: boolean; uploads: number; beta: string | null }

function mediaEvidence(request: MockRequest, bytes: number, uploads: number, beta: string | null): MediaEvidence {
  const blocks = request.messages?.flatMap(message => Array.isArray(message.content) ? message.content : []) as Block[] ?? []
  const images = blocks.flatMap(block => block.type === 'tool_result' && Array.isArray(block.content) ? block.content as Block[] : [block])
    .filter(block => block.type === 'image')
  return {
    bytes, uploads, beta,
    fileIds: images.flatMap(image => image.source?.type === 'file' ? [image.source.file_id!] : []),
    base64Images: images.filter(image => image.source?.type === 'base64').length,
    pairedRead: blocks.some(block => block.type === 'tool_use' && block.id === TOOL_ID) &&
      blocks.some(block => block.type === 'tool_result' && block.tool_use_id === TOOL_ID && !block.is_error &&
        Array.isArray(block.content) && block.content.some((image: Block) => image.type === 'image')),
  }
}

const textReply = (text: string): MockReply => ({ kind: 'message', content: [{ type: 'text', text }], stopReason: 'end_turn' })

/**
 * Real SDK input → CLI history → authenticated provider fetch → Files API →
 * messages → real Read tool → next user turn. Only the remote service is faked.
 * The padded PNG is synthetic transport load (not a vision quality fixture).
 */
export async function runProviderMediaScenario(rootDir: string, artifactDir: string) {
  mkdirSync(artifactDir, { recursive: true })
  const sandbox = createQualityGateSandbox({
    label: 'provider-media', seedProviders: false,
    sourceConfigDir: join(artifactDir, 'unused-user-config'),
    source: { PATH: process.env.PATH, SHELL: process.env.SHELL, SYSTEMROOT: process.env.SYSTEMROOT },
  })
  const workDir = join(sandbox.home, 'project')
  mkdirSync(workDir, { recursive: true })
  const imagePath = join(workDir, 'fixture.png')
  writeFileSync(imagePath, Buffer.from(MOCK_IMAGE_PNG_BASE64, 'base64'))
  // 4 MiB in base64, below the per-image 5 MiB validation limit. Repeated
  // instances exercise content deduplication and history replacement together.
  const paddedImage = Buffer.alloc(3 * MIB)
  Buffer.from(MOCK_IMAGE_PNG_BASE64, 'base64').copy(paddedImage)
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: paddedImage.toString('base64') } }
  const evidence: MediaEvidence[] = []
  const uploads: Array<{ bytes: number; type: string; purpose: string; expiry: string }> = []
  const errors: string[] = []
  const results: Array<{ result?: string; is_error?: boolean; session_id?: string }> = []
  let phase = 1
  const upstream = startMockLlmServer(request => {
    if (!request.tools?.some(tool => tool.name === 'Read')) return textReply('Mock auxiliary reply')
    if (phase === 1) return textReply(FIRST_DONE)
    if (phase === 3) return textReply(REUSE_DONE)
    const last = request.messages?.at(-1)?.content
    if (Array.isArray(last) && last.some(block => block.type === 'tool_result' && block.tool_use_id === TOOL_ID)) return textReply(LARGE_DONE)
    return { kind: 'message', content: [{ type: 'tool_use', id: TOOL_ID, name: 'Read', input: { file_path: imagePath } }], stopReason: 'tool_use' }
  })
  const gateway = Bun.serve({
    hostname: '127.0.0.1', port: 0, maxRequestBodySize: 64 * MIB,
    async fetch(req) {
      try {
        const path = new URL(req.url).pathname
        if (path === '/files') {
          assert.equal(req.headers.get('authorization'), 'Bearer mock-provider-media-key', 'upload must use the API key account')
          const form = await req.formData()
          const file = form.get('file')
          assert.ok(file instanceof File)
          assert.equal(form.get('purpose'), 'user_data')
          assert.equal(form.get('expires_after[anchor]'), 'created_at')
          assert.equal(form.get('expires_after[seconds]'), '86400')
          assert.ok(Buffer.from(await file.arrayBuffer()).equals(paddedImage), 'uploaded bytes differ from original image')
          uploads.push({ bytes: file.size, type: file.type, purpose: String(form.get('purpose')), expiry: String(form.get('expires_after[seconds]')) })
          return Response.json({ id: FILE_ID, expires_at: Math.floor(Date.now() / 1000) + 86400 })
        }
        const body = await req.text()
        if (path === '/anthropic/v1/messages') {
          const parsed = JSON.parse(body) as MockRequest
          if (parsed.tools?.some(tool => tool.name === 'Read')) evidence.push(mediaEvidence(parsed, Buffer.byteLength(body), uploads.length, req.headers.get('anthropic-beta')))
          assert.ok(evidence.length <= 10, 'unexpected repeated CLI request')
        }
        const headers = new Headers(req.headers)
        headers.delete('host')
        headers.delete('content-length')
        return fetch(`${upstream.url}${path}`, { method: req.method, headers, body })
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error))
        return Response.json({ type: 'error', error: { type: 'invalid_request_error', message: errors.at(-1) } }, { status: 400 })
      }
    },
  })
  let child: ReturnType<typeof Bun.spawn> | undefined
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let stdout = ''
  let stderr = ''
  let transcriptPreserved = false
  try {
    const providerEnv = buildProviderManagedEnv({
      id: 'mock-deepseek', name: 'Mock DeepSeek', presetId: 'deepseek',
      baseUrl: 'https://api.deepseek.com/anthropic', apiKey: 'mock-provider-media-key', apiFormat: 'anthropic',
      runtimeKind: 'anthropic_compatible', models: { main: MODEL, haiku: MODEL, sonnet: MODEL, opus: MODEL },
    })
    const proc = Bun.spawn([
      process.execPath, '--no-env-file', '--preload', join(rootDir, 'scripts/quality-gate/mock-llm/providerMediaTransport.ts'),
      '--preload', join(rootDir, 'preload.ts'), join(rootDir, 'src/entrypoints/cli.tsx'),
      '--print', '--model', MODEL, '--permission-mode', 'bypassPermissions',
      '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--debug-file', join(artifactDir, 'provider-media.debug.log'),
    ], {
      cwd: workDir, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
      env: { ...sandbox.env, ...providerEnv, CALLER_DIR: workDir, CC_HAHA_SKIP_DOTENV: '1',
        MOCK_PROVIDER_MEDIA_ORIGIN: `http://127.0.0.1:${gateway.port}`,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' },
    })
    child = proc
    timer = setTimeout(() => { timedOut = true; proc.kill('SIGKILL') }, TIMEOUT_MS)
    const output = Promise.all([
      (async () => {
        const decoder = new TextDecoder()
        let pending = ''
        for await (const chunk of proc.stdout) {
          pending += decoder.decode(chunk, { stream: true })
          let newline: number
          while ((newline = pending.indexOf('\n')) !== -1) {
            const line = pending.slice(0, newline)
            pending = pending.slice(newline + 1)
            // Avoid multi-MiB media in diagnostic logs; the real transcript is
            // checked separately inside its disposable home before cleanup.
            stdout += `${line.slice(0, 2000)}\n`
            try {
              const message = JSON.parse(line)
              if (message.type === 'result') results.push(message)
            } catch {}
          }
        }
      })(),
      (async () => { stderr = await new Response(proc.stderr).text() })(),
    ])
    const send = async (content: unknown[]) => {
      proc.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: '' })}\n`)
      await proc.stdin.flush()
    }
    const waitForResult = async (marker: string) => {
      while (!results.some(result => result.result === marker || result.is_error) && proc.exitCode === null && !timedOut) await Bun.sleep(50)
      assert.ok(results.some(result => result.result === marker && !result.is_error), `${marker}: CLI did not complete (${timedOut ? 'timeout' : proc.exitCode}): ${stderr}`)
    }
    await send([{ type: 'text', text: 'Keep this image for the next step.' }, image])
    await waitForResult(FIRST_DONE)
    assert.equal(uploads.length, 0, 'a small first request uploaded an image')
    assert.equal(evidence.length, 1)
    assert.equal(evidence[0]!.base64Images, 1)
    assert.ok(evidence[0]!.bytes < 40 * MIB)
    phase = 2
    await send([{ type: 'text', text: 'Review these additional images, then Read fixture.png.' }, ...Array.from({ length: 10 }, () => image)])
    await waitForResult(LARGE_DONE)
    assert.equal(uploads.length, 1, 'large request must deduplicate uploads')
    assert.equal(evidence[1]!.fileIds.length, 11, 'large history did not convert its repeated images')
    assert.equal(evidence[1]!.base64Images, 0)
    assert.ok(evidence[1]!.bytes < 32 * MIB)
    assert.ok(evidence[1]!.beta?.split(',').includes('files-api-2025-04-14'))
    assert.ok(evidence[2]!.pairedRead, 'real Read did not return an image paired with its tool_use')
    phase = 3
    await send([{ type: 'text', text: 'Continue from the same images.' }])
    await waitForResult(REUSE_DONE)
    assert.equal(uploads.length, 1, 'next turn re-uploaded cached images')
    const reused = evidence.at(-1)!
    assert.equal(reused.fileIds.length, 11)
    assert.ok(reused.fileIds.every(id => id === FILE_ID))
    assert.ok(reused.pairedRead, 'next turn lost tool pairing')
    proc.stdin.end()
    const [exitCode] = await Promise.all([proc.exited, output])
    assert.equal(exitCode, 0, `CLI failed: ${stderr}`)
    assert.deepEqual(errors, [])
    const projects = join(sandbox.configDir, 'projects')
    const transcripts = readdirSync(projects).flatMap(dir => readdirSync(join(projects, dir)).filter(file => file.endsWith('.jsonl')).map(file => join(projects, dir, file)))
    const history = transcripts.map(file => readFileSync(file, 'utf8')).join('\n')
    transcriptPreserved = history.includes(image.source.data) && !history.includes(FILE_ID)
    assert.ok(transcriptPreserved, 'outbound conversion changed persisted source images')
  } finally {
    if (timer) clearTimeout(timer)
    if (child && child.exitCode === null) { child.kill('SIGKILL'); await child.exited }
    await gateway.stop(true)
    await upstream.stop()
    writeFileSync(join(artifactDir, 'provider-media.log'), `${stdout}\n${stderr}`)
    writeFileSync(join(artifactDir, 'provider-media-evidence.json'), `${JSON.stringify({ evidence, uploads, results, errors, transcriptPreserved, timedOut, upstreamRequests: upstream.requests.map(request => ({ path: request.path, stream: request.stream, outcome: request.outcome })) }, null, 2)}\n`)
    const mutations = sandbox.detectUserStateMutations()
    sandbox.cleanup()
    assert.deepEqual(mutations, [], 'provider-media lane mutated its isolated source state')
  }
}
