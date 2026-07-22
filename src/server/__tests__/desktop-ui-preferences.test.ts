import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { handleDesktopUiApi } from '../api/desktop-ui.js'
import { DesktopUiPreferencesService } from '../services/desktopUiPreferencesService.js'

let tmpDir: string
let originalConfigDir: string | undefined

const DEFAULT_PET_PREFERENCES = {
  enabled: false,
  selectedPetId: 'dada-code',
  size: 144,
  showTaskPanel: false,
  collapsed: false,
  motionEnabled: true,
  lastSessionId: null,
}

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
  body?: Record<string, unknown> | Uint8Array,
  contentType = 'application/json',
): { req: Request; url: URL; segments: string[] } {
  const url = new URL(urlStr, 'http://localhost:3456')
  const init: RequestInit = { method }
  if (body !== undefined) {
    init.headers = { 'Content-Type': contentType }
    init.body = body instanceof Uint8Array ? body : JSON.stringify(body)
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
      schemaVersion: 4,
      profile: {
        displayName: 'cc-haha',
        subtitle: 'github.com/NanmiCoder/cc-haha',
        avatarFile: null,
        avatarUpdatedAt: null,
      },
      pet: DEFAULT_PET_PREFERENCES,
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
        schemaVersion: 2,
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
      schemaVersion: 4,
      futureField: { keep: true },
      profile: {
        displayName: 'cc-haha',
        subtitle: 'github.com/NanmiCoder/cc-haha',
        avatarFile: null,
        avatarUpdatedAt: null,
      },
      pet: DEFAULT_PET_PREFERENCES,
      sidebar: {
        projectOrder: ['/workspace/alpha', '/workspace/beta'],
        pinnedProjects: ['/workspace/beta'],
        hiddenProjects: ['/workspace/gamma'],
        projectOrganization: 'recentProject',
        projectSortBy: 'updatedAt',
      },
    })
    expect(after).toEqual({
      schemaVersion: 4,
      futureField: { keep: true },
      profile: {
        displayName: 'cc-haha',
        subtitle: 'github.com/NanmiCoder/cc-haha',
        avatarFile: null,
        avatarUpdatedAt: null,
      },
      pet: DEFAULT_PET_PREFERENCES,
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
    expect(result.preferences.profile.displayName).toBe('cc-haha')
    expect(result.preferences.pet).toEqual(DEFAULT_PET_PREFERENCES)
    expect(files.some((name) => name.startsWith('desktop-ui.json.invalid-'))).toBe(true)
  })

  test('normalizes invalid pet preferences while preserving unrelated fields', async () => {
    await fs.mkdir(path.join(tmpDir, 'cc-haha'), { recursive: true })
    await fs.writeFile(
      path.join(tmpDir, 'cc-haha', 'desktop-ui.json'),
      JSON.stringify({
        schemaVersion: 3,
        futureField: { keep: true },
        pet: {
          enabled: 'yes',
          selectedPetId: '../escape',
          size: 144.5,
          collapsed: 1,
          motionEnabled: null,
          lastSessionId: 's'.repeat(240),
        },
      }),
      'utf-8',
    )

    const result = await new DesktopUiPreferencesService().readPreferences()

    expect(result.preferences.futureField).toEqual({ keep: true })
    expect(result.preferences.pet).toEqual({
      ...DEFAULT_PET_PREFERENCES,
      lastSessionId: 's'.repeat(200),
    })
  })

  test('normalizes and persists pet preferences without touching sidebar, profile, or unknown fields', async () => {
    const service = new DesktopUiPreferencesService()
    await service.updateSidebarPreferences({
      projectOrder: ['/workspace/alpha'],
      pinnedProjects: ['/workspace/alpha'],
      hiddenProjects: [],
      projectOrganization: 'project',
      projectSortBy: 'createdAt',
    })
    await service.updateProfilePreferences({
      displayName: 'Local Operator',
      subtitle: 'operator.example',
    })
    const current = await readDesktopUiFile()
    await fs.writeFile(
      path.join(tmpDir, 'cc-haha', 'desktop-ui.json'),
      JSON.stringify({ ...current, futureField: { keep: true } }),
      'utf-8',
    )

    const after = await service.updatePetPreferences({
      enabled: true,
      selectedPetId: '  custom:rocky-bot  ',
      size: 999,
      collapsed: true,
      motionEnabled: false,
      lastSessionId: '',
    })

    expect(after).toMatchObject({
      schemaVersion: 4,
      futureField: { keep: true },
      profile: {
        displayName: 'Local Operator',
        subtitle: 'operator.example',
      },
      sidebar: {
        projectOrder: ['/workspace/alpha'],
        pinnedProjects: ['/workspace/alpha'],
        projectOrganization: 'project',
        projectSortBy: 'createdAt',
      },
      pet: {
        enabled: true,
        selectedPetId: 'custom:rocky-bot',
        size: 192,
        collapsed: true,
        motionEnabled: false,
        lastSessionId: null,
      },
    })
    expect(await readDesktopUiFile()).toEqual(after)

  })

  test('merges concurrent pet field patches without reverting either renderer update', async () => {
    const settingsRenderer = new DesktopUiPreferencesService()
    const petRenderer = new DesktopUiPreferencesService()

    await settingsRenderer.updatePetPreferences({
      enabled: false,
      selectedPetId: 'huhu-plan',
      size: 144,
      showTaskPanel: false,
      collapsed: false,
      motionEnabled: true,
      lastSessionId: 'session-before',
    })

    await Promise.all([
      settingsRenderer.updatePetPreferences({ size: 176, showTaskPanel: true, motionEnabled: false }),
      petRenderer.updatePetPreferences({ collapsed: true, lastSessionId: 'session-after' }),
    ])

    const { preferences } = await settingsRenderer.readPreferences()
    expect(preferences.pet).toEqual({
      enabled: false,
      selectedPetId: 'huhu-plan',
      size: 176,
      showTaskPanel: true,
      collapsed: true,
      motionEnabled: false,
      lastSessionId: 'session-after',
    })
  })

  test('migrates a schema-3 pet to a hidden task panel while preserving other and unknown fields', async () => {
    await fs.mkdir(path.join(tmpDir, 'cc-haha'), { recursive: true })
    await fs.writeFile(
      path.join(tmpDir, 'cc-haha', 'desktop-ui.json'),
      JSON.stringify({
        schemaVersion: 3,
        futureField: { keep: true },
        pet: {
          futurePetField: { keep: 'pet-too' },
          enabled: false,
          selectedPetId: 'custom:rocky-bot',
          size: 168,
          collapsed: true,
          motionEnabled: false,
          lastSessionId: 'session-old',
        },
      }),
      'utf-8',
    )

    const after = await new DesktopUiPreferencesService().updatePetPreferences({ enabled: true })

    expect(after).toMatchObject({
      schemaVersion: 4,
      futureField: { keep: true },
      pet: {
        futurePetField: { keep: 'pet-too' },
        enabled: true,
        selectedPetId: 'custom:rocky-bot',
        size: 168,
        showTaskPanel: false,
        collapsed: true,
        motionEnabled: false,
        lastSessionId: 'session-old',
      },
    })
    expect(await readDesktopUiFile()).toEqual(after)

  })

  test('patches pet preferences without downgrading future schema or sibling fields', async () => {
    await fs.mkdir(path.join(tmpDir, 'cc-haha'), { recursive: true })
    await fs.writeFile(
      path.join(tmpDir, 'cc-haha', 'desktop-ui.json'),
      JSON.stringify({
        schemaVersion: 99,
        futureRoot: { keep: 'root' },
        sidebar: {
          projectOrder: [],
          pinnedProjects: [],
          hiddenProjects: [],
          projectOrganization: 'recentProject',
          projectSortBy: 'updatedAt',
          futureSidebar: { keep: 'sidebar' },
        },
        profile: {
          displayName: 'Future Operator',
          subtitle: 'future.example',
          avatarFile: null,
          avatarUpdatedAt: null,
          futureProfile: { keep: 'profile' },
        },
        pet: {
          ...DEFAULT_PET_PREFERENCES,
          futurePet: { keep: 'pet' },
        },
      }),
      'utf-8',
    )

    const after = await new DesktopUiPreferencesService().updatePetPreferences({ enabled: true })

    expect(after).toMatchObject({
      schemaVersion: 99,
      futureRoot: { keep: 'root' },
      sidebar: { futureSidebar: { keep: 'sidebar' } },
      profile: { futureProfile: { keep: 'profile' } },
      pet: {
        enabled: true,
        futurePet: { keep: 'pet' },
      },
    })
    expect(await readDesktopUiFile()).toEqual(after)

    const afterSidebarPatch = await new DesktopUiPreferencesService().updateSidebarPreferences({
      projectOrder: ['/workspace/future'],
      pinnedProjects: [],
      hiddenProjects: [],
      projectOrganization: 'project',
      projectSortBy: 'createdAt',
    })
    expect(afterSidebarPatch).toMatchObject({
      schemaVersion: 99,
      sidebar: {
        projectOrder: ['/workspace/future'],
        futureSidebar: { keep: 'sidebar' },
      },
      profile: { futureProfile: { keep: 'profile' } },
      pet: { futurePet: { keep: 'pet' } },
    })
  })

  test('normalizes and persists profile preferences without touching sidebar preferences', async () => {
    const service = new DesktopUiPreferencesService()
    const after = await service.updateProfilePreferences({
      displayName: '  Claude Captain  ',
      subtitle: '  local.example/profile  ',
      avatarFile: '../escape.png',
      avatarUpdatedAt: 42,
    })

    expect(after).toEqual({
      schemaVersion: 4,
      profile: {
        displayName: 'Claude Captain',
        subtitle: 'local.example/profile',
        avatarFile: null,
        avatarUpdatedAt: null,
      },
      pet: DEFAULT_PET_PREFERENCES,
      sidebar: {
        projectOrder: [],
        pinnedProjects: [],
        hiddenProjects: [],
        projectOrganization: 'recentProject',
        projectSortBy: 'updatedAt',
      },
    })
    expect(await readDesktopUiFile()).toEqual(after)
  })

  test('stores uploaded profile avatars under cc-haha profile storage', async () => {
    const service = new DesktopUiPreferencesService()
    const after = await service.updateProfileAvatar(new Uint8Array([137, 80, 78, 71]), 'image/png')

    expect(after.profile.avatarFile).toBe('profile/avatar.png')
    expect(typeof after.profile.avatarUpdatedAt).toBe('string')

    const avatar = await fs.readFile(path.join(tmpDir, 'cc-haha', 'profile', 'avatar.png'))
    expect([...avatar]).toEqual([137, 80, 78, 71])
  })

  test('clears only managed profile avatar files', async () => {
    const service = new DesktopUiPreferencesService()
    await service.updateProfileAvatar(new Uint8Array([137, 80, 78, 71]), 'image/png')
    await fs.writeFile(path.join(tmpDir, 'cc-haha', 'profile', 'local-note.txt'), 'keep me', 'utf-8')

    const after = await service.clearProfileAvatar()

    expect(after.profile.avatarFile).toBeNull()
    expect(after.profile.avatarUpdatedAt).toBeNull()
    await expect(fs.readFile(path.join(tmpDir, 'cc-haha', 'profile', 'avatar.png'))).rejects.toThrow()
    await expect(fs.readFile(path.join(tmpDir, 'cc-haha', 'profile', 'local-note.txt'), 'utf-8')).resolves.toBe('keep me')
  })

  test('rejects unsupported or oversized profile avatars', async () => {
    const service = new DesktopUiPreferencesService()

    await expect(service.updateProfileAvatar(new Uint8Array([1, 2, 3]), 'image/gif')).rejects.toThrow('Unsupported avatar type')
    await expect(service.updateProfileAvatar(new Uint8Array(2_000_001), 'image/png')).rejects.toThrow('Avatar image is too large')
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
        schemaVersion: 4,
        profile: {
          displayName: 'cc-haha',
          subtitle: 'github.com/NanmiCoder/cc-haha',
          avatarFile: null,
          avatarUpdatedAt: null,
        },
        pet: DEFAULT_PET_PREFERENCES,
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
        schemaVersion: 4,
        profile: {
          displayName: 'cc-haha',
          subtitle: 'github.com/NanmiCoder/cc-haha',
          avatarFile: null,
          avatarUpdatedAt: null,
        },
        pet: DEFAULT_PET_PREFERENCES,
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

  test('persists normalized pet preferences through the API', async () => {
    const putReq = makeRequest('PUT', '/api/desktop-ui/preferences/pet', {
      enabled: true,
      selectedPetId: '  seedy  ',
      size: 40,
      showTaskPanel: true,
      collapsed: false,
      motionEnabled: true,
      lastSessionId: 'session-42',
    })

    const putRes = await handleDesktopUiApi(putReq.req, putReq.url, putReq.segments)

    expect(putRes.status).toBe(200)
    await expect(putRes.json()).resolves.toMatchObject({
      ok: true,
      preferences: {
        schemaVersion: 4,
        pet: {
          enabled: true,
          selectedPetId: 'seedy',
          size: 96,
          showTaskPanel: true,
          collapsed: false,
          motionEnabled: true,
          lastSessionId: 'session-42',
        },
      },
    })
  })

  test('reads the pet projection without exposing sidebar or profile preferences', async () => {
    const service = new DesktopUiPreferencesService()
    await service.updateSidebarPreferences({
      projectOrder: ['/workspace/private'],
      pinnedProjects: ['/workspace/private'],
      hiddenProjects: [],
    })
    await service.updateProfilePreferences({
      displayName: 'Private Operator',
      subtitle: 'private.example',
    })
    await service.updatePetPreferences({ selectedPetId: 'huhu-plan' })
    const getReq = makeRequest('GET', '/api/desktop-ui/preferences/pet')

    const getRes = await handleDesktopUiApi(getReq.req, getReq.url, getReq.segments)
    const body = await getRes.json() as Record<string, unknown>

    expect(getRes.status).toBe(200)
    expect(body).toEqual({
      exists: true,
      pet: {
        ...DEFAULT_PET_PREFERENCES,
        selectedPetId: 'huhu-plan',
      },
    })
    expect(body).not.toHaveProperty('profile')
    expect(body).not.toHaveProperty('sidebar')
  })

  test('applies pet API bodies as field patches', async () => {
    const service = new DesktopUiPreferencesService()
    await service.updatePetPreferences({
      enabled: true,
      selectedPetId: 'huhu-plan',
      size: 152,
      collapsed: false,
      motionEnabled: true,
      lastSessionId: 'session-1',
    })
    const patchReq = makeRequest('PUT', '/api/desktop-ui/preferences/pet', {
      collapsed: true,
    })

    const patchRes = await handleDesktopUiApi(patchReq.req, patchReq.url, patchReq.segments)

    expect(patchRes.status).toBe(200)
    await expect(patchRes.json()).resolves.toMatchObject({
      ok: true,
      preferences: {
        pet: {
          enabled: true,
          selectedPetId: 'huhu-plan',
          size: 152,
          collapsed: true,
          motionEnabled: true,
          lastSessionId: 'session-1',
        },
      },
    })
  })

  test('persists profile preferences and avatar uploads through the API', async () => {
    const profileReq = makeRequest('PUT', '/api/desktop-ui/preferences/profile', {
      displayName: '  Local Operator  ',
      subtitle: '  operator.example  ',
    })
    const profileRes = await handleDesktopUiApi(profileReq.req, profileReq.url, profileReq.segments)
    const profileBody = await profileRes.json() as Record<string, unknown>

    expect(profileRes.status).toBe(200)
    expect(profileBody).toMatchObject({
      ok: true,
      preferences: {
        profile: {
          displayName: 'Local Operator',
          subtitle: 'operator.example',
          avatarFile: null,
        },
      },
    })

    const avatarReq = makeRequest(
      'PUT',
      '/api/desktop-ui/preferences/profile/avatar',
      new Uint8Array([255, 216, 255]),
      'image/jpeg',
    )
    const avatarRes = await handleDesktopUiApi(avatarReq.req, avatarReq.url, avatarReq.segments)
    const avatarBody = await avatarRes.json() as Record<string, unknown>

    expect(avatarRes.status).toBe(200)
    expect(avatarBody).toMatchObject({
      ok: true,
      preferences: {
        profile: {
          displayName: 'Local Operator',
          subtitle: 'operator.example',
          avatarFile: 'profile/avatar.jpg',
        },
      },
    })

    const getAvatarReq = makeRequest('GET', '/api/desktop-ui/preferences/profile/avatar')
    const getAvatarRes = await handleDesktopUiApi(getAvatarReq.req, getAvatarReq.url, getAvatarReq.segments)

    expect(getAvatarRes.status).toBe(200)
    expect(getAvatarRes.headers.get('Content-Type')).toBe('image/jpeg')
    expect([...new Uint8Array(await getAvatarRes.arrayBuffer())]).toEqual([255, 216, 255])
  })

  test('returns API errors for missing avatars, invalid JSON, and unknown routes', async () => {
    const missingAvatarReq = makeRequest('GET', '/api/desktop-ui/preferences/profile/avatar')
    const missingAvatarRes = await handleDesktopUiApi(
      missingAvatarReq.req,
      missingAvatarReq.url,
      missingAvatarReq.segments,
    )
    expect(missingAvatarRes.status).toBe(404)
    await expect(missingAvatarRes.json()).resolves.toMatchObject({
      error: 'NOT_FOUND',
      message: 'Profile avatar is not configured',
    })

    const invalidUrl = new URL('/api/desktop-ui/preferences/profile', 'http://localhost:3456')
    const invalidReq = new Request(invalidUrl.toString(), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{bad json',
    })
    const invalidRes = await handleDesktopUiApi(
      invalidReq,
      invalidUrl,
      invalidUrl.pathname.split('/').filter(Boolean),
    )
    expect(invalidRes.status).toBe(400)
    await expect(invalidRes.json()).resolves.toMatchObject({
      error: 'BAD_REQUEST',
      message: 'Invalid JSON body',
    })

    const unknownTopReq = makeRequest('GET', '/api/desktop-ui/unknown')
    const unknownTopRes = await handleDesktopUiApi(unknownTopReq.req, unknownTopReq.url, unknownTopReq.segments)
    expect(unknownTopRes.status).toBe(404)

    const unknownProfileReq = makeRequest('GET', '/api/desktop-ui/preferences/profile/banner')
    const unknownProfileRes = await handleDesktopUiApi(
      unknownProfileReq.req,
      unknownProfileReq.url,
      unknownProfileReq.segments,
    )
    expect(unknownProfileRes.status).toBe(404)

    const unknownPreferenceReq = makeRequest('GET', '/api/desktop-ui/preferences/theme')
    const unknownPreferenceRes = await handleDesktopUiApi(
      unknownPreferenceReq.req,
      unknownPreferenceReq.url,
      unknownPreferenceReq.segments,
    )
    expect(unknownPreferenceRes.status).toBe(404)
  })

  test('clears profile avatars and rejects unsupported avatar methods through the API', async () => {
    const putReq = makeRequest(
      'PUT',
      '/api/desktop-ui/preferences/profile/avatar',
      new Uint8Array([82, 73, 70, 70]),
      'image/webp',
    )
    const putRes = await handleDesktopUiApi(putReq.req, putReq.url, putReq.segments)
    expect(putRes.status).toBe(200)

    const deleteReq = makeRequest('DELETE', '/api/desktop-ui/preferences/profile/avatar')
    const deleteRes = await handleDesktopUiApi(deleteReq.req, deleteReq.url, deleteReq.segments)
    const deleteBody = await deleteRes.json() as Record<string, unknown>
    expect(deleteRes.status).toBe(200)
    expect(deleteBody).toMatchObject({
      ok: true,
      preferences: {
        profile: {
          avatarFile: null,
          avatarUpdatedAt: null,
        },
      },
    })

    const getAvatarReq = makeRequest('GET', '/api/desktop-ui/preferences/profile/avatar')
    const getAvatarRes = await handleDesktopUiApi(getAvatarReq.req, getAvatarReq.url, getAvatarReq.segments)
    expect(getAvatarRes.status).toBe(404)

    const patchReq = makeRequest('PATCH', '/api/desktop-ui/preferences/profile/avatar')
    const patchRes = await handleDesktopUiApi(patchReq.req, patchReq.url, patchReq.segments)
    expect(patchRes.status).toBe(405)
    await expect(patchRes.json()).resolves.toMatchObject({
      error: 'METHOD_NOT_ALLOWED',
      message: 'Method PATCH not allowed',
    })
  })
})
