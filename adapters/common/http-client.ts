import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

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

export type SessionListItem = {
  id: string
  title: string
  createdAt: string
  modifiedAt: string
  messageCount: number
  projectPath: string
  projectRoot?: string | null
  workDir: string | null
  workDirExists: boolean
  permissionMode?: string
}

export type ProviderSummary = {
  id: string
  name: string
  presetId?: string
  models?: {
    main?: string
    haiku?: string
    sonnet?: string
    opus?: string
  }
}

export type ModelSummary = {
  id: string
  name: string
  description: string
  context: string
}

export type SkillSummary = {
  name: string
  displayName?: string
  description: string
  source: 'user' | 'project' | 'plugin'
  userInvocable: boolean
  version?: string
  contentLength: number
  hasDirectory: boolean
  pluginName?: string
}

export class AdapterHttpClient {
  readonly httpBaseUrl: string
  private readonly allowedProjectRoots: string[]
  private readonly localAccessToken: string | null
  /** Default timeout for HTTP requests (30 seconds) */
  private static readonly DEFAULT_TIMEOUT_MS = 30_000

  constructor(
    wsUrl: string,
    options?: { allowedProjectRoots?: string[], localAccessToken?: string },
  ) {
    this.httpBaseUrl = wsUrl
      .replace(/^ws:/, 'http:')
      .replace(/^wss:/, 'https:')
      .replace(/\/$/, '')
    this.allowedProjectRoots = (options?.allowedProjectRoots ?? [])
      .map(resolveExistingProjectPath)
      .filter((value): value is string => Boolean(value))
    this.localAccessToken = options?.localAccessToken?.trim() ||
      process.env.CC_HAHA_LOCAL_ACCESS_TOKEN?.trim() ||
      null
  }

