// Only the local provider proxy sets this after an upstream explicitly rejects
// the saved key. The CLI checks the request route before trusting it.
export const INVALID_PROVIDER_KEY_HEADER = 'x-cc-haha-invalid-provider-key'

export function isInvalidSavedProviderKey(status: number, payload: unknown): boolean {
  if (status !== 401 || !payload || typeof payload !== 'object' || Array.isArray(payload)) return false
  const root = payload as Record<string, unknown>
  const detail = root.error && typeof root.error === 'object' && !Array.isArray(root.error)
    ? root.error as Record<string, unknown>
    : root
  const codes = [root.code, root.type, detail.code, detail.type].filter((value): value is string => typeof value === 'string').map(value => value.toLowerCase())
  if (codes.some(value => ['invalid_token', 'expired_token', 'token_expired', 'invalid_grant'].includes(value))) return false
  if (codes.includes('invalid_api_key')) return true
  if (typeof detail.message !== 'string') return false
  const message = detail.message.trim()
  if (detail.type === 'authentication_error' && /^invalid credential[.!]?$/i.test(message)) return true
  return /^(?:invalid|incorrect|revoked)\s+(?:x-)?api[ _-]?key\b|^(?:(?:the|your)\s+)?(?:x-)?api[ _-]?key\s+(?:(?:you provided|you supplied|provided)\s+)?(?:(?:is|was)\s+)?(?:invalid|incorrect|revoked)\b/i.test(message)
}
