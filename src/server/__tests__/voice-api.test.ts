import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { handleApiRequest } from '../router.js'
import { handleVoiceApi } from '../api/voice.js'
import { createVoiceService } from '../services/voice/defaultRegistry.js'
import { VOICE_LIMITS, type VoiceCatalog, type VoiceProviderStatus, type VoiceTranscript } from '../services/voice/types.js'
import type { VoiceService } from '../services/voice/voiceService.js'
import { FakeProvider, makeWav } from '../services/voice/__tests__/fakeProvider.js'

let tmpDir: string
let originalConfigDir: string | undefined
let alpha: FakeProvider
let beta: FakeProvider
let service: VoiceService

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0))

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-api-'))
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tmpDir
  alpha = new FakeProvider({ id: 'sensevoice-local', name: 'Alpha', text: 'alpha text' })
  beta = new FakeProvider({ id: 'beta', name: 'Beta', languages: ['auto', 'en'], text: 'beta text' })
  service = createVoiceService([alpha, beta])
})

afterEach(async () => {
  if (originalConfigDir !== undefined) process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  else delete process.env.CLAUDE_CONFIG_DIR
  await fs.rm(tmpDir, { recursive: true, force: true })
})

async function call(method: string, target: string, body?: BodyInit | object, contentType?: string) {
  const url = new URL(target, 'http://localhost:3456')
  const init: RequestInit = { method }
  if (body !== undefined) {
    const raw = body instanceof Uint8Array || typeof body === 'string' ? body : JSON.stringify(body)
    init.body = raw as BodyInit
    init.headers = { 'Content-Type': contentType ?? (body instanceof Uint8Array ? 'audio/wav' : 'application/json') }
  }
  const req = new Request(url, init)
  return handleVoiceApi(req, url, url.pathname.split('/').filter(Boolean), service)
}

describe('GET /api/voice/catalog', () => {
  test('returns the catalog shape', async () => {
    const res = await call('GET', '/api/voice/catalog')

    expect(res.status).toBe(200)
    const catalog = await res.json() as VoiceCatalog
    expect(catalog).toEqual({
      supported: true,
      providers: [
        {
          info: { id: 'sensevoice-local', name: 'Alpha', location: 'local', languages: ['auto', 'zh', 'en'], downloadBytes: 1000 },
          preparation: { phase: 'unprepared' },
        },
        {
          info: { id: 'beta', name: 'Beta', location: 'local', languages: ['auto', 'en'], downloadBytes: 1000 },
          preparation: { phase: 'unprepared' },
        },
      ],
      preferences: { enabled: true, providerId: 'sensevoice-local', language: 'auto', downloadSource: 'auto' },
      limits: VOICE_LIMITS,
    })
  })

  test('is reachable through the main API router', async () => {
    const url = new URL('http://localhost:3456/api/voice/catalog')
    const res = await handleApiRequest(new Request(url), url)

    expect(res.status).toBe(200)
    const catalog = await res.json() as VoiceCatalog
    expect(Object.keys(catalog).sort()).toEqual(['limits', 'preferences', 'providers', 'supported'])
  })

  test('rejects other methods', async () => {
    expect((await call('POST', '/api/voice/catalog', {})).status).toBe(405)
  })
})

