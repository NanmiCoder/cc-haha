import { describe, it, expect, mock, beforeEach } from 'bun:test'
import * as path from 'path'

const MOCK_CLAUDE_HOME = path.join('/mock', 'home', '.claude')
const MOCK_PROJECTS_DIR = path.join(MOCK_CLAUDE_HOME, 'projects')

mock.module('../../utils/envUtils.js', () => ({
  getClaudeConfigHomeDir: () => MOCK_CLAUDE_HOME,
}))

mock.module('../../utils/path.js', () => ({
  // Match the real sanitizePath behaviour for our test inputs: replace
  // path separators and colons with '-'.
  sanitizePath: (p: string) => p.replace(/[\\/:]/g, '-').replace(/^-+/, ''),
}))

// projectActivityService is unrelated to clear-sessions; stub it so the import
// chain doesn't pull in real fs work.
mock.module('../services/projectActivityService.js', () => ({
  getRecentActivity: async () => ({ items: [] }),
}))

type FakeEntry = { name: string; isFile: () => boolean; isDirectory: () => boolean }
const dirs = new Map<string, FakeEntry[]>()
const unlinked: string[] = []
const rmdired: string[] = []
let nextRmdirError: NodeJS.ErrnoException | null = null

mock.module('fs/promises', () => ({
  readdir: async (dirPath: string, _opts?: unknown) => {
    const entries = dirs.get(path.resolve(dirPath))
    if (!entries) {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    }
    return entries
  },
  unlink: async (filePath: string) => {
    unlinked.push(filePath)
    // Remove the entry from its directory so a follow-up rmdir sees it as
    // empty when only .jsonl files were present.
    const dir = path.dirname(filePath)
    const base = path.basename(filePath)
    const list = dirs.get(path.resolve(dir))
    if (list) dirs.set(path.resolve(dir), list.filter(e => e.name !== base))
  },
  rmdir: async (dirPath: string) => {
    if (nextRmdirError) {
      const err = nextRmdirError
      nextRmdirError = null
      throw err
    }
    rmdired.push(path.resolve(dirPath))
    dirs.delete(path.resolve(dirPath))
  },
}))

import { handleProjectsApi } from '../api/projects'

function projectDir(id: string) {
  return path.join(MOCK_PROJECTS_DIR, id)
}

function file(name: string): FakeEntry {
  return { name, isFile: () => true, isDirectory: () => false }
}

function dir(name: string): FakeEntry {
  return { name, isFile: () => false, isDirectory: () => true }
}

beforeEach(() => {
  dirs.clear()
  unlinked.length = 0
  rmdired.length = 0
  nextRmdirError = null
})

describe('POST /api/projects/sessions/clear', () => {
  async function call(body: unknown): Promise<Response> {
    const url = new URL('http://localhost/api/projects/sessions/clear')
    const req = new Request(url, { method: 'POST', body: JSON.stringify(body) })
    return handleProjectsApi(req, url, ['api', 'projects', 'sessions', 'clear'])
  }

  it('rejects invalid projectId (path separators)', async () => {
    const res = await call({ projectId: '../escaped' })
    expect(res.status).toBe(400)
  })

  it('rejects missing projectId', async () => {
    const res = await call({})
    expect(res.status).toBe(400)
  })

  it('rejects projectId with null byte', async () => {
    const res = await call({ projectId: 'foo\0bar' })
    expect(res.status).toBe(400)
  })

  it('rejects . and ..', async () => {
    expect((await call({ projectId: '.' })).status).toBe(400)
    expect((await call({ projectId: '..' })).status).toBe(400)
  })

  it('returns ok with 0 deletes when project dir does not exist', async () => {
    const res = await call({ projectId: 'C--Users-70641-vanished' })
    expect(res.status).toBe(200)
    const data = await res.json() as { ok: boolean; deletedSessions: number; projectDirRemoved: boolean }
    expect(data.ok).toBe(true)
    expect(data.deletedSessions).toBe(0)
    expect(data.projectDirRemoved).toBe(false)
  })

  it('deletes all .jsonl files and removes the now-empty project dir', async () => {
    const id = 'C--Users-70641-myproj'
    dirs.set(path.resolve(projectDir(id)), [
      file('a.jsonl'),
      file('b.jsonl'),
      file('c.jsonl'),
    ])
    const res = await call({ projectId: id })
    expect(res.status).toBe(200)
    const data = await res.json() as { deletedSessions: number; projectDirRemoved: boolean }
    expect(data.deletedSessions).toBe(3)
    expect(data.projectDirRemoved).toBe(true)
    expect(unlinked).toHaveLength(3)
    expect(rmdired).toContain(path.resolve(projectDir(id)))
  })

  it('keeps non-.jsonl files and does not remove the directory', async () => {
    const id = 'C--Users-70641-keep-state'
    dirs.set(path.resolve(projectDir(id)), [
      file('session.jsonl'),
      file('user-notes.txt'),
      dir('memory'),
    ])
    const res = await call({ projectId: id })
    const data = await res.json() as { deletedSessions: number; projectDirRemoved: boolean }
    expect(data.deletedSessions).toBe(1)
    expect(data.projectDirRemoved).toBe(false)
    expect(unlinked).toHaveLength(1)
    expect(rmdired).toHaveLength(0)
  })

  it('GET on /sessions/clear returns 405', async () => {
    const url = new URL('http://localhost/api/projects/sessions/clear')
    const req = new Request(url, { method: 'GET' })
    const res = await handleProjectsApi(req, url, ['api', 'projects', 'sessions', 'clear'])
    expect(res.status).toBe(405)
  })

  it('accepts an absolute workDir and sanitizes it server-side', async () => {
    // Stub sanitizes "/Users/me/proj" -> "Users-me-proj".
    const sanitizedId = 'Users-me-proj'
    dirs.set(path.resolve(projectDir(sanitizedId)), [file('a.jsonl')])

    const res = await call({ workDir: '/Users/me/proj' })
    expect(res.status).toBe(200)
    const data = await res.json() as { deletedSessions: number; projectDirRemoved: boolean }
    expect(data.deletedSessions).toBe(1)
    expect(data.projectDirRemoved).toBe(true)
  })

  it('rejects a relative workDir', async () => {
    const res = await call({ workDir: 'relative/path' })
    expect(res.status).toBe(400)
  })

  it('also deletes per-session summary sidecars (.summary.json) and removes the empty dir', async () => {
    const id = 'C--Users-70641-with-summaries'
    dirs.set(path.resolve(projectDir(id)), [
      file('a.jsonl'),
      file('a.summary.json'),
      file('b.jsonl'),
      file('b.summary.json'),
    ])
    const res = await call({ projectId: id })
    expect(res.status).toBe(200)
    const data = await res.json() as { deletedSessions: number; projectDirRemoved: boolean }
    expect(data.deletedSessions).toBe(2) // counts .jsonl files
    expect(data.projectDirRemoved).toBe(true) // both .jsonl + .summary.json gone
    expect(unlinked).toHaveLength(4)
  })
})
