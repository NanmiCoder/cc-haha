import { expect, spyOn, test } from 'bun:test'
import { ApiClient, type FetchAdapter } from './client'
import { loadVoiceCatalog, transcribeVoice, type VoiceCatalog } from './voiceApi'

const host = { id: 'fixture', name: 'Computer', url: 'https://voice.fixture.invalid', auth: 'remote' as const }
const catalog: VoiceCatalog = {
  supported: true,
  providers: [{
    info: { id: 'sensevoice-local', name: 'SenseVoice', location: 'local', languages: ['auto', 'zh'], downloadBytes: 1_000_000 },
    preparation: { phase: 'ready' },
  }],
  preferences: { enabled: true, providerId: 'sensevoice-local', language: 'auto', downloadSource: 'mirror' },
  limits: { maxAudioSeconds: 120, maxAudioBytes: 4 * 1024 * 1024 },
}
const transcript = { text: '语音转写内容', audioSeconds: 2.5, inferenceSeconds: 0.4 }
const response = (value: unknown, status = 200) => ({
  ok: status >= 200 && status < 300, status, redirected: false, url: '',
  text: async () => JSON.stringify(value),
})

test('catalog preserves the server preparation, preferences, and upload limits with host credentials', async () => {
  const fetch: FetchAdapter = async (url, init) => {
    expect(url).toBe(`${host.url}/api/voice/catalog`)
    expect(init.method).toBe('GET')
    expect(init.body).toBeUndefined()
    expect(init.headers).toMatchObject({ Authorization: 'Bearer fixture-token', Origin: host.url })
    return response(catalog)
  }
  expect(await loadVoiceCatalog(new ApiClient(host, 'fixture-token', { fetch }))).toEqual(catalog)
})

test('transcription sends raw WAV with encoded provider/language and a cold-start timeout rather than the JSON timeout', async () => {
  const bytes = new Uint8Array([82, 73, 70, 70, 1, 2])
  const timeouts: number[] = []
  const setTimeout = globalThis.setTimeout
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: TimerHandler, timeout?: number, ...args: unknown[]) => {
    timeouts.push(timeout ?? 0)
    return setTimeout(callback, timeout, ...args)
  }) as typeof globalThis.setTimeout)
  try {
    const fetch: FetchAdapter = async (url, init) => {
      const target = new URL(url)
      expect(target.pathname).toBe('/api/voice/transcribe')
      expect(target.searchParams.get('provider')).toBe('provider /+?')
      expect(target.searchParams.get('language')).toBe('zh')
      expect(init.method).toBe('POST')
      expect(init.headers['Content-Type']).toBe('audio/wav')
      expect(init.headers.Authorization).toBe('Bearer fixture-token')
      expect(init.headers.Origin).toBe(host.url)
      expect(Array.from(new Uint8Array(init.body as ArrayBuffer))).toEqual(Array.from(bytes))
      return response(transcript)
    }
    const client = new ApiClient(host, 'fixture-token', { fetch, timeoutMs: 1 })
    expect(await transcribeVoice(client, bytes, { providerId: 'provider /+?', language: 'zh' })).toEqual(transcript)
    // Waiting for the answer and reading its body both keep the cold-start budget.
    expect(timeouts).toEqual([240_000, 240_000])
  } finally { timer.mockRestore() }
})

test('omitted voice overrides use the server preferences, without updating or preparing them', async () => {
  const calls: string[] = []
  const fetch: FetchAdapter = async (url) => {
    calls.push(url)
    return response(transcript)
  }
  const client = new ApiClient(host, 'fixture', { fetch })
  expect(await transcribeVoice(client, new Uint8Array([1]), {})).toEqual(transcript)
  expect(calls).toEqual([`${host.url}/api/voice/transcribe`])
})

test('voice API keeps server failure codes and supports cancellation before recording upload', async () => {
  const client = new ApiClient(host, 'fixture', {
    fetch: async () => response({ error: 'voice/not-ready', message: '尚未准备语音模型' }, 409),
  })
  await expect(transcribeVoice(client, new Uint8Array([1]), {})).rejects.toMatchObject({
    status: 409, code: 'voice/not-ready', message: '尚未准备语音模型',
  })
  const controller = new AbortController()
  controller.abort()
  await expect(loadVoiceCatalog(client, controller.signal)).rejects.toMatchObject({ code: 'ABORTED' })
  await expect(transcribeVoice(client, new Uint8Array([1]), { signal: controller.signal })).rejects.toMatchObject({ code: 'ABORTED' })
})

test('a configurable transcription timeout aborts the actual upload transport', async () => {
  let aborted = false
  const fetch: FetchAdapter = async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      aborted = true
      reject(new Error('timeout'))
    }, { once: true })
  })
  await expect(transcribeVoice(new ApiClient(host, 'fixture', { fetch }), new Uint8Array([1]), { timeoutMs: 5 })).rejects.toMatchObject({ code: 'TIMEOUT' })
  expect(aborted).toBe(true)
})
