import { api } from './client'

type SearchResult = {
  file: string
  line: number
  text: string
  context?: string[]
}

type SearchResponse = { results: SearchResult[]; total: number }

export type SessionMatchRole = 'user' | 'assistant'

export type SessionMatch = {
  role: SessionMatchRole
  messageId: string | null
  lineNumber: number
  snippet: string
  highlights: Array<{ start: number; end: number }>
  timestamp?: string
}

export type SessionSearchResult = {
  sessionId: string
  title: string
  projectPath: string
  workDir: string | null
  modifiedAt: string
  matchCount: number
  matches: SessionMatch[]
}

export type SessionSearchResponse = {
  results: SessionSearchResult[]
  total: number
  truncated: boolean
}

export type SessionSearchOptions = {
  limit?: number
  matchesPerSession?: number
  caseSensitive?: boolean
}

export const searchApi = {
  search(params: { query: string; cwd?: string; maxResults?: number; glob?: string }) {
    return api.post<SearchResponse>('/api/search', params)
  },

  searchSessions(query: string, options?: SessionSearchOptions) {
    return api.post<SessionSearchResponse>('/api/search/sessions', { query, ...options })
  },
}
