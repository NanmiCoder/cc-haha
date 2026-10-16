import { api } from './client'

export type HahaDeepSeekOAuthStatus =
  | { loggedIn: false }
  | {
      loggedIn: true
      name: string | null
      /** Masked email or mobile number of the signed-in account. */
      contact: string | null
    }

export const hahaDeepSeekOAuthApi = {
  /** `locale` only picks the language of the DeepSeek login page. */
  start(locale?: string) {
    return api.post<{ authorizeUrl: string; state: string }>(
      '/api/haha-deepseek-oauth/start',
      locale ? { locale } : {},
    )
  },

  status() {
    return api.get<HahaDeepSeekOAuthStatus>('/api/haha-deepseek-oauth')
  },

  logout() {
    return api.delete<{ ok: true }>('/api/haha-deepseek-oauth')
  },
}
