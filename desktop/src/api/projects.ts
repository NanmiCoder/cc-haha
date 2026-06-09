import { api } from './client'

export type RecentSessionDerived = {
  sessionId: string
  title: string
  modifiedAt: string
  messageCount: number
  lastUserMessageExcerpt?: string
  filesEditedCount: number
  filesEditedSample: string[]
}

export type RecentGitActivity = {
  branch: string | null
  defaultBranch: string | null
  aheadCount: number
  behindCount: number
  dirtyCount: number
}

export type RecentActivityResult = {
  hasActivity: boolean
  workDir: string
  lastSession?: RecentSessionDerived
  git?: RecentGitActivity
}

export const projectsApi = {
  recentActivity(
    workDir: string,
    options?: { excludeSessionId?: string },
  ): Promise<RecentActivityResult> {
    const params = new URLSearchParams({ workDir })
    if (options?.excludeSessionId) {
      params.set('excludeSessionId', options.excludeSessionId)
    }
    return api.get<RecentActivityResult>(
      `/api/projects/recent-activity?${params.toString()}`,
    )
  },
}
