import { describe, it, expect, mock, beforeEach } from 'bun:test'
import * as path from 'path'

const MOCK_CLAUDE_HOME = path.join('/mock', 'home', '.claude')
const MOCK_PROJECTS_DIR = path.join(MOCK_CLAUDE_HOME, 'projects')

mock.module('../../utils/envUtils.js', () => ({
  getClaudeConfigHomeDir: () => MOCK_CLAUDE_HOME,
}))

mock.module('../../utils/path.js', () => ({
  sanitizePath: (p: string) => p.replace(/[\\/:]/g, '-').replace(/^-+/, ''),
}))

mock.module('../services/projectActivityService.js', () => ({
  getRecentActivity: async () => ({ items: [] }),
}))

const fileContents = new Map<string, string>()
const dirCreated = new Set<string>()

mock.module('fs/promises', () => ({
  readFile: async (filePath: string) => {
    const content = fileContents.get(path.resolve(filePath))
    if (content === undefined) {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    }
    return Buffer.from(content, 'utf-8')
  },
  writeFile: async (filePath: string, content: string) => {
    fileContents.set(path.resolve(filePath), content)
  },
  mkdir: async (dirPath: string) => {
    dirCreated.add(path.resolve(dirPath))
  },
}))

import { handleProjectsApi } from '../api/projects'

beforeEach(() => {
  fileContents.clear()
  dirCreated.clear()
})

function workDirFor(name: string): string {
  return path.join(path.sep, 'work', name)
}

function projectIdFor(workDir: string): string {
  // Match the sanitizePath stub above.
  return workDir.replace(/[\\/:]/g, '-').replace(/^-+/, '')
}

describe('GET /api/projects/sessions/export', () => {
  async function call(query: Record<string, string>): Promise<Response> {
    const u = new URL('http://localhost/api/projects/sessions/export')
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v)
    return handleProjectsApi(new Request(u, { method: 'GET' }), u, ['api', 'projects', 'sessions', 'export'])
  }

  it('returns the jsonl content with attachment headers', async () => {
    const wd = workDirFor('alpha')
    const id = 'abc-123'
    const filePath = path.resolve(path.join(MOCK_PROJECTS_DIR, projectIdFor(wd), `${id}.jsonl`))
    fileContents.set(filePath, '{"role":"user","content":"hi"}\n')

    const res = await call({ workDir: wd, sessionId: id })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/x-ndjson')
    expect(res.headers.get('Content-Disposition')).toContain(`${id}.jsonl`)
    const text = await res.text()
    expect(text).toContain('"role":"user"')
  })

  it('rejects missing sessionId', async () => {
    expect((await call({ workDir: workDirFor('a') })).status).toBe(400)
  })

  it('rejects missing/relative workDir', async () => {
    expect((await call({ sessionId: 'x' })).status).toBe(400)
    expect((await call({ workDir: 'relative', sessionId: 'x' })).status).toBe(400)
  })

  it('rejects sessionId with path separator', async () => {
    expect((await call({ workDir: workDirFor('a'), sessionId: '../escape' })).status).toBe(400)
    expect((await call({ workDir: workDirFor('a'), sessionId: 'a/b' })).status).toBe(400)
  })

  it('returns 404 when the session file does not exist', async () => {
    const res = await call({ workDir: workDirFor('alpha'), sessionId: 'missing-id' })
    expect(res.status).toBe(404)
  })

  it('POST returns 405', async () => {
    const u = new URL('http://localhost/api/projects/sessions/export')
    const res = await handleProjectsApi(new Request(u, { method: 'POST' }), u, ['api', 'projects', 'sessions', 'export'])
    expect(res.status).toBe(405)
  })
})

describe('POST /api/projects/sessions/import', () => {
  function call(form: FormData): Promise<Response> {
    const u = new URL('http://localhost/api/projects/sessions/import')
    return handleProjectsApi(new Request(u, { method: 'POST', body: form }), u, ['api', 'projects', 'sessions', 'import'])
  }

  it('writes uploaded jsonl to a fresh session id under the project', async () => {
    const wd = workDirFor('beta')
    const ndjson = '{"a":1}\n{"a":2}\n'
    const form = new FormData()
    form.set('workDir', wd)
    form.set('file', new Blob([ndjson], { type: 'application/x-ndjson' }), 'session.jsonl')

    const res = await call(form)
    expect(res.status).toBe(200)
    const data = await res.json() as { ok: boolean; sessionId: string; projectId: string; nonEmptyLines: number }
    expect(data.ok).toBe(true)
    expect(data.sessionId).toMatch(/^[0-9a-f-]+$/)
    expect(data.nonEmptyLines).toBe(2)
    expect(data.projectId).toBe(projectIdFor(wd))

    const expectedPath = path.resolve(path.join(MOCK_PROJECTS_DIR, projectIdFor(wd), `${data.sessionId}.jsonl`))
    expect(fileContents.get(expectedPath)).toBe(ndjson)
    expect(dirCreated.has(path.resolve(path.join(MOCK_PROJECTS_DIR, projectIdFor(wd))))).toBe(true)
  })

  it('rejects non-multipart bodies', async () => {
    const u = new URL('http://localhost/api/projects/sessions/import')
    const req = new Request(u, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } })
    const res = await handleProjectsApi(req, u, ['api', 'projects', 'sessions', 'import'])
    expect(res.status).toBe(400)
  })

  it('rejects missing file part', async () => {
    const form = new FormData()
    form.set('workDir', workDirFor('a'))
    expect((await call(form)).status).toBe(400)
  })

  it('rejects non-absolute workDir', async () => {
    const form = new FormData()
    form.set('workDir', 'relative/path')
    form.set('file', new Blob(['{"a":1}']), 's.jsonl')
    expect((await call(form)).status).toBe(400)
  })

  it('rejects an empty file', async () => {
    const form = new FormData()
    form.set('workDir', workDirFor('a'))
    form.set('file', new Blob(['']), 's.jsonl')
    expect((await call(form)).status).toBe(400)
  })

  it('rejects a file with malformed JSON lines', async () => {
    const form = new FormData()
    form.set('workDir', workDirFor('a'))
    form.set('file', new Blob(['{"valid":1}\nnot-json\n']), 's.jsonl')
    const res = await call(form)
    expect(res.status).toBe(400)
  })

  it('GET returns 405', async () => {
    const u = new URL('http://localhost/api/projects/sessions/import')
    const res = await handleProjectsApi(new Request(u, { method: 'GET' }), u, ['api', 'projects', 'sessions', 'import'])
    expect(res.status).toBe(405)
  })
})