describe('PUT /api/voice/preferences', () => {
  test('persists a partial update to desktop-ui.json and keeps other sections', async () => {
    await fs.mkdir(path.join(tmpDir, 'cc-haha'), { recursive: true })
    await fs.writeFile(
      path.join(tmpDir, 'cc-haha', 'desktop-ui.json'),
      JSON.stringify({ schemaVersion: 6, futureField: { keep: true }, pet: { enabled: true } }),
    )

    const first = await call('PUT', '/api/voice/preferences', { enabled: true })
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({
      preferences: { enabled: true, providerId: 'sensevoice-local', language: 'auto', downloadSource: 'auto' },
    })

    const second = await call('PUT', '/api/voice/preferences', { language: 'zh' })
    expect(await second.json()).toEqual({
      preferences: { enabled: true, providerId: 'sensevoice-local', language: 'zh', downloadSource: 'auto' },
    })

    const file = JSON.parse(await fs.readFile(path.join(tmpDir, 'cc-haha', 'desktop-ui.json'), 'utf-8'))
    expect(file.voiceInput).toEqual({ enabled: true, providerId: 'sensevoice-local', language: 'zh', downloadSource: 'auto' })
    expect(file.futureField).toEqual({ keep: true })
    expect(file.pet.enabled).toBe(true)

    const catalog = await (await call('GET', '/api/voice/catalog')).json() as VoiceCatalog
    expect(catalog.preferences.language).toBe('zh')
  })

  test('rejects unknown providers with 404 and invalid values with 400, writing nothing', async () => {
    const unknown = await call('PUT', '/api/voice/preferences', { providerId: 'nope' })
    expect(unknown.status).toBe(404)
    expect(await unknown.json()).toMatchObject({ error: 'voice/unknown-provider' })

    expect((await call('PUT', '/api/voice/preferences', { language: 'fr' })).status).toBe(400)
    expect((await call('PUT', '/api/voice/preferences', { providerId: 'beta', language: 'zh' })).status).toBe(400)
    expect((await call('PUT', '/api/voice/preferences', { enabled: 'yes' })).status).toBe(400)
    expect((await call('PUT', '/api/voice/preferences', { downloadSource: 'npmmirror' })).status).toBe(400)
    expect((await call('PUT', '/api/voice/preferences', 'not json', 'application/json')).status).toBe(400)

    await expect(fs.access(path.join(tmpDir, 'cc-haha', 'desktop-ui.json'))).rejects.toThrow()
  })
})

describe('provider endpoints', () => {
  test('prepare returns immediately, status tracks progress, cancel and delete round-trip', async () => {
    const prepare = await call('POST', '/api/voice/providers/sensevoice-local/prepare')
    expect(prepare.status).toBe(200)
    expect((await prepare.json() as VoiceProviderStatus).preparation.phase).toBe('downloading')

    await alpha.started
    alpha.report({ phase: 'downloading', step: 'model', completedBytes: 5, totalBytes: 10 })
    const status = await (await call('GET', '/api/voice/providers/sensevoice-local/status')).json() as VoiceProviderStatus
    expect(status.preparation).toMatchObject({ completedBytes: 5, totalBytes: 10 })

    const cancel = await (await call('POST', '/api/voice/providers/sensevoice-local/cancel')).json() as VoiceProviderStatus
    expect(cancel.preparation.phase).toBe('cancelled')
    await flush()

    alpha.installed = true
    const removed = await call('DELETE', '/api/voice/providers/sensevoice-local/assets')
    expect((await removed.json() as VoiceProviderStatus).preparation.phase).toBe('unprepared')
    expect(alpha.removeCalls).toBe(1)
  })

  test.each([
    ['GET', '/api/voice/providers/nope/status'],
    ['POST', '/api/voice/providers/nope/prepare'],
    ['POST', '/api/voice/providers/nope/cancel'],
    ['DELETE', '/api/voice/providers/nope/assets'],
  ])('%s %s returns 404 for an unknown provider', async (method, target) => {
    const res = await call(method, target)

    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: 'voice/unknown-provider' })
  })

  test('treats a malformed percent-encoded provider id as an unknown provider, not a server error', async () => {
    // decodeURIComponent throws URIError on `%E0%A4%A`; that must not become a 500.
    for (const action of ['status', 'prepare', 'cancel']) {
      const method = action === 'status' ? 'GET' : 'POST'
      const res = await call(method, `/api/voice/providers/%E0%A4%A/${action}`)

      expect(res.status).toBe(404)
      expect(await res.json()).toMatchObject({ error: 'voice/unknown-provider' })
    }
  })

  test('rejects wrong methods and unknown actions', async () => {
    expect((await call('GET', '/api/voice/providers/beta/prepare')).status).toBe(405)
    expect((await call('GET', '/api/voice/providers/beta/bogus')).status).toBe(404)
    expect((await call('GET', '/api/voice/providers/beta')).status).toBe(404)
    expect((await call('GET', '/api/voice/bogus')).status).toBe(404)
  })
})

