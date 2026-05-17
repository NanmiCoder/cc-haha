import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { handleDesktopUiApi } from '../api/desktop-ui.js'
import { DesktopUiPreferencesService } from '../services/desktopUiPreferencesService.js'

let tmpDir: string
let originalConfigDir: string | undefined

async function setup() {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-ui-preferences-'))
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tmpDir
}

async function teardown() {
  if (originalConfigDir !== undefined) {
    process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  } else {
    delete process.env.CLAUDE_CONFIG_DIR
  }
  await fs.rm(tmpDir, { recursive: true, force: true })
}

function makeRequest(
  method: string,
  urlStr: string,
  body?: Record<string, unknown>,
): { req: Request; url: URL; segments: string[] } {
  const url = new URL(urlStr, 'http://localhost:3456')
  const init: RequestInit = { method }
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  const req = new Request(url.toString(), init)
  const segments = url.pathname.split('/').filter(Boolean)
  return { req, url, segments }
}

async function readDesktopUiFile(): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(path.join(tmpDir, 'cc-haha', 'desktop-ui.json'), 'utf-8')
  return JSON.parse(raw) as Record<string, unknown>
}

describe('DesktopUiPreferencesService', () => {
  beforeEach(setup)
  afterEach(teardown)

  test('returns defaults when desktop-ui.json does not exist', async () => {
    const service = new DesktopUiPreferencesService()

    const result = await service.readPreferences()

    expect(result.exists).toBe(false)
    expect(result.preferences).toEqual({
      schemaVersion: 1,
      sidebar: {
        projectOrder: [],
        pinnedProjects: [],
        hiddenProjects: [],
        projectOrganization: 'recentProject',
        projectSortBy: 'updatedAt',
      },
    })
  })

  test('normalizes old schema files and preserves unknown fields when updating sidebar preferences', async () => {
    await fs.mkdir(path.join(tmpDir, 'cc-haha'), { recursive: true })
    await fs.writeFile(
      path.join(tmpDir, 'cc-haha', 'desktop-ui.json'),
      JSON.stringify({
        futureField: { keep: true },
        sidebar: {
          projectOrder: ['/workspace/alpha', 42, '/workspace/alpha', '/workspace/beta'],
          pinnedProjects: ['/workspace/beta'],
          hiddenProjects: [null, '/workspace/gamma'],
        },
      }),
      'utf-8',
    )

    const service = new DesktopUiPreferencesService()
    const before = await service.readPreferences()
    const after = await service.updateSidebarPreferences({
      projectOrder: ['/workspace/gamma'],
      pinnedProjects: [],
      hiddenProjects: ['/workspace/beta'],
    })

    expect(before.exists).toBe(true)
    expect(before.preferences).toEqual({
      schemaVersion: 1,
      futureField: { keep: true },
      sidebar: {
        projectOrder: ['/workspace/alpha', '/workspace/beta'],
        pinnedProjects: ['/workspace/beta'],
        hiddenProjects: ['/workspace/gamma'],
        projectOrganization: 'recentProject',
        projectSortBy: 'updatedAt',
      },
    })
    expect(after).toEqual({
      schemaVersion: 1,
      futureField: { keep: true },
      sidebar: {
        projectOrder: ['/workspace/gamma'],
        pinnedProjects: [],
        hiddenProjects: ['/workspace/beta'],
        projectOrganization: 'recentProject',
        projectSortBy: 'updatedAt',
      },
    })
    expect(await readDesktopUiFile()).toEqual(after)
  })

  test('quarantines corrupt desktop-ui.json and reports defaults as missing', async () => {
    await fs.mkdir(path.join(tmpDir, 'cc-haha'), { recursive: true })
    await fs.writeFile(path.join(tmpDir, 'cc-haha', 'desktop-ui.json'), '{bad json', 'utf-8')

    const service = new DesktopUiPreferencesService()
    const result = await service.readPreferences()
    const files = await fs.readdir(path.join(tmpDir, 'cc-haha'))

    expect(result.exists).toBe(false)
    expect(result.preferences.sidebar.hiddenProjects).toEqual([])
    expect(files.some((name) => name.startsWith('desktop-ui.json.invalid-'))).toBe(true)
  })
})

describe('desktop UI preferences API', () => {
  beforeEach(setup)
  afterEach(teardown)

  test('persists sidebar preferences under cc-haha desktop-ui.json', async () => {
    const putReq = makeRequest('PUT', '/api/desktop-ui/preferences/sidebar', {
      projectOrder: ['/workspace/beta', '/workspace/alpha'],
      pinnedProjects: ['/workspace/beta'],
      hiddenProjects: ['/workspace/old'],
      projectOrganization: 'project',
      projectSortBy: 'createdAt',
    })

    const putRes = await handleDesktopUiApi(putReq.req, putReq.url, putReq.segments)
    const putBody = await putRes.json() as Record<string, unknown>

    expect(putRes.status).toBe(200)
    expect(putBody).toEqual({
      ok: true,
      preferences: {
        schemaVersion: 1,
        sidebar: {
          projectOrder: ['/workspace/beta', '/workspace/alpha'],
          pinnedProjects: ['/workspace/beta'],
          hiddenProjects: ['/workspace/old'],
          projectOrganization: 'project',
          projectSortBy: 'createdAt',
        },
      },
    })

    const getReq = makeRequest('GET', '/api/desktop-ui/preferences')
    const getRes = await handleDesktopUiApi(getReq.req, getReq.url, getReq.segments)
    const getBody = await getRes.json() as Record<string, unknown>

    expect(getRes.status).toBe(200)
    expect(getBody).toEqual({
      exists: true,
      preferences: {
        schemaVersion: 1,
        sidebar: {
          projectOrder: ['/workspace/beta', '/workspace/alpha'],
          pinnedProjects: ['/workspace/beta'],
          hiddenProjects: ['/workspace/old'],
          projectOrganization: 'project',
          projectSortBy: 'createdAt',
        },
      },
    })
  })
})
