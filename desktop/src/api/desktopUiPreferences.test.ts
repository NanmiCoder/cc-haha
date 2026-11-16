import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultBaseUrl, setAuthToken, setBaseUrl } from './client'
import { desktopUiPreferencesApi, getProfileAvatarUrl } from './desktopUiPreferences'

const preferences = {
  schemaVersion: 3,
  projectDisplayNames: {},
  profile: {
    displayName: 'cc-haha',
    subtitle: 'github.com/NanmiCoder/cc-haha',
    avatarFile: null,
    avatarUpdatedAt: null,
  },
  pet: {
    enabled: false,
    selectedPetId: 'dada-code',
    size: 144,
    showTaskPanel: false,
    collapsed: false,
    motionEnabled: true,
    lastSessionId: null,
  },
  sidebar: {
    projectOrder: [],
    pinnedProjects: [],
    hiddenProjects: [],
    projectOrganization: 'recentProject',
    projectSortBy: 'updatedAt',
  },
}

describe('desktopUiPreferencesApi', () => {
  afterEach(() => {
    setAuthToken(null)
    setBaseUrl(getDefaultBaseUrl())
    vi.restoreAllMocks()
  })

  it('saves server-owned directory configuration and encodes space, Unicode and Windows paths when reloading', async () => {
    setBaseUrl('http://127.0.0.1:49237')
    const project = { projectKey: 'C:\\代码 space', mainDirectory: 'C:\\代码 space', additionalDirectories: ['C:\\数据 files'] }
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(project), { status: 200 }))
    await expect(desktopUiPreferencesApi.updateProjectDirectories(project.mainDirectory, project.additionalDirectories)).resolves.toEqual(project)
    await expect(desktopUiPreferencesApi.getProjectDirectories(project.mainDirectory)).resolves.toEqual(project)
    expect(fetchMock).toHaveBeenNthCalledWith(1, 'http://127.0.0.1:49237/api/desktop-ui/preferences/project-directories', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ workDir: project.mainDirectory, additionalDirectories: project.additionalDirectories }) }))
    expect(fetchMock).toHaveBeenNthCalledWith(2, `http://127.0.0.1:49237/api/desktop-ui/preferences/project-directories?workDir=${encodeURIComponent(project.mainDirectory)}`, expect.objectContaining({ method: 'GET' }))
  })

  it('loads only the shareable profile through its read-only endpoint', async () => {
    setBaseUrl('http://127.0.0.1:49237')
    const profile = { displayName: 'Ada', subtitle: 'My activity', avatarDataUrl: null }
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ profile }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    await expect(desktopUiPreferencesApi.getProfile()).resolves.toEqual({ profile })
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:49237/api/desktop-ui/preferences/profile',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('sends only the requested pet preference fields through the pet endpoint', async () => {
    setBaseUrl('http://127.0.0.1:49237')
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, preferences }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const pet = { size: 160, lastSessionId: 'session-42' }

    await expect(desktopUiPreferencesApi.updatePetPreferences(pet)).resolves.toEqual({
      ok: true,
      preferences,
    })

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:49237/api/desktop-ui/preferences/pet',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify(pet),
      }),
    )
  })

  it('updates project display names and sends null to reset one', async () => {
    setBaseUrl('http://127.0.0.1:49237')
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        projectKey: '/workspace/apps/../project',
        displayName: 'Project alias',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        projectKey: '/workspace/apps/../project',
        displayName: null,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))

    await expect(desktopUiPreferencesApi.updateProjectDisplayName(
      '/workspace/apps/../project',
      'Project alias',
    )).resolves.toEqual({
      ok: true,
      projectKey: '/workspace/apps/../project',
      displayName: 'Project alias',
    })
    await expect(desktopUiPreferencesApi.updateProjectDisplayName(
      '/workspace/apps/../project',
      null,
    )).resolves.toEqual({
      ok: true,
      projectKey: '/workspace/apps/../project',
      displayName: null,
    })

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:49237/api/desktop-ui/preferences/project-display-name',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ projectKey: '/workspace/apps/../project', displayName: 'Project alias' }),
      }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:49237/api/desktop-ui/preferences/project-display-name',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ projectKey: '/workspace/apps/../project', displayName: null }),
      }),
    )
  })

  it('reads only the pet projection through the scoped preference endpoint', async () => {
    setBaseUrl('http://127.0.0.1:49237')
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ exists: true, pet: preferences.pet }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await expect(desktopUiPreferencesApi.getPetPreferences()).resolves.toEqual({ exists: true, pet: preferences.pet })
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:49237/api/desktop-ui/preferences/pet',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('wraps preference reads and profile updates with the configured API base URL', async () => {
    setBaseUrl('http://127.0.0.1:49237')
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ exists: true, preferences }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, preferences }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, preferences }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))

    await expect(desktopUiPreferencesApi.getPreferences()).resolves.toEqual({ exists: true, preferences })
    await expect(desktopUiPreferencesApi.updateProfilePreferences({
      displayName: 'Local Captain',
      subtitle: 'local.example',
    })).resolves.toEqual({
      ok: true,
      preferences,
    })
    await expect(desktopUiPreferencesApi.deleteProfileAvatar()).resolves.toEqual({ ok: true, preferences })

    expect(fetchMock).toHaveBeenNthCalledWith(1, 'http://127.0.0.1:49237/api/desktop-ui/preferences', expect.objectContaining({
      method: 'GET',
    }))
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'http://127.0.0.1:49237/api/desktop-ui/preferences/profile', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ displayName: 'Local Captain', subtitle: 'local.example' }),
    }))
    expect(fetchMock).toHaveBeenNthCalledWith(3, 'http://127.0.0.1:49237/api/desktop-ui/preferences/profile/avatar', expect.objectContaining({
      method: 'DELETE',
    }))
  })

  it('uploads profile avatars with the file content type and auth token', async () => {
    setBaseUrl('http://127.0.0.1:49237')
    setAuthToken('h5_avatar_token')
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, preferences }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    const file = new File([new Uint8Array([137, 80, 78, 71])], 'avatar.png', { type: 'image/png' })
    await expect(desktopUiPreferencesApi.uploadProfileAvatar(file)).resolves.toEqual({ ok: true, preferences })

    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('http://127.0.0.1:49237/api/desktop-ui/preferences/profile/avatar')
    expect(init).toMatchObject({
      method: 'PUT',
      headers: {
        'Content-Type': 'image/png',
        Authorization: 'Bearer h5_avatar_token',
      },
      body: file,
    })
  })

  it('surfaces avatar upload API errors and builds cache-busted avatar URLs', async () => {
    setBaseUrl('http://127.0.0.1:49237')
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ message: 'Too large' }), {
      status: 413,
      headers: { 'Content-Type': 'application/json' },
    }))

    const file = new File(['bad'], 'avatar.bin', { type: '' })
    await expect(desktopUiPreferencesApi.uploadProfileAvatar(file)).rejects.toThrow('Too large')

    const [, init] = fetchMock.mock.calls[0]!
    expect(init).toMatchObject({
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
      },
      body: file,
    })
    expect(getProfileAvatarUrl('2026-05-30T15:37:51.649Z')).toBe(
      'http://127.0.0.1:49237/api/desktop-ui/preferences/profile/avatar?v=2026-05-30T15%3A37%3A51.649Z',
    )
    expect(getProfileAvatarUrl(null)).toBe('http://127.0.0.1:49237/api/desktop-ui/preferences/profile/avatar')
  })

  it('patches and deletes wallpaper settings through the wallpaper endpoints', async () => {
    setBaseUrl('http://127.0.0.1:49237')
    const wallpaper = { enabled: true, focusX: 30, focusY: 70, zoom: 140, blur: 10, panelOpacity: 90, file: 'wallpaper.jpg', updatedAt: '2026-11-11T00:00:00.000Z' }
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, preferences, wallpaper }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, preferences }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))

    await expect(
      desktopUiPreferencesApi.updateWallpaperPreferences({ focusX: 30, zoom: 140, blur: 10 }),
    ).resolves.toEqual({
      ok: true,
      preferences,
      wallpaper,
    })
    await expect(desktopUiPreferencesApi.deleteWallpaperImage()).resolves.toEqual({ ok: true, preferences })

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:49237/api/desktop-ui/preferences/wallpaper',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ focusX: 30, zoom: 140, blur: 10 }),
      }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:49237/api/desktop-ui/preferences/wallpaper/image',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('uploads wallpaper bytes with auth and reads the image back as a blob', async () => {
    setBaseUrl('http://127.0.0.1:49237')
    setAuthToken('h5_wallpaper_token')
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, preferences }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(new Uint8Array([137, 80, 78, 71]), {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      }))

    const file = new File([new Uint8Array([137, 80, 78, 71])], 'wallpaper.png', { type: 'image/png' })
    await expect(desktopUiPreferencesApi.uploadWallpaper(file)).resolves.toEqual({ ok: true, preferences })
    const blob = await desktopUiPreferencesApi.getWallpaperImage()
    expect(blob.type).toBe('image/png')
    expect(blob.size).toBe(4)

    const [uploadUrl, uploadInit] = fetchMock.mock.calls[0]!
    expect(uploadUrl).toBe('http://127.0.0.1:49237/api/desktop-ui/preferences/wallpaper/image')
    expect(uploadInit).toMatchObject({
      method: 'PUT',
      headers: {
        'Content-Type': 'image/png',
        Authorization: 'Bearer h5_wallpaper_token',
      },
      body: file,
    })
    expect(fetchMock.mock.calls[1]![1]).toMatchObject({
      headers: { Authorization: 'Bearer h5_wallpaper_token' },
    })
  })

  it('surfaces wallpaper image read errors', async () => {
    setBaseUrl('http://127.0.0.1:49237')
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ message: 'Wallpaper image is not configured' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    }))

    await expect(desktopUiPreferencesApi.getWallpaperImage()).rejects.toThrow('Wallpaper image is not configured')
  })
})
