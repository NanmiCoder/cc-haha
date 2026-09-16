import { describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { createSandboxedTestEnvironment } from '../../../scripts/pr/test-environment.js'
import type { FilesApiConfig } from './filesApi.js'

type RecordedRequest = {
  method: string
  url: URL
  headers: Headers
  body: string
}

const basePaths = [
  ['', ''],
  ['/v1', ''],
  ['/v1/', ''],
  ['/anthropic', '/anthropic'],
  ['/anthropic/v1/', '/anthropic'],
  ['/v1/tenant', '/v1/tenant'],
  ['/proxy/providers/provider-1', '/proxy/providers/provider-1'],
] as const

async function withFilesApi(
  run: (fixture: {
    api: typeof import('./filesApi.js')
    origin: string
    requests: RecordedRequest[]
    uploadPath: string
    config: FilesApiConfig
  }) => Promise<void>,
): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'files-api-base-url-'))
  const previousEnv = { ...process.env }
  const env = createSandboxedTestEnvironment(tempDir)
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, env)
  const requests: RecordedRequest[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      requests.push({ method: request.method, url, headers: request.headers, body: await request.text() })
      if (request.method === 'POST') return Response.json({ id: 'file-uploaded' }, { status: 201 })
      if (url.pathname.endsWith('/content')) return new Response('downloaded content')
      const secondPage = url.searchParams.has('after_id')
      return Response.json({
        data: [{ id: secondPage ? 'file-2' : 'file-1', filename: secondPage ? 'two.txt' : 'one.txt', size_bytes: 7 }],
        has_more: !secondPage,
      })
    },
  })

  try {
    const uploadPath = path.join(tempDir, 'upload.txt')
    await fs.writeFile(uploadPath, 'upload fixture content')
    await run({
      api: await import('./filesApi.js'),
      origin: server.url.origin,
      requests,
      uploadPath,
      config: { oauthToken: 'fake-files-oauth-token', sessionId: 'test-files-session' },
    })
  } finally {
    server.stop(true)
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, previousEnv)
    await fs.rm(tempDir, { recursive: true, force: true })
  }
}

function expectFilesAuth(requests: RecordedRequest[]): void {
  for (const request of requests) {
    expect(request.headers.get('authorization')).toBe('Bearer fake-files-oauth-token')
    expect(request.headers.get('anthropic-version')).toBe('2023-06-01')
    expect(request.headers.get('anthropic-beta')).toBe('files-api-2025-04-14,oauth-2025-04-20')
  }
}

describe('Files API base URL compatibility', () => {
  test('downloads with one API version while preserving gateway prefixes and authentication', async () => {
    await withFilesApi(async ({ api, origin, requests, config }) => {
      for (const [basePath, prefix] of basePaths) {
        requests.length = 0
        const content = await api.downloadFile('file-1', { ...config, baseUrl: `${origin}${basePath}` })

        expect(content.toString()).toBe('downloaded content')
        expect(requests.map(request => [request.method, request.url.href])).toEqual([
          ['GET', `${origin}${prefix}/v1/files/file-1/content`],
        ])
        expectFilesAuth(requests)
      }
    })
  })

  test('uploads with one API version and preserves the multipart payload', async () => {
    await withFilesApi(async ({ api, origin, requests, config, uploadPath }) => {
      for (const [basePath, prefix] of basePaths) {
        requests.length = 0
        const result = await api.uploadFile(uploadPath, 'folder/report.txt', { ...config, baseUrl: `${origin}${basePath}` })

        expect(result).toEqual({ path: 'folder/report.txt', fileId: 'file-uploaded', size: 22, success: true })
        expect(requests.map(request => [request.method, request.url.href])).toEqual([
          ['POST', `${origin}${prefix}/v1/files`],
        ])
        expect(requests[0]!.headers.get('content-type')).toStartWith('multipart/form-data; boundary=')
        expect(requests[0]!.body).toContain('filename="report.txt"')
        expect(requests[0]!.body).toContain('upload fixture content')
        expect(requests[0]!.body).toContain('name="purpose"\r\n\r\nuser_data')
        expectFilesAuth(requests)
      }
    })
  })

  test('lists every page with one API version and preserves filter and cursor parameters', async () => {
    await withFilesApi(async ({ api, origin, requests, config }) => {
      const afterCreatedAt = '2026-09-08T00:00:00Z'
      for (const [basePath, prefix] of basePaths) {
        requests.length = 0
        const files = await api.listFilesCreatedAfter(afterCreatedAt, { ...config, baseUrl: `${origin}${basePath}` })

        expect(files).toEqual([
          { filename: 'one.txt', fileId: 'file-1', size: 7 },
          { filename: 'two.txt', fileId: 'file-2', size: 7 },
        ])
        expect(requests.map(request => [request.method, request.url.pathname])).toEqual([
          ['GET', `${prefix}/v1/files`],
          ['GET', `${prefix}/v1/files`],
        ])
        expect(requests.map(request => Object.fromEntries(request.url.searchParams))).toEqual([
          { after_created_at: afterCreatedAt },
          { after_created_at: afterCreatedAt, after_id: 'file-1' },
        ])
        expectFilesAuth(requests)
      }
    })
  })

  test('normalizes environment fallback URLs for downloads, uploads, and listing', async () => {
    await withFilesApi(async ({ api, origin, requests, config, uploadPath }) => {
      for (const envKey of ['ANTHROPIC_BASE_URL', 'CLAUDE_CODE_API_BASE_URL']) {
        delete process.env.ANTHROPIC_BASE_URL
        delete process.env.CLAUDE_CODE_API_BASE_URL
        process.env[envKey] = `${origin}/gateway/v1/`
        requests.length = 0
        await api.downloadFile('file-1', config)
        await api.uploadFile(uploadPath, 'report.txt', config)
        await api.listFilesCreatedAfter('2026-09-08T00:00:00Z', config)

        expect(requests.map(request => request.url.pathname)).toEqual([
          '/gateway/v1/files/file-1/content',
          '/gateway/v1/files',
          '/gateway/v1/files',
          '/gateway/v1/files',
        ])
        expect(process.env[envKey]).toBe(`${origin}/gateway/v1/`)
        expectFilesAuth(requests)
      }
    })
  })
})
