import { api } from './client'

export type GitHubStatus = {
  connected: boolean
  username?: string
  avatar?: string
}

export type GitHubTokenInput = {
  token: string
}

export type GitHubTokenResult = {
  ok: true
  username: string
  avatar?: string
}

export const githubApi = {
  getStatus() {
    return api.get<GitHubStatus>('/api/github/status')
  },

  saveToken(input: GitHubTokenInput) {
    return api.post<GitHubTokenResult>('/api/github/token', input)
  },

  deleteToken() {
    return api.delete<{ ok: true }>('/api/github/token')
  },
}
