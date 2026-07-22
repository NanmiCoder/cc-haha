import { ApiError, api, getApiUrl, getAuthToken } from './client'

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

export type DesktopPetPreferences = {
  enabled: boolean
  selectedPetId: string
  size: number
  showTaskPanel: boolean
  collapsed: boolean
  motionEnabled: boolean
  lastSessionId: string | null
}

export type DesktopUiPreferences = {
  schemaVersion: number
  sidebar: SidebarProjectPreferences
  profile: DesktopProfilePreferences
  pet: DesktopPetPreferences
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

export const desktopUiPreferencesApi = {
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
