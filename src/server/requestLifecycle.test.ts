import { describe, expect, it } from 'bun:test'
import { settleResponseOnRequestAbort } from './requestLifecycle'

describe('settleResponseOnRequestAbort', () => {
  it('releases the server request when the client disconnects', async () => {
    const controller = new AbortController()
    const request = new Request('http://127.0.0.1/api/status', {
      signal: controller.signal,
    })
    const pending = new Promise<Response>(() => undefined)

    const responsePromise = settleResponseOnRequestAbort(request, pending)
    controller.abort()

    const response = await responsePromise
    expect(response.status).toBe(499)
  })

  it('returns completed responses and removes its abort listener', async () => {
    const controller = new AbortController()
    const request = new Request('http://127.0.0.1/api/status', {
      signal: controller.signal,
    })
    let added = 0
    let removed = 0
    const originalAdd = request.signal.addEventListener.bind(request.signal)
    const originalRemove = request.signal.removeEventListener.bind(request.signal)
    request.signal.addEventListener = ((...args: Parameters<AbortSignal['addEventListener']>) => {
      added += 1
      return originalAdd(...args)
    }) as AbortSignal['addEventListener']
    request.signal.removeEventListener = ((...args: Parameters<AbortSignal['removeEventListener']>) => {
      removed += 1
      return originalRemove(...args)
    }) as AbortSignal['removeEventListener']

    const response = await settleResponseOnRequestAbort(
      request,
      Promise.resolve(Response.json({ ok: true })),
    )

    expect(response.status).toBe(200)
    expect(added).toBe(1)
    expect(removed).toBe(1)
  })
})
