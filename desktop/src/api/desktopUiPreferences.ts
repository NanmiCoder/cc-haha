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

export type UsageSidebarVisibility = 'auto' | 'always' | 'hidden'
export type UsageDisplayMode = 'remaining' | 'used'

export type DesktopUsageWidgetPreferences = {
  sidebarVisibility: UsageSidebarVisibility
  displayMode: UsageDisplayMode
  showExactResetTime: boolean
  floatingEnabled: boolean
  floatingCompact: boolean
  floatingAlwaysOnTop: boolean
  menuBarEnabled: boolean
  pinnedMetricKeys: string[]
}

export const DEFAULT_DESKTOP_USAGE_WIDGET_PREFERENCES: DesktopUsageWidgetPreferences = {
  sidebarVisibility: 'auto',
  displayMode: 'remaining',
  showExactResetTime: false,
  floatingEnabled: false,
  floatingCompact: false,
  floatingAlwaysOnTop: true,
  menuBarEnabled: false,
  pinnedMetricKeys: ['claude-official:five_hour', 'openai-official:five_hour'],
}

export type DesktopUiPreferences = {
  schemaVersion: number
  sidebar: SidebarProjectPreferences
  profile: DesktopProfilePreferences
  pet: DesktopPetPreferences
  /** Absent when talking to a server older than the voice input feature. */
  voiceInput?: VoicePreferences
  /** Absent when talking to a server older than the usage widget feature. */
  usageWidget?: DesktopUsageWidgetPreferences
  projectDisplayNames: Record<string, string>
  projectAdditionalDirectories?: Record<string, string[]>
  explicitProjectRoots?: string[]
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
  getProjectDirectories(workDir: string, options?: { createProject?: boolean }) {
    return api.get<ProjectDirectories>(`/api/desktop-ui/preferences/project-directories?workDir=${encodeURIComponent(workDir)}${options?.createProject ? '&createProject=true' : ''}`)
  },

  updateProjectDirectories(workDir: string, additionalDirectories: string[], options?: { createProject?: boolean }) {
    return api.put<ProjectDirectories & { ok: true }>('/api/desktop-ui/preferences/project-directories', { workDir, additionalDirectories, ...options })
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

  getUsageWidgetPreferences() {
    return api.get<{ exists: boolean; usageWidget: DesktopUsageWidgetPreferences }>(
      '/api/desktop-ui/preferences/usage-widget',
    )
  },

  updateUsageWidgetPreferences(usageWidget: Partial<DesktopUsageWidgetPreferences>) {
    return api.put<{ ok: true; preferences: DesktopUiPreferences; usageWidget: DesktopUsageWidgetPreferences }>(
      '/api/desktop-ui/preferences/usage-widget',
      usageWidget,
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
