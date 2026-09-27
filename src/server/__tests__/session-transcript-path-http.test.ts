/**
 * Route-level contract for `/api/sessions/:id/transcript-path`.
 *
 * The sidebar's "copy session path" action hands the user a path to paste into
 * a shell, so the route must answer with the transcript file the server would
 * actually read — including when the projects directory has been relocated via
 * `CLAUDE_CONFIG_DIR`. Re-deriving the path in the renderer is exactly the bug
 * this route exists to avoid, so the assertions pin the resolved path rather
 * than a shape.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { handleApiRequest } from '../router.js'

let tmpDir: string
let previousConfig: string | undefined

const SESSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const PROJECT_DIR = '-tmp-transcript-path'

async function api(method: string, pathname: string): Promise<Response> {
  const url = new URL(pathname, 'http://localhost:3456')
  return handleApiRequest(new Request(url.toString(), { method }), url)
}

async function seedSession(): Promise<string> {
  const filePath = path.join(tmpDir, 'projects', PROJECT_DIR, `${SESSION_ID}.jsonl`)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, `${JSON.stringify({
    type: 'user',
    uuid: crypto.randomUUID(),
    timestamp: '2026-01-01T00:00:00.000Z',
    message: { role: 'user', content: 'hello' },
  })}\n`, 'utf-8')
  return filePath
}

beforeEach(async () => {
  previousConfig = process.env.CLAUDE_CONFIG_DIR
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-transcript-path-'))
  process.env.CLAUDE_CONFIG_DIR = tmpDir
})

afterEach(async () => {
  if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfig
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('session transcript path HTTP surface', () => {
  it('returns the absolute path of the session transcript', async () => {
    const filePath = await seedSession()

    const response = await api('GET', `/api/sessions/${SESSION_ID}/transcript-path`)

    expect(response.status).toBe(200)
    const body = await response.json() as { filePath: string }
    expect(body.filePath).toBe(filePath)
    expect(path.isAbsolute(body.filePath)).toBe(true)
  })

  it('answers 404 for a session with no transcript on disk', async () => {
    const response = await api('GET', '/api/sessions/11111111-2222-3333-4444-555555555555/transcript-path')

    expect(response.status).toBe(404)
  })

  it('rejects non-GET methods', async () => {
    await seedSession()

    const response = await api('POST', `/api/sessions/${SESSION_ID}/transcript-path`)

    expect(response.status).toBe(405)
  })
})
