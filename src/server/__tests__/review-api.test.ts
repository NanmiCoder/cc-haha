/**
 * Route-level regression for `/api/sessions/:id/review`.
 *
 * Everything runs against a throwaway git repository and a temporary
 * `CLAUDE_CONFIG_DIR`; no real user session, provider or home directory is
 * touched.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { handleSessionsApi } from '../api/sessions.js'
import { sessionService } from '../services/sessionService.js'

const BASE = 'http://127.0.0.1:3456'

let tmpDir: string
let previousConfigDir: string | undefined

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

async function createRepo(): Promise<string> {
  const repoDir = path.join(tmpDir, `repo-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(repoDir, { recursive: true })
  git(repoDir, 'init')
  git(repoDir, 'config', 'user.email', 'review-api@example.com')
  git(repoDir, 'config', 'user.name', 'Review API')
  git(repoDir, 'checkout', '-q', '-b', 'main')
  await fs.writeFile(path.join(repoDir, 'tracked.txt'), 'one\ntwo\n')
  git(repoDir, 'add', '-A')
  git(repoDir, 'commit', '-m', 'initial')
  await fs.writeFile(path.join(repoDir, 'tracked.txt'), 'one\ntwo\nthree\n')
  await fs.writeFile(path.join(repoDir, 'fresh.txt'), 'fresh\n')
  return repoDir
}

async function call(
  method: string,
  suffix: string,
  sessionId: string,
  body?: unknown,
): Promise<Response> {
  const target = `${BASE}/api/sessions/${sessionId}/review${suffix}`
  const url = new URL(target)
  const req = new Request(target, {
    method,
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  })
  const segments = url.pathname.split('/').filter(Boolean)
  return handleSessionsApi(req, url, segments)
}

beforeEach(async () => {
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-api-'))
  await fs.mkdir(path.join(tmpDir, 'projects'), { recursive: true })
  process.env.CLAUDE_CONFIG_DIR = tmpDir
})

afterEach(async () => {
  if (previousConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  }
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('session review routes', () => {
  it('serves an explicit source and its per-file diff', async () => {
    const repoDir = await createRepo()
    const { sessionId } = await sessionService.createSession(repoDir)

    const statusRes = await call('GET', '?source=unstaged', sessionId)
    expect(statusRes.status).toBe(200)
    const status = await statusRes.json() as {
      state: string
      snapshot: string
      files: Array<{ path: string }>
      untracked: string[]
    }
    expect(status.state).toBe('ok')
    expect(status.files.map((file) => file.path).sort()).toEqual(['fresh.txt', 'tracked.txt'])
    expect(status.untracked).toEqual(['fresh.txt'])
    expect(status.snapshot.length).toBeGreaterThan(0)

    const revision = await (await call('GET', '/revision?source=unstaged', sessionId)).json() as Record<string, unknown>
    expect(revision.snapshot).toBe(status.snapshot)
    expect(revision.state).toBe('ok')
    expect(revision).not.toHaveProperty('files')
    expect(revision).not.toHaveProperty('diff')
    expect((await call('POST', '/revision?source=unstaged', sessionId, {})).status).toBe(405)

    const fileDiffRes = await call('GET', '/diff?source=unstaged&path=tracked.txt', sessionId)
    expect(fileDiffRes.status).toBe(200)
    expect((await fileDiffRes.json() as { diff: string }).diff).toContain('+three')
  })

  it('runs a real stage through the route and reports the refreshed status', async () => {
    const repoDir = await createRepo()
    const { sessionId } = await sessionService.createSession(repoDir)

    const status = await (await call('GET', '?source=unstaged', sessionId)).json() as {
      snapshot: string
    }
    const res = await call('POST', '/stage', sessionId, {
      paths: ['tracked.txt'],
      snapshot: status.snapshot,
      source: { kind: 'unstaged' },
    })

    expect(res.status).toBe(200)
    const body = await res.json() as {
      state: string
      results: Array<{ path: string; ok: boolean; action?: string }>
      status: { files: Array<{ path: string }> }
    }
    expect(body.state).toBe('ok')
    expect(body.results).toEqual([{ path: 'tracked.txt', ok: true, action: 'staged' }])
    expect(body.status.files.map((file) => file.path)).toEqual(['fresh.txt'])
    expect(git(repoDir, 'status', '--porcelain=v1')).toContain('M  tracked.txt')
  })

  it('answers a stale write with a 200 body carrying state=stale', async () => {
    const repoDir = await createRepo()
    const { sessionId } = await sessionService.createSession(repoDir)

    const status = await (await call('GET', '?source=unstaged', sessionId)).json() as {
      snapshot: string
    }
    await fs.writeFile(path.join(repoDir, 'tracked.txt'), 'entirely different content here\n')

    const res = await call('POST', '/stage', sessionId, {
      paths: ['tracked.txt'],
      snapshot: status.snapshot,
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { state: string; results: unknown[] }
    expect(body.state).toBe('stale')
    expect(body.results).toEqual([])
    expect(git(repoDir, 'status', '--porcelain=v1')).toContain(' M tracked.txt')
  })

  it('rejects the turn source with 400 instead of answering from current Git', async () => {
    const repoDir = await createRepo()
    const { sessionId } = await sessionService.createSession(repoDir)

    const res = await call('GET', '?source=turn&turnKey=turn-3', sessionId)
    expect(res.status).toBe(400)
    expect((await res.json() as { message: string }).message).toContain('turn history')
  })

  it('validates the requested source and its arguments', async () => {
    const repoDir = await createRepo()
    const { sessionId } = await sessionService.createSession(repoDir)

    expect((await call('GET', '', sessionId)).status).toBe(400)
    expect((await call('GET', '?source=nope', sessionId)).status).toBe(400)
    expect((await call('GET', '?source=branch', sessionId)).status).toBe(400)
    expect((await call('GET', '?source=commit', sessionId)).status).toBe(400)
    expect((await call('GET', '/diff?source=unstaged', sessionId)).status).toBe(400)
    expect(
      (await call('POST', '/stage', sessionId, { paths: ['tracked.txt'] })).status,
    ).toBe(400)
    expect(
      (await call('POST', '/stage', sessionId, { paths: [], snapshot: 'x' })).status,
    ).toBe(400)
  })

  it('maps traversal to 403, unknown resources to 404 and wrong methods to 405', async () => {
    const repoDir = await createRepo()
    const { sessionId } = await sessionService.createSession(repoDir)
    const status = await (await call('GET', '?source=unstaged', sessionId)).json() as {
      snapshot: string
    }

    const traversal = await call('POST', '/stage', sessionId, {
      paths: ['../escape.txt'],
      snapshot: status.snapshot,
    })
    expect(traversal.status).toBe(403)

    expect((await call('GET', '/nope?source=unstaged', sessionId)).status).toBe(404)
    expect((await call('POST', '?source=unstaged', sessionId, {})).status).toBe(405)
    expect((await call('GET', '/stage?source=unstaged', sessionId)).status).toBe(405)
  })

  it('refuses a write against a read-only branch or commit comparison', async () => {
    // Read-only was enforced only by the renderer not drawing the buttons, so
    // a direct POST ran a real working-tree write against a history
    // comparison — discarding current work while claiming to act on a commit.
    const repoDir = await createRepo()
    const { sessionId } = await sessionService.createSession(repoDir)
    const head = git(repoDir, 'rev-parse', 'HEAD').trim()
    const status = await (await call('GET', '?source=unstaged', sessionId)).json() as {
      snapshot: string
    }

    for (const source of [
      { kind: 'branch', baseRef: 'main' },
      { kind: 'commit', commit: head },
    ]) {
      for (const resource of ['/revert', '/stage', '/unstage']) {
        const res = await call('POST', resource, sessionId, {
          paths: ['tracked.txt'],
          snapshot: status.snapshot,
          source,
        })
        expect(res.status).toBe(400)
        expect((await res.json() as { message: string }).message).toContain('read-only')
      }
    }

    // Nothing was applied: the working tree still holds the uncommitted edit.
    expect(await fs.readFile(path.join(repoDir, 'tracked.txt'), 'utf8')).toBe('one\ntwo\nthree\n')
    expect(git(repoDir, 'status', '--porcelain=v1')).toContain(' M tracked.txt')
  })

  it('returns 404 for an unknown session', async () => {
    const res = await call('GET', '?source=unstaged', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
    expect(res.status).toBe(404)
  })
})
