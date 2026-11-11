import { afterEach, expect, it, vi } from 'vitest'
import { RemoteDirectoryPublisher } from './remoteDirectory'

afterEach(() => vi.useRealTimers())
async function advance(ms: number) {
  vi.advanceTimersByTime(ms)
  for (let i = 0; i < 30; i++) await Promise.resolve()
}
function fixture() {
  let sequence = 0
  const request = vi.fn(async (route: string) => route === '/native/announcement'
    ? { version: 2, hostId: 'fixture-host', publicKey: 'fixture-key', origin: 'https://fixture.example', sequence: ++sequence, expiresAt: 123, signature: 'fixture-signature' } : {})
  const fetcher = vi.fn(async () => new Response('{}', { status: 200 }))
  const changed = vi.fn()
  const publisher = new RemoteDirectoryPublisher({ directoryUrl: 'https://directory.example', request: request as never, fetch: fetcher as never, changed })
  return { publisher, request, fetcher, changed }
}
it('publishes the original signed announcement without redirects and refreshes every five minutes', async () => {
  vi.useFakeTimers()
  const f = fixture()
  await f.publisher.start()
  expect(f.request).toHaveBeenNthCalledWith(1, '/native/configure', 'POST', { directoryUrl: 'https://directory.example' })
  const [url, init] = f.fetcher.mock.calls[0] as unknown as [string, RequestInit]
  expect(url).toBe('https://directory.example/v1/hosts/fixture-host')
  expect(init).toMatchObject({ method: 'PUT', redirect: 'error' })
  expect(JSON.parse(init.body as string)).toMatchObject({ sequence: 1, signature: 'fixture-signature' })
  expect(f.changed).toHaveBeenLastCalledWith('ready', 'fixture-host')
  await advance(300_000)
  expect(f.fetcher).toHaveBeenCalledTimes(2)
  f.publisher.stop()
  await advance(600_000)
  expect(f.fetcher).toHaveBeenCalledTimes(2)
})
it('retries directory failures independently and requests a new signed sequence after conflict', async () => {
  vi.useFakeTimers()
  const f = fixture()
  f.fetcher.mockResolvedValueOnce(new Response('{}', { status: 409 }))
  await f.publisher.start()
  expect(f.changed).toHaveBeenLastCalledWith('retrying')
  await advance(1000)
  expect(f.fetcher).toHaveBeenCalledTimes(2)
  expect(JSON.parse((f.fetcher.mock.calls[1] as unknown as [string, RequestInit])[1].body as string).sequence).toBe(2)
  f.publisher.stop()
})
it('does not let a late response restart publication after stop', async () => {
  vi.useFakeTimers()
  const f = fixture()
  let finish!: (value: Response) => void
  f.fetcher.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const started = f.publisher.start()
  await advance(0)
  f.publisher.stop()
  finish(new Response('{}'))
  await started
  expect(f.changed).not.toHaveBeenCalledWith('ready', expect.anything())
  await advance(600_000)
  expect(f.fetcher).toHaveBeenCalledTimes(1)
})
it('clears backend discovery configuration for an undeployed directory and never contacts the network', async () => {
  const request = vi.fn(async () => ({}))
  const fetcher = vi.fn()
  const changed = vi.fn()
  const publisher = new RemoteDirectoryPublisher({ directoryUrl: '', request: request as never, fetch: fetcher as never, changed })
  await publisher.start()
  expect(request).toHaveBeenCalledWith('/native/configure', 'POST', { directoryUrl: '' })
  expect(changed).toHaveBeenLastCalledWith('unconfigured')
  expect(fetcher).not.toHaveBeenCalled()
  publisher.stop()
})
it('rejects a directory URL with credentials, path or non-HTTPS scheme without sending it to the backend', async () => {
  for (const directoryUrl of ['http://directory.example', 'https://user:secret@directory.example', 'https://directory.example/path']) {
    const request = vi.fn()
    const changed = vi.fn()
    const publisher = new RemoteDirectoryPublisher({ directoryUrl, request: request as never, changed })
    await publisher.start()
    expect(request).not.toHaveBeenCalled()
    expect(changed).toHaveBeenLastCalledWith('retrying')
    publisher.stop()
  }
})
