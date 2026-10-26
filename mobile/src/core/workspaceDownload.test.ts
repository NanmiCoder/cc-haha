import { expect, test } from 'bun:test'
import { downloadWorkspaceFile, exportFileName } from './workspaceDownload'
const host = {
  id: 'a',
  name: 'A',
  url: 'http://127.0.0.1:3457',
  auth: 'lan' as const,
}
test('file downloads keep authentication on the pinned desktop and encode workspace paths', async () => {
  const controller = new AbortController()
  const result = await downloadWorkspaceFile(
    host,
    'fake-token',
    's',
    'a & b.md',
    async (input, init) => {
      const url = new URL(String(input))
      expect(url.origin).toBe(host.url)
      expect(url.pathname).toBe('/api/sessions/s/workspace/download')
      expect(url.searchParams.get('path')).toBe('a & b.md')
      expect(init?.redirect).toBe('error')
      expect(init?.credentials).toBe('omit')
      expect(init.signal).toBe(controller.signal)
      expect(new Headers(init?.headers).get('Authorization')).toBe(
        'Bearer fake-token'
      )
      return new Response('hello', {
        headers: { 'content-type': 'text/markdown' },
      })
    },
    controller.signal
  )
  expect(new TextDecoder().decode(result.bytes)).toBe('hello')
  expect(result.name).toBe('a & b.md')
})
test('remote downloads preserve original binary bytes and send the paired origin', async () => {
  const bytes = new Uint8Array([0, 255, 254, 195, 40, 13, 10])
  const result = await downloadWorkspaceFile(
    { ...host, auth: 'remote', url: 'https://paired.example' },
    'fake-native-token',
    'session',
    'data.bin',
    async (_url, init) => {
      const headers = new Headers(init.headers)
      expect(headers.get('Origin')).toBe('https://paired.example')
      expect(headers.get('Authorization')).toBe('Bearer fake-native-token')
      return new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } })
    }
  )
  expect(result.bytes).toEqual(bytes)
  expect(result.mimeType).toBe('application/octet-stream')
})
test('a streamed response exceeding the cap is cancelled even if Content-Length lies', async () => {
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(10 * 1024 * 1024))
      controller.enqueue(new Uint8Array(10 * 1024 * 1024 + 1))
    },
    cancel() { cancelled = true },
  })
  await expect(downloadWorkspaceFile(host, 'fake-token', 's', 'growing.bin', async () =>
    new Response(stream, { headers: { 'content-length': '1' } })
  )).rejects.toThrow('20 MB')
  expect(cancelled).toBe(true)
})
test('redirects and oversized responses are never saved', async () => {
  await expect(
    downloadWorkspaceFile(
      host,
      'fake-token',
      's',
      'a',
      async () =>
        new Response('', {
          status: 302,
          headers: { location: 'https://other.invalid' },
        })
    )
  ).rejects.toThrow('重定向')
  await expect(
    downloadWorkspaceFile(
      host,
      'fake-token',
      's',
      'a',
      async () =>
        new Response('x', {
          headers: { 'content-length': String(21 * 1024 * 1024) },
        })
    )
  ).rejects.toThrow('20 MB')
})
test('export names cannot escape the cache directory', () => {
  expect(exportFileName('../../bad:name.txt')).toBe('bad_name.txt')
  expect(exportFileName('..')).toBe('cc-haha-file')
})
