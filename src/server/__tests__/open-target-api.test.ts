import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { handleOpenTargetsApi } from '../api/open-targets.js'
import { openTargetService } from '../services/openTargetService.js'

let listTargetsSpy: ReturnType<typeof spyOn> | undefined
let openTargetSpy: ReturnType<typeof spyOn> | undefined
let getTargetIconSpy: ReturnType<typeof spyOn> | undefined

function makeRequest(
  method: string,
  urlStr: string,
  body?: Record<string, unknown> | string,
): { req: Request; url: URL; segments: string[] } {
  const url = new URL(urlStr, 'http://localhost:3456')
  const init: RequestInit = { method }
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = typeof body === 'string' ? body : JSON.stringify(body)
  }
  const req = new Request(url.toString(), init)
  return {
    req,
    url,
    segments: url.pathname.split('/').filter(Boolean),
  }
}

describe('open-targets API', () => {
  afterEach(() => {
    listTargetsSpy?.mockRestore()
    listTargetsSpy = undefined
    openTargetSpy?.mockRestore()
    openTargetSpy = undefined
    getTargetIconSpy?.mockRestore()
    getTargetIconSpy = undefined
  })

  it('returns detected targets from GET /api/open-targets', async () => {
    listTargetsSpy = spyOn(openTargetService, 'listTargets').mockResolvedValue({
      platform: 'darwin',
      targets: [
        { id: 'vscode', kind: 'ide', label: 'VS Code', icon: 'vscode', platform: 'darwin' },
      ],
      primaryTargetId: 'vscode',
      cachedAt: 123,
      ttlMs: 1_000,
    })

    const { req, url, segments } = makeRequest('GET', '/api/open-targets')
    const res = await handleOpenTargetsApi(req, url, segments)

    expect(res.status).toBe(200)
    expect(listTargetsSpy).toHaveBeenCalledTimes(1)
    await expect(res.json()).resolves.toMatchObject({
      platform: 'darwin',
      primaryTargetId: 'vscode',
      targets: [{ id: 'vscode', kind: 'ide' }],
    })
  })

  it('opens an allowed target from POST /api/open-targets/open', async () => {
    openTargetSpy = spyOn(openTargetService, 'openTarget').mockResolvedValue({
      ok: true,
      targetId: 'vscode',
      path: '/Users/nanmi/project',
    })

    const { req, url, segments } = makeRequest('POST', '/api/open-targets/open', {
      targetId: 'vscode',
      path: '/Users/nanmi/project',
    })
    const res = await handleOpenTargetsApi(req, url, segments)

    expect(res.status).toBe(200)
    expect(openTargetSpy).toHaveBeenCalledWith({
      targetId: 'vscode',
      path: '/Users/nanmi/project',
    })
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      targetId: 'vscode',
      path: '/Users/nanmi/project',
    })
  })

  it('rejects invalid request bodies before opening', async () => {
    openTargetSpy = spyOn(openTargetService, 'openTarget')

    const { req, url, segments } = makeRequest('POST', '/api/open-targets/open', { targetId: 'vscode' })
    const res = await handleOpenTargetsApi(req, url, segments)

    expect(res.status).toBe(400)
    expect(openTargetSpy).not.toHaveBeenCalled()
    await expect(res.json()).resolves.toMatchObject({
      error: 'BAD_REQUEST',
      message: 'Missing or invalid "path" in request body',
    })
  })

  it('rejects invalid JSON bodies', async () => {
    const { req, url, segments } = makeRequest('POST', '/api/open-targets/open', '{not json')
    const res = await handleOpenTargetsApi(req, url, segments)

    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toMatchObject({
      error: 'BAD_REQUEST',
      message: 'Invalid JSON body',
    })
  })

  it('returns a target icon as cacheable PNG', async () => {
    getTargetIconSpy = spyOn(openTargetService, 'getTargetIcon').mockResolvedValue({
      contentType: 'image/png',
      data: new Uint8Array([1, 2, 3]),
    })

    const { req, url, segments } = makeRequest('GET', '/api/open-targets/icons/vscode')
    const res = await handleOpenTargetsApi(req, url, segments)

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/png')
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=86400')
    expect(getTargetIconSpy).toHaveBeenCalledWith('vscode')
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual([1, 2, 3])
  })
})
