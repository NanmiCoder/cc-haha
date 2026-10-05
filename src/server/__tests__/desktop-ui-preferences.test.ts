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

const DEFAULT_VOICE_INPUT_PREFERENCES = {
  enabled: true,
  providerId: 'sensevoice-local',
  language: 'auto',
  downloadSource: 'auto',
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
      schemaVersion: 6,
      profile: {
        displayName: 'cc-haha',
        subtitle: 'github.com/NanmiCoder/cc-haha',
        avatarFile: null,
        avatarUpdatedAt: null,
      },
      pet: DEFAULT_PET_PREFERENCES,
      voiceInput: DEFAULT_VOICE_INPUT_PREFERENCES,
      projectDisplayNames: {},
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
        schemaVersion: 4,
        futureField: { keep: true },
        sidebar: {
          projectOrder: ['/workspace/alpha', 42, '/workspace/alpha', '/workspace/beta'],
          pinnedProjects: ['/workspace/beta'],
          hiddenProjects: [null, '/workspace/gamma'],
        },
        projectDisplayNames: {
          '/workspace/alpha': '  Alpha project  ',
          '/workspace/beta': 42,
          '': 'Missing key',
          '   ': 'Whitespace key',
          '/workspace/blank': '   ',
          '/workspace/too-long-name': 'n'.repeat(81),
          ['x'.repeat(4_097)]: 'Overlong key',
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
      schemaVersion: 6,
      futureField: { keep: true },
      profile: {
        displayName: 'cc-haha',
        subtitle: 'github.com/NanmiCoder/cc-haha',
        avatarFile: null,
        avatarUpdatedAt: null,
      },
      pet: DEFAULT_PET_PREFERENCES,
      voiceInput: DEFAULT_VOICE_INPUT_PREFERENCES,
      projectDisplayNames: {
        '/workspace/alpha': 'Alpha project',
      },
      sidebar: {
        projectOrder: ['/workspace/alpha', '/workspace/beta'],
        pinnedProjects: ['/workspace/beta'],
        hiddenProjects: ['/workspace/gamma'],
        projectOrganization: 'recentProject',
        projectSortBy: 'updatedAt',
      },
    })
    expect(after).toEqual({
      schemaVersion: 6,
      futureField: { keep: true },
      profile: {
        displayName: 'cc-haha',
        subtitle: 'github.com/NanmiCoder/cc-haha',
        avatarFile: null,
        avatarUpdatedAt: null,
      },
      pet: DEFAULT_PET_PREFERENCES,
      voiceInput: DEFAULT_VOICE_INPUT_PREFERENCES,
      projectDisplayNames: {
        '/workspace/alpha': 'Alpha project',
      },
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
    expect(result.preferences.projectDisplayNames).toEqual({})
    expect(files.some((name) => name.startsWith('desktop-ui.json.invalid-'))).toBe(true)
  })

  test('sets and resets exact project display name keys without prototype pollution', async () => {
    const service = new DesktopUiPreferencesService()
    const projectKey = '  /workspace/alpha  '

    await expect(service.updateProjectDisplayName({
      projectKey,
      displayName: '  Alpha   project  ',
    })).resolves.toEqual({
      projectKey,
      displayName: 'Alpha project',
    })
    await service.updateProjectDisplayName({ projectKey: '__proto__', displayName: 'Prototype project' })
    await service.updateProjectDisplayName({ projectKey: 'constructor', displayName: 'Constructor project' })

    const { preferences } = await service.readPreferences()
    expect(Object.getPrototypeOf(preferences.projectDisplayNames)).toBe(Object.prototype)
    expect(Object.entries(preferences.projectDisplayNames)).toEqual([
      [projectKey, 'Alpha project'],
      ['__proto__', 'Prototype project'],
      ['constructor', 'Constructor project'],
    ])
    expect(Object.hasOwn(preferences.projectDisplayNames, '__proto__')).toBe(true)

    await expect(service.updateProjectDisplayName({ projectKey, displayName: null })).resolves.toEqual({
      projectKey,
      displayName: null,
    })
    expect(Object.entries((await service.readPreferences()).preferences.projectDisplayNames)).toEqual([
      ['__proto__', 'Prototype project'],
      ['constructor', 'Constructor project'],
    ])
  })

  test('merges concurrent project display name changes for different keys', async () => {
    const firstRenderer = new DesktopUiPreferencesService()
    const secondRenderer = new DesktopUiPreferencesService()

    await Promise.all([
      firstRenderer.updateProjectDisplayName({
        projectKey: '/workspace/alpha',
        displayName: 'Alpha',
      }),
      secondRenderer.updateProjectDisplayName({
        projectKey: '/workspace/beta',
        displayName: 'Beta',
      }),
    ])

    expect((await firstRenderer.readPreferences()).preferences.projectDisplayNames).toEqual({
      '/workspace/alpha': 'Alpha',
      '/workspace/beta': 'Beta',
    })
  })

  test('preserves project display names when updating sidebar, profile, and pet preferences', async () => {
    const service = new DesktopUiPreferencesService()
    await service.updateProjectDisplayName({
      projectKey: '/workspace/alpha',
      displayName: 'Alpha',
    })
    await service.updateSidebarPreferences({ projectOrder: ['/workspace/alpha'] })
    await service.updateProfilePreferences({ displayName: 'Local Operator' })
    await service.updatePetPreferences({ collapsed: true })

    expect((await service.readPreferences()).preferences.projectDisplayNames).toEqual({
      '/workspace/alpha': 'Alpha',
    })
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
      schemaVersion: 6,
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
      schemaVersion: 6,
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
        projectDisplayNames: {
          '/workspace/future': 'Future project',
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
      projectDisplayNames: {
        '/workspace/future': 'Future project',
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
      projectDisplayNames: { '/workspace/future': 'Future project' },
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
      schemaVersion: 6,
      profile: {
        displayName: 'Claude Captain',
        subtitle: 'local.example/profile',
        avatarFile: null,
        avatarUpdatedAt: null,
      },
      pet: DEFAULT_PET_PREFERENCES,
      voiceInput: DEFAULT_VOICE_INPUT_PREFERENCES,
      projectDisplayNames: {},
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

  test('rejects malformed profile patches without overwriting stored values', async () => {
    const service = new DesktopUiPreferencesService()
    const before = await service.updateProfilePreferences({
      displayName: 'Local Operator',
      subtitle: 'operator.example',
    })

    await expect(service.updateProfilePreferences({
      displayName: 42,
      subtitle: 'replacement.example',
    })).rejects.toThrow('displayName must be a string')
    await expect(service.updateProfilePreferences({
      displayName: '   ',
    })).rejects.toThrow('displayName must be between 1 and 80 characters')
    await expect(service.updateProfilePreferences([])).rejects.toThrow(
      'Profile preferences must be an object',
    )

    expect(await readDesktopUiFile()).toEqual(before)
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
        schemaVersion: 6,
        profile: {
          displayName: 'cc-haha',
          subtitle: 'github.com/NanmiCoder/cc-haha',
          avatarFile: null,
          avatarUpdatedAt: null,
        },
        pet: DEFAULT_PET_PREFERENCES,
        voiceInput: DEFAULT_VOICE_INPUT_PREFERENCES,
        projectDisplayNames: {},
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
        schemaVersion: 6,
        profile: {
          displayName: 'cc-haha',
          subtitle: 'github.com/NanmiCoder/cc-haha',
          avatarFile: null,
          avatarUpdatedAt: null,
        },
        pet: DEFAULT_PET_PREFERENCES,
        voiceInput: DEFAULT_VOICE_INPUT_PREFERENCES,
        projectDisplayNames: {},
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

  test('sets and resets a project display name through the API without canonicalizing its key', async () => {
    const projectKey = '  /workspace/alpha  '
    const setReq = makeRequest('PUT', '/api/desktop-ui/preferences/project-display-name', {
      projectKey,
      displayName: '  Alpha   project  ',
    })

    const setRes = await handleDesktopUiApi(setReq.req, setReq.url, setReq.segments)
    expect(setRes.status).toBe(200)
    await expect(setRes.json()).resolves.toEqual({
      ok: true,
      projectKey,
      displayName: 'Alpha project',
    })
    expect((await new DesktopUiPreferencesService().readPreferences()).preferences.projectDisplayNames).toEqual({
      [projectKey]: 'Alpha project',
    })

    const resetReq = makeRequest('PUT', '/api/desktop-ui/preferences/project-display-name', {
      projectKey,
      displayName: null,
    })
    const resetRes = await handleDesktopUiApi(resetReq.req, resetReq.url, resetReq.segments)
    expect(resetRes.status).toBe(200)
    await expect(resetRes.json()).resolves.toEqual({
      ok: true,
      projectKey,
      displayName: null,
    })
    expect((await new DesktopUiPreferencesService().readPreferences()).preferences.projectDisplayNames).toEqual({})
  })

  test('rejects invalid project display name updates without overwriting stored names', async () => {
    const validReq = makeRequest('PUT', '/api/desktop-ui/preferences/project-display-name', {
      projectKey: '/workspace/alpha',
      displayName: 'Alpha',
    })
    expect((await handleDesktopUiApi(validReq.req, validReq.url, validReq.segments)).status).toBe(200)

    for (const [body, message] of [
      [{ projectKey: '', displayName: 'Replacement' }, 'projectKey must be a non-empty string up to 4096 characters'],
      [{ projectKey: '   ', displayName: 'Replacement' }, 'projectKey must be a non-empty string up to 4096 characters'],
      [{ projectKey: '/workspace/alpha', displayName: '   ' }, 'displayName must be a non-empty string up to 80 characters'],
      [{ projectKey: '/workspace/alpha', displayName: 42 }, 'displayName must be a non-empty string up to 80 characters'],
      [{ projectKey: '/workspace/alpha', displayName: 'n'.repeat(81) }, 'displayName must be a non-empty string up to 80 characters'],
      [{ projectKey: 'x'.repeat(4_097), displayName: 'Replacement' }, 'projectKey must be a non-empty string up to 4096 characters'],
    ] as const) {
      const invalidReq = makeRequest('PUT', '/api/desktop-ui/preferences/project-display-name', body)
      const invalidRes = await handleDesktopUiApi(invalidReq.req, invalidReq.url, invalidReq.segments)
      expect(invalidRes.status).toBe(400)
      await expect(invalidRes.json()).resolves.toMatchObject({
        error: 'BAD_REQUEST',
        message,
      })
    }

    expect((await new DesktopUiPreferencesService().readPreferences()).preferences.projectDisplayNames).toEqual({
      '/workspace/alpha': 'Alpha',
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
        schemaVersion: 6,
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

  test('returns 400 for malformed profile fields and preserves the prior profile', async () => {
    const validReq = makeRequest('PUT', '/api/desktop-ui/preferences/profile', {
      displayName: 'Local Operator',
      subtitle: 'operator.example',
    })
    const validRes = await handleDesktopUiApi(validReq.req, validReq.url, validReq.segments)
    expect(validRes.status).toBe(200)

    const invalidReq = makeRequest('PUT', '/api/desktop-ui/preferences/profile', {
      displayName: 42,
      subtitle: 'replacement.example',
    })
    const invalidRes = await handleDesktopUiApi(invalidReq.req, invalidReq.url, invalidReq.segments)

    expect(invalidRes.status).toBe(400)
    await expect(invalidRes.json()).resolves.toMatchObject({
      error: 'BAD_REQUEST',
      message: 'displayName must be a string',
    })
    await expect(readDesktopUiFile()).resolves.toMatchObject({
      profile: {
        displayName: 'Local Operator',
        subtitle: 'operator.example',
      },
    })
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

describe('DesktopUiPreferencesService voiceInput section', () => {
  beforeEach(setup)
  afterEach(teardown)

  async function writeDesktopUiFile(contents: Record<string, unknown>) {
    await fs.mkdir(path.join(tmpDir, 'cc-haha'), { recursive: true })
    await fs.writeFile(path.join(tmpDir, 'cc-haha', 'desktop-ui.json'), JSON.stringify(contents), 'utf-8')
  }

  test('normalizes old schema files without voiceInput and preserves unknown fields', async () => {
    await writeDesktopUiFile({
      schemaVersion: 5,
      futureField: { keep: true },
      pet: { ...DEFAULT_PET_PREFERENCES, enabled: true },
      sidebar: { projectOrder: ['/workspace/alpha'] },
    })

    const service = new DesktopUiPreferencesService()
    const read = await service.readPreferences()
    expect(read.exists).toBe(true)
    expect(read.preferences).toMatchObject({
      schemaVersion: 6,
      futureField: { keep: true },
      pet: { enabled: true },
      voiceInput: DEFAULT_VOICE_INPUT_PREFERENCES,
    })

    const after = await service.updateVoiceInputPreferences({ enabled: true, language: 'zh' })

    expect(after.voiceInput).toEqual({ enabled: true, providerId: 'sensevoice-local', language: 'zh', downloadSource: 'auto' })
    expect(await readDesktopUiFile()).toMatchObject({
      schemaVersion: 6,
      futureField: { keep: true },
      pet: { enabled: true },
      sidebar: { projectOrder: ['/workspace/alpha'] },
      voiceInput: { enabled: true, providerId: 'sensevoice-local', language: 'zh', downloadSource: 'auto' },
    })
  })

  test('turns voice input on only where enabled was never saved; a saved false stays off', async () => {
    // v0.6.8 shipped voice input off by default, and every write since then
    // stores `enabled` explicitly. The new default must not override that.
    await writeDesktopUiFile({
      schemaVersion: 6,
      sidebar: { projectOrder: ['/workspace/alpha'] },
      voiceInput: { enabled: false, providerId: 'sensevoice-local', language: 'zh', downloadSource: 'auto' },
    })
    const service = new DesktopUiPreferencesService()
    expect((await service.readPreferences()).preferences.voiceInput.enabled).toBe(false)

    await service.updateSidebarPreferences({ pinnedProjects: ['/workspace/alpha'] })
    await service.updateVoiceInputPreferences({ language: 'en' })
    expect((await readDesktopUiFile()).voiceInput).toMatchObject({ enabled: false, language: 'en' })

    // A section saved without the field, and a file with no section at all.
    await writeDesktopUiFile({ schemaVersion: 6, voiceInput: { providerId: 'sensevoice-local', language: 'zh' } })
    expect((await service.readPreferences()).preferences.voiceInput.enabled).toBe(true)
    await writeDesktopUiFile({ schemaVersion: 5, sidebar: { projectOrder: [] } })
    expect((await service.readPreferences()).preferences.voiceInput.enabled).toBe(true)
  })

  test('applies partial voice updates and keeps unknown voiceInput fields', async () => {
    await writeDesktopUiFile({
      schemaVersion: 6,
      voiceInput: {
        enabled: true,
        providerId: 'cloud-x',
        language: 'ja',
        futureVoiceField: { keep: 'voice' },
      },
    })

    const service = new DesktopUiPreferencesService()
    const after = await service.updateVoiceInputPreferences({ language: 'ko' })

    expect(after.voiceInput).toEqual({
      enabled: true,
      providerId: 'cloud-x',
      language: 'ko',
      downloadSource: 'auto',
      futureVoiceField: { keep: 'voice' },
    } as typeof after.voiceInput)
    expect((await service.readPreferences()).preferences.voiceInput).toEqual(after.voiceInput)
  })

  test('reads a voiceInput section saved before the download source existed as auto', async () => {
    await writeDesktopUiFile({
      schemaVersion: 6,
      voiceInput: { enabled: true, providerId: 'sensevoice-local', language: 'zh' },
    })

    const service = new DesktopUiPreferencesService()
    expect((await service.readPreferences()).preferences.voiceInput).toEqual({
      enabled: true,
      providerId: 'sensevoice-local',
      language: 'zh',
      downloadSource: 'auto',
    })

    const after = await service.updateVoiceInputPreferences({ downloadSource: 'mirror' })
    expect(after.voiceInput).toEqual({ enabled: true, providerId: 'sensevoice-local', language: 'zh', downloadSource: 'mirror' })
    expect((await readDesktopUiFile()).voiceInput).toEqual(after.voiceInput)
  })

  test('replaces malformed voiceInput values with defaults', async () => {
    await writeDesktopUiFile({
      schemaVersion: 6,
      voiceInput: { enabled: 'yes', providerId: '   ', language: 'fr', downloadSource: 'npmmirror' },
    })

    const service = new DesktopUiPreferencesService()
    expect((await service.readPreferences()).preferences.voiceInput).toEqual(DEFAULT_VOICE_INPUT_PREFERENCES)

    await writeDesktopUiFile({ schemaVersion: 6, voiceInput: 'garbage' })
    expect((await service.readPreferences()).preferences.voiceInput).toEqual(DEFAULT_VOICE_INPUT_PREFERENCES)

    const after = await service.updateVoiceInputPreferences({ enabled: 1, providerId: 'x'.repeat(200), language: 'zh' })
    expect(after.voiceInput).toEqual({ ...DEFAULT_VOICE_INPUT_PREFERENCES, language: 'zh' })
  })

  test('other preference updates keep the saved voiceInput section', async () => {
    const service = new DesktopUiPreferencesService()
    await service.updateVoiceInputPreferences({ enabled: true, language: 'en' })

    await service.updatePetPreferences({ enabled: true })
    await service.updateSidebarPreferences({ pinnedProjects: ['/workspace/alpha'] })
    await service.updateProfilePreferences({ displayName: 'Operator' })
    await service.updateProjectDisplayName({ projectKey: '/workspace/alpha', displayName: 'Alpha' })
    await service.clearProfileAvatar()

    expect((await readDesktopUiFile()).voiceInput).toEqual({
      enabled: true,
      providerId: 'sensevoice-local',
      language: 'en',
      downloadSource: 'auto',
    })
  })

  test('keeps a newer schemaVersion while filling in voiceInput defaults', async () => {
    await writeDesktopUiFile({ schemaVersion: 99, futureField: 1 })

    const read = await new DesktopUiPreferencesService().readPreferences()

    expect(read.preferences).toMatchObject({
      schemaVersion: 99,
      futureField: 1,
      voiceInput: DEFAULT_VOICE_INPUT_PREFERENCES,
    })
  })
})
