export type RecentProject = {
  projectPath: string
  realPath: string
  projectName: string
  isGit: boolean
  repoName: string | null
  branch: string | null
  modifiedAt: string
  sessionCount: number
}

export type GitInfo = {
  branch: string | null
  repoName: string | null
  workDir: string
  changedFiles: number
}

export type SessionTask = {
  id: string
  subject: string
  status: 'pending' | 'in_progress' | 'completed'
}

export class AdapterHttpClient {
  readonly httpBaseUrl: string

  constructor(wsUrl: string) {
    this.httpBaseUrl = wsUrl
      .replace(/^ws:/, 'http:')
      .replace(/^wss:/, 'https:')
      .replace(/\/$/, '')
  }

  async createSession(workDir: string): Promise<string> {
    const res = await fetch(`${this.httpBaseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workDir }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: res.statusText }))
      throw new Error(`Failed to create session: ${(err as any).message}`)
    }
    const data = (await res.json()) as { sessionId: string }
    return data.sessionId
  }

  async listRecentProjects(): Promise<RecentProject[]> {
    const res = await fetch(`${this.httpBaseUrl}/api/sessions/recent-projects`)
    if (!res.ok) {
      throw new Error(`Failed to list projects: ${res.statusText}`)
    }
    const data = (await res.json()) as { projects: RecentProject[] }
    return data.projects
  }

  /**
   * Match a project by index (1-based) or fuzzy name from recent projects.
   * Returns { project, ambiguous[] } — ambiguous is set when multiple projects match.
   */
  async matchProject(query: string): Promise<{ project?: RecentProject; ambiguous?: RecentProject[] }> {
    const projects = await this.listRecentProjects()

    // Try as 1-based index
    const num = parseInt(query, 10)
    if (!isNaN(num) && num >= 1 && num <= projects.length && String(num) === query.trim()) {
      return { project: projects[num - 1] }
    }

    const q = query.toLowerCase()

    // Exact project name match
    const exact = projects.find(p => p.projectName.toLowerCase() === q)
    if (exact) return { project: exact }

    // Fuzzy: name or path contains query
    const matches = projects.filter(p =>
      p.projectName.toLowerCase().includes(q) ||
      p.realPath.toLowerCase().includes(q)
    )
    if (matches.length === 1) return { project: matches[0] }
    if (matches.length > 1) return { ambiguous: matches }

    return {}
  }

  async getGitInfo(sessionId: string): Promise<GitInfo> {
    const res = await fetch(`${this.httpBaseUrl}/api/sessions/${encodeURIComponent(sessionId)}/git-info`)
    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: res.statusText }))
      throw new Error(`Failed to load git info: ${(err as any).message}`)
    }
    return (await res.json()) as GitInfo
  }

  async getTasksForSession(sessionId: string): Promise<SessionTask[]> {
    const res = await fetch(`${this.httpBaseUrl}/api/tasks/lists/${encodeURIComponent(sessionId)}`)
    if (!res.ok) {
      if (res.status === 404) return []
      const err = await res.json().catch(() => ({ message: res.statusText }))
      throw new Error(`Failed to load tasks: ${(err as any).message}`)
    }
    const data = (await res.json()) as { tasks?: SessionTask[] }
    return Array.isArray(data.tasks) ? data.tasks : []
  }
}
