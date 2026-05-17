import { api } from './client'

export type SidebarProjectPreferences = {
  projectOrder: string[]
  pinnedProjects: string[]
  hiddenProjects: string[]
  projectOrganization: 'project' | 'recentProject' | 'time'
  projectSortBy: 'createdAt' | 'updatedAt'
}

export type DesktopUiPreferences = {
  schemaVersion: number
  sidebar: SidebarProjectPreferences
}

export type DesktopUiPreferencesResponse = {
  preferences: DesktopUiPreferences
  exists: boolean
}

export const desktopUiPreferencesApi = {
  getPreferences() {
    return api.get<DesktopUiPreferencesResponse>('/api/desktop-ui/preferences')
  },

  updateSidebarPreferences(sidebar: SidebarProjectPreferences) {
    return api.put<{ ok: true; preferences: DesktopUiPreferences }>(
      '/api/desktop-ui/preferences/sidebar',
      sidebar,
    )
  },
}
