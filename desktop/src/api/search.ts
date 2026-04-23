import { api } from './client'

type SearchResult = {
  file: string
  line: number
  text: string
  context?: string[]
}

type SearchResponse = { results: SearchResult[]; total: number }

type SessionSearchResult = {
  sessionId: string
  title: string
  matchCount: number
  matches: Array<{ line: number; text: string }>
}

type SessionSearchResponse = { results: SessionSearchResult[] }

export const searchApi = {
  search(params: { query: string; cwd?: string; maxResults?: number; glob?: string }) {
    return api.post<SearchResponse>('/api/search', params)
  },

  searchSessions(query: string) {
    return api.post<SessionSearchResponse>('/api/search/sessions', { query })
  },
}
