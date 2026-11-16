import { ApiError, api, getApiUrl, getAuthToken } from './client'
import type { VoicePreferences } from './voice'

export type SidebarProjectPreferences = {
  projectOrder: string[]
  pinnedProjects: string[]
  hiddenProjects: string[]
  projectOrganization: 'project' | 'recentProject' | 'time'
  projectSortBy: 'createdAt' | 'updatedAt'
}

export type DesktopProfilePreferences = {
  displayName: string
  subtitle: string
  avatarFile: string | null
  avatarUpdatedAt: string | null
}

export type SharedProfile = {
  displayName: string
  subtitle: string
  avatarDataUrl: string | null
}

export type DesktopPetPreferences = {
  enabled: boolean
  selectedPetId: string
  size: number
  showTaskPanel: boolean
  collapsed: boolean
  motionEnabled: boolean
  lastSessionId: string | null
}

export type DesktopWallpaperPreferences = {
  enabled: boolean
  /** Horizontal focal point, 0 (left) to 100 (right). */
  focusX: number
  /** Vertical focal point, 0 (top) to 100 (bottom). */
  focusY: number
  /** Magnification on top of the cover fit, 100 (native) to 300 (3×). */
  zoom: number
  blur: number
  panelOpacity: number
  file: string | null
  updatedAt: string | null
}

export type DesktopUiPreferences = {
  schemaVersion: number
  sidebar: SidebarProjectPreferences
  profile: DesktopProfilePreferences
  pet: DesktopPetPreferences
  /** Absent when talking to a server older than the wallpaper feature. */
  wallpaper?: DesktopWallpaperPreferences
  /** Absent when talking to a server older than the voice input feature. */
  voiceInput?: VoicePreferences
  projectDisplayNames: Record<string, string>
  projectAdditionalDirectories?: Record<string, string[]>
}

export type DesktopUiPreferencesResponse = {
  preferences: DesktopUiPreferences
  exists: boolean
}

export type DesktopPetPreferencesResponse = {
  exists: boolean
  pet: DesktopPetPreferences
}

export type DesktopPetPreferencesUpdateResponse =
  | { ok: true; preferences: DesktopUiPreferences }
  | { ok: true; pet: DesktopPetPreferences }

export type ProjectDisplayNameUpdateResponse = {
  ok: true
  projectKey: string
  displayName: string | null
}

export type ProjectDirectories = {
  projectKey: string
  mainDirectory: string
  additionalDirectories: string[]
}

export const desktopUiPreferencesApi = {
  getProjectDirectories(workDir: string) {
    return api.get<ProjectDirectories>(`/api/desktop-ui/preferences/project-directories?workDir=${encodeURIComponent(workDir)}`)
  },

  updateProjectDirectories(workDir: string, additionalDirectories: string[]) {
    return api.put<ProjectDirectories & { ok: true }>('/api/desktop-ui/preferences/project-directories', { workDir, additionalDirectories })
  },

  getProfile() {
    return api.get<{ profile: SharedProfile }>('/api/desktop-ui/preferences/profile')
  },

  getPreferences() {
    return api.get<DesktopUiPreferencesResponse>('/api/desktop-ui/preferences')
  },

  getPetPreferences() {
    return api.get<DesktopPetPreferencesResponse>('/api/desktop-ui/preferences/pet')
  },

  updateSidebarPreferences(sidebar: SidebarProjectPreferences) {
    return api.put<{ ok: true; preferences: DesktopUiPreferences }>(
      '/api/desktop-ui/preferences/sidebar',
      sidebar,
    )
  },

  updateProjectDisplayName(projectKey: string, displayName: string | null) {
    return api.put<ProjectDisplayNameUpdateResponse>(
      '/api/desktop-ui/preferences/project-display-name',
      { projectKey, displayName },
    )
  },

  updateProfilePreferences(profile: Pick<DesktopProfilePreferences, 'displayName' | 'subtitle'>) {
    return api.put<{ ok: true; preferences: DesktopUiPreferences }>(
      '/api/desktop-ui/preferences/profile',
      profile,
    )
  },

  updatePetPreferences(pet: Partial<DesktopPetPreferences>) {
    return api.put<DesktopPetPreferencesUpdateResponse>(
      '/api/desktop-ui/preferences/pet',
      pet,
    )
  },

  async uploadProfileAvatar(file: File) {
    return uploadProfileAvatar(file)
  },

  deleteProfileAvatar() {
    return api.delete<{ ok: true; preferences: DesktopUiPreferences }>(
      '/api/desktop-ui/preferences/profile/avatar',
    )
  },

  getWallpaperPreferences() {
    return api.get<{ exists: boolean; wallpaper: DesktopWallpaperPreferences }>(
      '/api/desktop-ui/preferences/wallpaper',
    )
  },

  updateWallpaperPreferences(wallpaper: Partial<Pick<DesktopWallpaperPreferences, 'enabled' | 'focusX' | 'focusY' | 'zoom' | 'blur' | 'panelOpacity'>>) {
    return api.put<{ ok: true; preferences: DesktopUiPreferences; wallpaper: DesktopWallpaperPreferences }>(
      '/api/desktop-ui/preferences/wallpaper',
      wallpaper,
    )
  },

  async uploadWallpaper(file: File) {
    return uploadWallpaper(file)
  },

  async getWallpaperImage() {
    const headers: Record<string, string> = {}
    const token = getAuthToken()
    if (token) {
      headers.Authorization = `Bearer ${token}`
    }

    const res = await fetch(getApiUrl('/api/desktop-ui/preferences/wallpaper/image'), { headers })
    if (!res.ok) {
      const body = await res.json().catch(() => res.text())
      throw new ApiError(res.status, body)
    }
    return res.blob()
  },

  deleteWallpaperImage() {
    return api.delete<{ ok: true; preferences: DesktopUiPreferences }>(
      '/api/desktop-ui/preferences/wallpaper/image',
    )
  },
}

export function getProfileAvatarUrl(updatedAt: string | null | undefined) {
  const suffix = updatedAt ? `?v=${encodeURIComponent(updatedAt)}` : ''
  return getApiUrl(`/api/desktop-ui/preferences/profile/avatar${suffix}`)
}

async function uploadProfileAvatar(file: File): Promise<{ ok: true; preferences: DesktopUiPreferences }> {
  const headers: Record<string, string> = {
    'Content-Type': file.type || 'application/octet-stream',
  }
  const token = getAuthToken()
  if (token) {
    headers.Authorization = `Bearer ${token}`
  }

  const res = await fetch(getApiUrl('/api/desktop-ui/preferences/profile/avatar'), {
    method: 'PUT',
    headers,
    body: file,
  })

  if (!res.ok) {
    const body = await res.json().catch(() => res.text())
    throw new ApiError(res.status, body)
  }

  return res.json() as Promise<{ ok: true; preferences: DesktopUiPreferences }>
}

async function uploadWallpaper(file: File): Promise<{ ok: true; preferences: DesktopUiPreferences }> {
  const headers: Record<string, string> = {
    'Content-Type': file.type || 'application/octet-stream',
  }
  const token = getAuthToken()
  if (token) {
    headers.Authorization = `Bearer ${token}`
  }

  const res = await fetch(getApiUrl('/api/desktop-ui/preferences/wallpaper/image'), {
    method: 'PUT',
    headers,
    body: file,
  })

  if (!res.ok) {
    const body = await res.json().catch(() => res.text())
    throw new ApiError(res.status, body)
  }

  return res.json() as Promise<{ ok: true; preferences: DesktopUiPreferences }>
}
