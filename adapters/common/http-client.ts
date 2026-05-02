export type SessionListItem = {
  id: string
  title: string
  createdAt: string
  modifiedAt: string
  messageCount: number
  projectPath: string
  workDir: string
  workDirExists: boolean
}

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
  /** Default timeout for HTTP requests (30 seconds) */
  private static readonly DEFAULT_TIMEOUT_MS = 30_000

  constructor(wsUrl: string) {
    this.httpBaseUrl = wsUrl
      .replace(/^ws:/, 'http:')
      .replace(/^wss:/, 'https:')
      .replace(/\/$/, '')
  }

  /** Create an AbortController with timeout */
  private createTimeoutController(timeoutMs = AdapterHttpClient.DEFAULT_TIMEOUT_MS): {
    controller: AbortController
    timer: ReturnType<typeof setTimeout>
  } {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    return { controller, timer }
  }

  async createSession(workDir: string): Promise<string> {
    const { controller, timer } = this.createTimeoutController()
    try {
      const res = await fetch(`${this.httpBaseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workDir }),
        signal: controller.signal,
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: res.statusText }))
        throw new Error(`Failed to create session: ${(err as any).message}`)
      }
      const data = (await res.json()) as { sessionId: string }
      return data.sessionId
    } finally {
      clearTimeout(timer)
    }
  }

  async listRecentProjects(): Promise<RecentProject[]> {
    const { controller, timer } = this.createTimeoutController()
    try {
      const res = await fetch(`${this.httpBaseUrl}/api/sessions/recent-projects`, {
        signal: controller.signal,
      })
      if (!res.ok) {
        throw new Error(`Failed to list projects: ${res.statusText}`)
      }
      const data = (await res.json()) as { projects: RecentProject[] }
      return data.projects
    } finally {
      clearTimeout(timer)
    }
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

  async listSessions(limit = 10, project?: string): Promise<SessionListItem[]> {
    const params = new URLSearchParams()
    params.set('limit', String(limit))
    if (project) params.set('project', project)
    const res = await fetch(`${this.httpBaseUrl}/api/sessions?${params}`)
    if (!res.ok) {
      throw new Error(`Failed to list sessions: ${res.statusText}`)
    }
    const data = (await res.json()) as { sessions: SessionListItem[] }
    return data.sessions
  }

  async getGitInfo(sessionId: string): Promise<GitInfo> {
    const { controller, timer } = this.createTimeoutController()
    try {
      const res = await fetch(`${this.httpBaseUrl}/api/sessions/${encodeURIComponent(sessionId)}/git-info`, {
        signal: controller.signal,
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: res.statusText }))
        throw new Error(`Failed to load git info: ${(err as any).message}`)
      }
      return (await res.json()) as GitInfo
    } finally {
      clearTimeout(timer)
    }
  }

  async getTasksForSession(sessionId: string): Promise<SessionTask[]> {
    const { controller, timer } = this.createTimeoutController()
    try {
      const res = await fetch(`${this.httpBaseUrl}/api/tasks/lists/${encodeURIComponent(sessionId)}`, {
        signal: controller.signal,
      })
      if (!res.ok) {
        if (res.status === 404) return []
        const err = await res.json().catch(() => ({ message: res.statusText }))
        throw new Error(`Failed to load tasks: ${(err as any).message}`)
      }
      const data = (await res.json()) as { tasks?: SessionTask[] }
      return Array.isArray(data.tasks) ? data.tasks : []
    } finally {
      clearTimeout(timer)
    }
  }
}
