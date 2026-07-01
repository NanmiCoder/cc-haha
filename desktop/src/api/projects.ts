import { api, getApiUrl, getAuthToken } from './client'

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
  /** Up to ~20 repo-relative paths with uncommitted changes, most-recently-edited first. */
  dirtyFiles: string[]
}

export type RecentActivityResult = {
  hasActivity: boolean
  workDir: string
  lastSession?: RecentSessionDerived
  git?: RecentGitActivity
}

/**
 * Two-layer summary returned by /api/sessions/:id/summary. Generated
 * server-side via the user's active provider; cached on disk. Token
 * accounting fields are best-effort (some providers don't return them).
 */
export type SessionSummary = {
  sessionId: string
  generatedAt: string
  baseMessageCount: number
  modelUsed: string
  main: string
  recent: string
  tokensIn?: number
  tokensOut?: number
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

  /**
   * Read-only — returns cached summary, or null if none exists. Pass
   * `staleAt` to require regeneration if the live message count is higher
   * than the cached `baseMessageCount` (i.e. session continued).
   */
  getSessionSummary(
    sessionId: string,
    options?: { staleAt?: number },
  ): Promise<{ summary: SessionSummary | null }> {
    const params = new URLSearchParams()
    if (typeof options?.staleAt === 'number' && Number.isFinite(options.staleAt)) {
      params.set('staleAt', String(options.staleAt))
    }
    const query = params.toString()
    return api.get<{ summary: SessionSummary | null }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/summary${query ? `?${query}` : ''}`,
    )
  },

  /**
   * Generate (or fetch cached) summary. Pass `force: true` to bypass cache.
   * Throws on 5xx (e.g. provider not configured / generation failed).
   * Uses a generous 90s timeout — first generation against a long
   * transcript can take 30-60s with a slow upstream.
   */
  generateSessionSummary(
    sessionId: string,
    options?: { force?: boolean; staleAt?: number },
  ): Promise<{ summary: SessionSummary }> {
    const params = new URLSearchParams()
    if (options?.force) params.set('force', '1')
    if (typeof options?.staleAt === 'number' && Number.isFinite(options.staleAt)) {
      params.set('staleAt', String(options.staleAt))
    }
    const query = params.toString()
    return api.post<{ summary: SessionSummary }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/summary${query ? `?${query}` : ''}`,
      undefined,
      { timeout: 90_000 },
    )
  },

  /**
   * Resolve the best-available summary: try cached GET first (fast — never
   * blocks on the LLM), then fall back to POST generation. Used by the
   * "Continue from here" button to give the user instant resume when a
   * cached summary is on disk and only pay the LLM round-trip on first hit.
   */
  async resolveSessionSummaryForHandoff(
    sessionId: string,
  ): Promise<SessionSummary | null> {
    try {
      const cached = await this.getSessionSummary(sessionId)
      if (cached.summary) return cached.summary
    } catch {
      // Fall through to generation path on any GET error.
    }
    try {
      const fresh = await this.generateSessionSummary(sessionId)
      return fresh.summary
    } catch {
      return null
    }
  },

  /**
   * Permanently delete every .jsonl session file under the given project.
   * Pass an absolute workDir (the desktop sidebar's project key) — the
   * backend sanitizes it. If the project directory becomes empty, it is
   * removed so the project drops off the sidebar entirely. Non-.jsonl files
   * (memory/, user notes) are preserved.
   */
  clearSessions(workDir: string): Promise<{ ok: true; deletedSessions: number; projectDirRemoved: boolean }> {
    return api.post<{ ok: true; deletedSessions: number; projectDirRemoved: boolean }>(
      '/api/projects/sessions/clear',
      { workDir },
    )
  },

  /**
   * Stream a session's .jsonl transcript and trigger a browser download.
   * Returns the suggested filename so the caller can show it in a toast.
   */
  async exportSession(workDir: string, sessionId: string): Promise<{ filename: string; bytes: number }> {
    const params = new URLSearchParams({ workDir, sessionId })
    const url = getApiUrl(`/api/projects/sessions/export?${params.toString()}`)
    const token = getAuthToken()
    const headers: Record<string, string> = {}
    if (token) headers.Authorization = `Bearer ${token}`
    const res = await fetch(url, { headers })
    if (!res.ok) {
      let message = `Export failed (${res.status})`
      try {
        const body = await res.json() as { message?: string }
        if (body?.message) message = body.message
      } catch { /* ignore */ }
      throw new Error(message)
    }
    const blob = await res.blob()
    const filename = `${sessionId}.jsonl`
    // Trigger the download via a temporary <a download> click. Wrapped in a
    // window check so unit tests in non-jsdom envs don't blow up.
    if (typeof window !== 'undefined' && typeof document !== 'undefined') {
      const objectUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = objectUrl
      a.download = filename
      document.body.appendChild(a)
      a.click()
      a.remove()
      // Defer revoke so the click handler picks up the URL first.
      setTimeout(() => URL.revokeObjectURL(objectUrl), 0)
    }
    return { filename, bytes: blob.size }
  },

  /**
   * Fetch a session's JSONL export as a raw Blob (no download trigger).
   * Used by batch export to collect multiple sessions before zipping.
   */
  async exportSessionBlob(workDir: string, sessionId: string): Promise<{ filename: string; blob: Blob }> {
    const params = new URLSearchParams({ workDir, sessionId })
    const url = getApiUrl(`/api/projects/sessions/export?${params.toString()}`)
    const token = getAuthToken()
    const headers: Record<string, string> = {}
    if (token) headers.Authorization = `Bearer ${token}`
    const res = await fetch(url, { headers })
    if (!res.ok) {
      let message = `Export failed (${res.status})`
      try {
        const body = await res.json() as { message?: string }
        if (body?.message) message = body.message
      } catch { /* ignore */ }
      throw new Error(message)
    }
    const blob = await res.blob()
    const filename = `${sessionId}.jsonl`
    return { filename, blob }
  },

  /**
   * Upload a .jsonl transcript and import it as a new session under the
   * given project (workDir). Returns the new server-side session id.
   */
  async importSession(workDir: string, file: File | Blob, fileName?: string): Promise<{
    sessionId: string
    projectId: string
    bytes: number
    nonEmptyLines: number
  }> {
    const form = new FormData()
    form.set('workDir', workDir)
    if (file instanceof File) {
      form.set('file', file)
    } else {
      form.set('file', file, fileName ?? 'session.jsonl')
    }
    const url = getApiUrl('/api/projects/sessions/import')
    const token = getAuthToken()
    const headers: Record<string, string> = {}
    if (token) headers.Authorization = `Bearer ${token}`
    const res = await fetch(url, { method: 'POST', body: form, headers })
    const data = await res.json().catch(() => ({})) as Record<string, unknown>
    if (!res.ok) {
      const message = typeof data?.message === 'string' ? data.message : `Import failed (${res.status})`
      throw new Error(message)
    }
    return data as { sessionId: string; projectId: string; bytes: number; nonEmptyLines: number }
  },
}