describe('POST /api/voice/transcribe', () => {
  test('returns a transcript for a ready provider using saved preferences', async () => {
    alpha.installed = true
    await call('PUT', '/api/voice/preferences', { language: 'zh' })

    const res = await call('POST', '/api/voice/transcribe', makeWav(2))

    expect(res.status).toBe(200)
    expect(await res.json() as VoiceTranscript).toEqual({ text: 'alpha text', audioSeconds: 2, inferenceSeconds: 0.25 })
    expect(alpha.transcribeCalls).toEqual([{ bytes: makeWav(2).byteLength, language: 'zh' }])
  })

  test('honours the provider and language query, even while the feature is disabled', async () => {
    beta.installed = true

    const res = await call('POST', '/api/voice/transcribe?provider=beta&language=en', makeWav(1))

    expect(res.status).toBe(200)
    expect((await res.json() as VoiceTranscript).text).toBe('beta text')
    expect(beta.transcribeCalls[0]!.language).toBe('en')
  })

  test('returns 409 voice/not-ready before assets are installed', async () => {
    const res = await call('POST', '/api/voice/transcribe', makeWav(1))

    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'voice/not-ready' })
  })

  test('returns 404 for an unknown provider', async () => {
    const res = await call('POST', '/api/voice/transcribe?provider=nope', makeWav(1))

    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: 'voice/unknown-provider' })
  })

  test('returns 400 for a language the provider does not offer or a nonsense code', async () => {
    beta.installed = true

    expect((await call('POST', '/api/voice/transcribe?provider=beta&language=ja', makeWav(1))).status).toBe(400)
    expect((await call('POST', '/api/voice/transcribe?provider=beta&language=klingon', makeWav(1))).status).toBe(400)
  })

  test('returns 400 voice/invalid-audio for garbage, empty and over-limit audio', async () => {
    alpha.installed = true

    for (const body of [
      new Uint8Array(200),
      new Uint8Array(0),
      makeWav(VOICE_LIMITS.maxAudioSeconds + 1),
      new Uint8Array(VOICE_LIMITS.maxAudioBytes + 1),
    ]) {
      const res = await call('POST', '/api/voice/transcribe', body)
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({ error: 'voice/invalid-audio' })
    }
    expect(alpha.transcribeCalls).toHaveLength(0)
  })

  test('returns 500 voice/failed when the provider throws', async () => {
    alpha.installed = true
    alpha.transcribeError = new Error('worker crashed')

    const res = await call('POST', '/api/voice/transcribe', makeWav(1))

    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ error: 'voice/failed', message: expect.stringContaining('worker crashed') })
  })
})

describe('transcribe over a real HTTP server', () => {
  const servers: Array<ReturnType<typeof Bun.serve>> = []
  afterAll(() => {
    for (const server of servers) void server.stop(true)
  })

  function serve() {
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        const url = new URL(req.url)
        return handleVoiceApi(req, url, url.pathname.split('/').filter(Boolean), service)
      },
    })
    servers.push(server)
    return `http://127.0.0.1:${server.port}`
  }

  test('round-trips a near-limit binary body and rejects an oversized chunked body', async () => {
    alpha.installed = true
    const base = serve()

    // 120 s of audio is 3.84 MB, above the 4 MB default some frameworks cap at.
    const wav = makeWav(VOICE_LIMITS.maxAudioSeconds)
    const ok = await fetch(`${base}/api/voice/transcribe`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav })
    expect(ok.status).toBe(200)
    expect(alpha.transcribeCalls[0]!.bytes).toBe(wav.byteLength)

    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(VOICE_LIMITS.maxAudioBytes))
        controller.enqueue(new Uint8Array(1024))
        controller.close()
      },
    })
    const rejected = await fetch(`${base}/api/voice/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: oversized,
      duplex: 'half',
    } as RequestInit)
    expect(rejected.status).toBe(400)
    expect(await rejected.json()).toMatchObject({ error: 'voice/invalid-audio' })
  })
})
