import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { SessionService } from '../services/sessionService.js'
import { isLocalAccessAuthorized } from '../localAccessAuth.js'
import {
  clearFilesystemAccessRootsForTests,
  registerFilesystemAccessRoot,
} from '../services/filesystemAccessRoots.js'
import { downloadWorkspaceFile } from '../../../mobile/src/core/workspaceDownload.js'

const TOKEN = 'workspace-download-fixture-only'
const LIMIT = 20 * 1024 * 1024
const BINARY = Buffer.from([0, 255, 254, 195, 40, 13, 10, 0])
let directory: string
let workDir: string
let sessionId: string
let baseUrl: string
let server: ReturnType<typeof Bun.serve> | undefined
let previousConfig: string | undefined
let previousToken: string | undefined

beforeEach(async () => {
  previousConfig = process.env.CLAUDE_CONFIG_DIR
  previousToken = process.env.CC_HAHA_LOCAL_ACCESS_TOKEN
  clearFilesystemAccessRootsForTests()
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-download-'))
  process.env.CLAUDE_CONFIG_DIR = path.join(directory, 'config')
  process.env.CC_HAHA_LOCAL_ACCESS_TOKEN = TOKEN
  await fs.mkdir(path.join(process.env.CLAUDE_CONFIG_DIR, 'projects'), { recursive: true })
  workDir = path.join(directory, 'work')
  await fs.mkdir(workDir)
  const { handleApiRequest } = await import('../router.js')
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      if (!isLocalAccessAuthorized(request)) return new Response(null, { status: 401 })
      return handleApiRequest(request, new URL(request.url))
    },
  })
  baseUrl = `http://127.0.0.1:${server.port}`
  sessionId = (await new SessionService().createSession(workDir)).sessionId
})

afterEach(async () => {
  server?.stop(true)
  clearFilesystemAccessRootsForTests()
  if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfig
  if (previousToken === undefined) delete process.env.CC_HAHA_LOCAL_ACCESS_TOKEN
  else process.env.CC_HAHA_LOCAL_ACCESS_TOKEN = previousToken
  await fs.rm(directory, { recursive: true, force: true })
})

function request(filePath: string | null, resource = 'download', method = 'GET') {
  const query = filePath === null ? '' : `?path=${encodeURIComponent(filePath)}`
  return fetch(`${baseUrl}/api/sessions/${sessionId}/workspace/${resource}${query}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}` },
  })
}

describe('explicit workspace attachment download', () => {
  it('connects the production mobile downloader to the production route without truncating text', async () => {
    const text = '原始输出\r\n'.repeat(120_000)
    const fileName = '完整 输出 & final.txt'
    await fs.writeFile(path.join(workDir, fileName), text)
    const result = await downloadWorkspaceFile(
      { id: 'fixture', name: 'Fixture', url: baseUrl, auth: 'lan' },
      TOKEN,
      sessionId,
      fileName,
      fetch,
    )
    expect(Buffer.from(result.bytes).equals(Buffer.from(text))).toBe(true)
    expect(result.name).toBe(fileName)
    expect(result.bytes.byteLength).toBeGreaterThan(1024 * 1024)
  })

  it('returns exact binary bytes as a non-cacheable attachment while raw preview stays restricted', async () => {
    await fs.writeFile(path.join(workDir, 'data.bin'), BINARY)
    const result = await request('data.bin')
    expect(result.status).toBe(200)
    expect(result.headers.get('content-type')).toBe('application/octet-stream')
    expect(result.headers.get('content-disposition')).toContain('attachment;')
    expect(result.headers.get('cache-control')).toBe('private, no-store')
    expect(result.headers.get('x-content-type-options')).toBe('nosniff')
    expect(Buffer.from(await result.arrayBuffer()).equals(BINARY)).toBe(true)
    for (const name of ['notes.txt', 'photo.png']) {
      await fs.writeFile(path.join(workDir, name), BINARY)
      expect((await request(name, 'raw')).status).toBe(415)
      expect((await request(name)).status).toBe(200)
    }
  })

  it('allows exactly 20 MiB and rejects a larger original file', async () => {
    await fs.writeFile(path.join(workDir, 'large.bin'), '')
    await fs.truncate(path.join(workDir, 'large.bin'), LIMIT)
    const boundary = await request('large.bin')
    expect(boundary.status).toBe(200)
    expect((await boundary.arrayBuffer()).byteLength).toBe(LIMIT)
    await fs.truncate(path.join(workDir, 'large.bin'), LIMIT + 1)
    const tooLarge = await request('large.bin')
    expect(tooLarge.status).toBe(413)
    expect(await tooLarge.json()).toMatchObject({ error: 'PAYLOAD_TOO_LARGE' })
  })

  it('keeps authentication, path, file existence and method requirements', async () => {
    expect((await fetch(`${baseUrl}/api/sessions/${sessionId}/workspace/download?path=x`)).status).toBe(401)
    expect((await request(null)).status).toBe(400)
    expect((await request('missing.txt')).status).toBe(404)
    expect((await request('.')).status).toBe(404)
    expect((await request('anything.txt', 'download', 'POST')).status).toBe(405)
    await fs.writeFile(path.join(directory, 'outside.txt'), 'outside fixture')
    for (const requested of ['../outside.txt', path.join(directory, 'outside.txt')]) {
      expect((await request(requested)).status).toBe(403)
    }
  })

  it('blocks credential/config paths even inside an authorized workspace', async () => {
    for (const name of ['.env', '.env.production', '.ssh/id_ed25519', '.claude/settings.json', '.git/config', 'credentials.json', 'private.pem']) {
      await fs.mkdir(path.dirname(path.join(workDir, name)), { recursive: true })
      await fs.writeFile(path.join(workDir, name), 'fake secret fixture')
      expect((await request(name)).status).toBe(403)
    }
  })

  it.skipIf(process.platform === 'win32')('checks both symlink boundary and the canonical credential name', async () => {
    await fs.writeFile(path.join(directory, 'outside.txt'), BINARY)
    await fs.writeFile(path.join(workDir, '.env'), 'fake secret fixture')
    await fs.writeFile(path.join(workDir, 'report.txt'), BINARY)
    await fs.symlink(path.join(directory, 'outside.txt'), path.join(workDir, 'escape.txt'))
    await fs.symlink(path.join(workDir, '.env'), path.join(workDir, 'alias.txt'))
    await fs.symlink(path.join(workDir, 'report.txt'), path.join(workDir, 'allowed.txt'))
    expect((await request('escape.txt')).status).toBe(403)
    expect((await request('alias.txt')).status).toBe(403)
    expect(Buffer.from(await (await request('allowed.txt')).arrayBuffer()).equals(BINARY)).toBe(true)
  })

  it('keeps the existing registered outside-root contract without bypassing secret checks', async () => {
    const outside = path.join(directory, 'deliverables')
    await fs.mkdir(outside)
    await fs.writeFile(path.join(outside, 'report.bin'), BINARY)
    await fs.writeFile(path.join(outside, '.env'), 'fake secret fixture')
    registerFilesystemAccessRoot(outside)
    expect(Buffer.from(await (await request(path.join(outside, 'report.bin'))).arrayBuffer()).equals(BINARY)).toBe(true)
    expect((await request(path.join(outside, '.env'))).status).toBe(403)
    expect((await request('../deliverables/report.bin')).status).toBe(403)
  })
})