  private request(pathname: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    if (this.localAccessToken) {
      headers.set('Authorization', `Bearer ${this.localAccessToken}`)
    }
    return fetch(`${this.httpBaseUrl}${pathname}`, { ...init, headers })
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
    const allowedWorkDir = this.resolveAllowedProjectPath(workDir)
    if (!allowedWorkDir) {
      throw new Error('Failed to create session: workDir is outside the configured project roots')
    }

    const { controller, timer } = this.createTimeoutController()
    try {
      const res = await this.request('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Omit permissionMode on purpose: the server falls back to the user's
        // global default mode at launch (ws/handler.ts). Hardcoding a mode here
        // would pin every IM-created session regardless of the user's setting.
        body: JSON.stringify({ workDir: allowedWorkDir }),
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

  async sessionExists(sessionId: string): Promise<boolean> {
    const { controller, timer } = this.createTimeoutController()
    try {
      const res = await this.request(`/api/sessions/${encodeURIComponent(sessionId)}`, {
        signal: controller.signal,
      })
      if (res.status === 404) return false
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: res.statusText }))
        throw new Error(`Failed to check session: ${(err as any).message}`)
      }
      const data = (await res.json()) as {
        workDir?: string
        permissionMode?: string
      }
      return this.isSafeRemoteSession(data)
    } finally {
      clearTimeout(timer)
    }
  }

  async listRecentProjects(): Promise<RecentProject[]> {
    const { controller, timer } = this.createTimeoutController()
    try {
      const res = await this.request('/api/sessions/recent-projects', {
        signal: controller.signal,
      })
      if (!res.ok) {
        throw new Error(`Failed to list projects: ${res.statusText}`)
      }
      const data = (await res.json()) as { projects: RecentProject[] }
      return data.projects.filter((project) =>
        this.resolveAllowedProjectPath(project.realPath || project.projectPath),
      )
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Match a project by index (1-based) or fuzzy name from recent projects.
   * Returns { project, ambiguous[] } — ambiguous is set when multiple projects match.
   */
  async matchProject(query: string): Promise<{ project?: RecentProject; ambiguous?: RecentProject[] }> {
    const resolvedDirectPath = resolveExistingProjectPath(query)
    if (resolvedDirectPath) {
      const directPath = this.resolveAllowedProjectPath(resolvedDirectPath)
      if (!directPath) return {}

      return {
        project: {
          projectPath: directPath,
          realPath: directPath,
          projectName: path.basename(directPath) || directPath,
          isGit: fs.existsSync(path.join(directPath, '.git')),
          repoName: null,
          branch: null,
          modifiedAt: new Date().toISOString(),
          sessionCount: 0,
        },
      }
    }

    const projects = await this.listRecentProjects()

    // Try as 1-based index
    const num = parseInt(query, 10)
    if (!isNaN(num) && num >= 1 && num <= projects.length && String(num) === query.trim()) {
      return { project: projects[num - 1] }
    }

    const q = query.toLowerCase()

    // Exact project name match. Different roots can contain repositories with
    // the same basename, so an exact name is still ambiguous when it identifies
    // more than one canonical project.
    const exact = projects.filter(p => p.projectName.toLowerCase() === q)
    if (exact.length === 1) return { project: exact[0] }
    if (exact.length > 1) return { ambiguous: exact }

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
    const { controller, timer } = this.createTimeoutController()
    try {
      const res = await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/git-info`, {
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
      const res = await this.request(`/api/tasks/lists/${encodeURIComponent(sessionId)}`, {
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

  async listSessions(options?: {
    project?: string
    limit?: number
    offset?: number
  }): Promise<{ sessions: SessionListItem[]; total: number }> {
    if (options?.project && !this.resolveAllowedProjectPath(options.project)) {
      return { sessions: [], total: 0 }
    }

    const params = new URLSearchParams()
    if (options?.project) params.set('project', options.project)
    if (options?.limit !== undefined) params.set('limit', String(options.limit))
    if (options?.offset !== undefined) params.set('offset', String(options.offset))
    const suffix = params.toString() ? `?${params.toString()}` : ''

    const { controller, timer } = this.createTimeoutController()
    try {
      const res = await this.request(`/api/sessions${suffix}`, {
        signal: controller.signal,
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: res.statusText }))
        throw new Error(`Failed to list sessions: ${(err as any).message}`)
      }
      const data = (await res.json()) as { sessions: SessionListItem[]; total: number }
      const sessions = data.sessions.filter((session) => this.isSafeRemoteSession({
        workDir: session.workDir,
        permissionMode: session.permissionMode,
      }))
      // total counts server candidates before the local safety filter. Keep it
      // for offset pagination, including pages with no locally allowed sessions.
      return { sessions, total: data.total }
    } finally {
      clearTimeout(timer)
    }
  }

  async listProviders(): Promise<{ providers: ProviderSummary[]; activeId: string | null }> {
    const { controller, timer } = this.createTimeoutController()
    try {
      const res = await this.request('/api/providers', {
        signal: controller.signal,
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: res.statusText }))
        throw new Error(`Failed to list providers: ${(err as any).message}`)
      }
      return (await res.json()) as { providers: ProviderSummary[]; activeId: string | null }
    } finally {
      clearTimeout(timer)
    }
  }

  async activateProvider(providerId: string): Promise<void> {
    await this.postJson(`/api/providers/${encodeURIComponent(providerId)}/activate`)
  }

  async activateOfficialProvider(): Promise<void> {
    await this.postJson('/api/providers/official')
  }

  async listModels(): Promise<{ models: ModelSummary[]; provider: { id: string; name: string } | null }> {
    const { controller, timer } = this.createTimeoutController()
    try {
      const res = await this.request('/api/models', {
        signal: controller.signal,
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: res.statusText }))
        throw new Error(`Failed to list models: ${(err as any).message}`)
      }
      return (await res.json()) as { models: ModelSummary[]; provider: { id: string; name: string } | null }
    } finally {
      clearTimeout(timer)
    }
  }

  async getCurrentModel(): Promise<{ model: ModelSummary }> {
    const { controller, timer } = this.createTimeoutController()
    try {
      const res = await this.request('/api/models/current', {
        signal: controller.signal,
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: res.statusText }))
        throw new Error(`Failed to get current model: ${(err as any).message}`)
      }
      return (await res.json()) as { model: ModelSummary }
    } finally {
      clearTimeout(timer)
    }
  }

  async setCurrentModel(modelId: string): Promise<void> {
    await this.putJson('/api/models/current', { modelId })
  }

  async listSkills(cwd: string): Promise<{ skills: SkillSummary[] }> {
    const allowedCwd = this.resolveAllowedProjectPath(cwd)
    if (!allowedCwd) {
      throw new Error('Failed to list skills: cwd is outside the configured project roots')
    }

    const params = new URLSearchParams({ cwd: allowedCwd })
    const { controller, timer } = this.createTimeoutController()
    try {
      const res = await this.request(`/api/skills?${params.toString()}`, {
        signal: controller.signal,
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: res.statusText }))
        throw new Error(`Failed to list skills: ${(err as any).message}`)
      }
      return (await res.json()) as { skills: SkillSummary[] }
    } finally {
      clearTimeout(timer)
    }
  }

  private async postJson(pathname: string): Promise<void> {
    const { controller, timer } = this.createTimeoutController()
    try {
      const res = await this.request(pathname, {
        method: 'POST',
        signal: controller.signal,
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: res.statusText }))
        throw new Error(`Request failed: ${(err as any).message}`)
      }
    } finally {
      clearTimeout(timer)
    }
  }

  private async putJson(pathname: string, body: Record<string, unknown>): Promise<void> {
    const { controller, timer } = this.createTimeoutController()
    try {
      const res = await this.request(pathname, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: res.statusText }))
        throw new Error(`Request failed: ${(err as any).message}`)
      }
    } finally {
      clearTimeout(timer)
    }
  }

  private resolveAllowedProjectPath(value: string | null | undefined): string | null {
    if (!value) return null
    const resolved = resolveExistingProjectPath(value)
    if (!resolved || !isPathWithinAllowedRoots(resolved, this.allowedProjectRoots)) {
      return null
    }
    return resolved
  }

  private isSafeRemoteSession(
    status: { workDir?: string | null; permissionMode?: string } | undefined,
  ): boolean {
    if (!status?.workDir || status.permissionMode === 'bypassPermissions') {
      return false
    }
    return Boolean(this.resolveAllowedProjectPath(status.workDir))
  }
}

function isPathWithinAllowedRoots(target: string, roots: string[]): boolean {
  if (roots.length === 0) return false

  for (const root of roots) {
    const relative = path.relative(root, target)
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
      return true
    }
  }

  return false
}

function resolveExistingProjectPath(query: string): string | null {
  const trimmed = query.trim()
  if (!trimmed) return null

  const expanded = trimmed === '~'
    ? os.homedir()
    : trimmed.startsWith('~/')
      ? path.join(os.homedir(), trimmed.slice(2))
      : trimmed

  if (!path.isAbsolute(expanded)) return null

  try {
    const realPath = fs.realpathSync(expanded)
    return fs.statSync(realPath).isDirectory() ? realPath : null
  } catch {
    return null
  }
}
