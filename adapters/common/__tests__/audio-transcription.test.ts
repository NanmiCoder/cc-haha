import { afterEach, describe, expect, it, mock } from 'bun:test'
import { AdapterHttpClient } from '../http-client.js'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

describe('IM audio transcription through the local server', () => {
  it('sends bounded WAV bytes using local authentication and returns the transcript', async () => {
    const client = new AdapterHttpClient('ws://127.0.0.1:3456', { localAccessToken: 'fixture-token' })
    globalThis.fetch = mock(async (input, init) => {
      expect(String(input)).toBe('http://127.0.0.1:3456/api/voice/transcribe')
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer fixture-token')
      expect(new Headers(init?.headers).get('Content-Type')).toBe('audio/wav')
      expect(init?.redirect).toBe('error')
      expect(Buffer.from(init?.body as Uint8Array).toString()).toBe('wav fixture')
      return Response.json({ text: '转写结果', audioSeconds: 1 })
    }) as unknown as typeof fetch
    expect(await client.transcribeAudio(Buffer.from('wav fixture'))).toBe('转写结果')
  })
  it('rejects oversized input before fetch and propagates cancellation', async () => {
    const client = new AdapterHttpClient('ws://127.0.0.1:3456', { localAccessToken: 'fixture-token' })
    let calls = 0
    globalThis.fetch = mock(async (_input, init) => {
      calls++
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
      })
    }) as unknown as typeof fetch
    await expect(client.transcribeAudio(Buffer.alloc(4 * 1024 * 1024 + 1))).rejects.toThrow('4 MiB')
    expect(calls).toBe(0)
    const controller = new AbortController()
    const request = client.transcribeAudio(Buffer.from('wav'), controller.signal)
    controller.abort()
    await expect(request).rejects.toThrow('cancelled')
  })
  it('surfaces missing recognizer and malformed responses instead of inventing a transcript', async () => {
    const client = new AdapterHttpClient('ws://127.0.0.1:3456', { localAccessToken: 'fixture-token' })
    globalThis.fetch = mock(async () => Response.json({ message: 'not ready' }, { status: 409 })) as unknown as typeof fetch
    await expect(client.transcribeAudio(Buffer.from('wav'))).rejects.toThrow('409')
    globalThis.fetch = mock(async () => Response.json({ text: 4 })) as unknown as typeof fetch
    await expect(client.transcribeAudio(Buffer.from('wav'))).rejects.toThrow('无效结果')
  })
})
