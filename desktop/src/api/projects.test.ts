import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import '@testing-library/jest-dom'

const apiPostMock = vi.fn()

vi.mock('./client', () => ({
  api: {
    post: (url: string, body?: unknown) => apiPostMock(url, body),
    get: vi.fn(),
  },
  getApiUrl: (p: string) => `http://test-host${p}`,
  getAuthToken: () => 'test-token',
}))

import { projectsApi } from './projects'

const fetchMock = vi.fn()
beforeEach(() => {
  apiPostMock.mockReset()
  fetchMock.mockReset()
  global.fetch = fetchMock as unknown as typeof fetch
  // jsdom doesn't implement these; stub so the export-download click path
  // doesn't blow up under tests.
  if (typeof URL !== 'undefined') {
    URL.createObjectURL = vi.fn(() => 'blob:mock-url') as unknown as typeof URL.createObjectURL
    URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL
  }
})

afterEach(() => {
  vi.unstubAllGlobals?.()
})

describe('projectsApi.clearSessions', () => {
  it('posts to /api/projects/sessions/clear with workDir in body', async () => {
    apiPostMock.mockResolvedValue({ ok: true, deletedSessions: 3, projectDirRemoved: true })

    const result = await projectsApi.clearSessions('/work/alpha')

    expect(apiPostMock).toHaveBeenCalledTimes(1)
    expect(apiPostMock).toHaveBeenCalledWith('/api/projects/sessions/clear', { workDir: '/work/alpha' })
    expect(result.deletedSessions).toBe(3)
    expect(result.projectDirRemoved).toBe(true)
  })

  it('propagates server errors so the caller can show a toast', async () => {
    apiPostMock.mockRejectedValue(new Error('Forbidden'))
    await expect(projectsApi.clearSessions('/work/beta')).rejects.toThrow('Forbidden')
  })
})

describe('projectsApi.exportSession', () => {
  it('GETs the export endpoint with workDir + sessionId and returns the filename', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      blob: async () => new Blob(['{"a":1}\n'], { type: 'application/x-ndjson' }),
    })

    const result = await projectsApi.exportSession('/work/proj', 'sess-123')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit | undefined]
    expect(url).toContain('/api/projects/sessions/export?')
    expect(url).toContain('workDir=%2Fwork%2Fproj')
    expect(url).toContain('sessionId=sess-123')
    expect((options?.headers as Record<string, string>).Authorization).toBe('Bearer test-token')
    expect(result.filename).toBe('sess-123.jsonl')
    expect(result.bytes).toBeGreaterThan(0)
  })

  it('throws with the server message when the response is not ok', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ message: 'Session not found' }),
    })

    await expect(projectsApi.exportSession('/work/proj', 'missing'))
      .rejects.toThrow('Session not found')
  })
})

describe('projectsApi.importSession', () => {
  it('POSTs multipart with workDir + file and returns the new sessionId', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        sessionId: 'new-uuid',
        projectId: 'work-proj',
        bytes: 16,
        nonEmptyLines: 2,
      }),
    })

    const file = new File(['{"a":1}\n{"a":2}\n'], 'session.jsonl', { type: 'application/x-ndjson' })
    const result = await projectsApi.importSession('/work/proj', file)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit | undefined]
    expect(url).toBe('http://test-host/api/projects/sessions/import')
    expect(options?.method).toBe('POST')
    expect((options?.headers as Record<string, string>).Authorization).toBe('Bearer test-token')
    expect(options?.body).toBeInstanceOf(FormData)
    const form = options!.body as FormData
    expect(form.get('workDir')).toBe('/work/proj')
    expect(form.get('file')).toBeInstanceOf(File)
    expect(result.sessionId).toBe('new-uuid')
    expect(result.nonEmptyLines).toBe(2)
  })

  it('throws with the server message on 400', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ message: 'File is not valid NDJSON' }),
    })

    const blob = new Blob(['garbage'], { type: 'text/plain' })
    await expect(projectsApi.importSession('/work/proj', blob, 'bad.jsonl'))
      .rejects.toThrow('File is not valid NDJSON')
  })
})
