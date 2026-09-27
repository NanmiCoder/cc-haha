/**
 * Resolves the upstream request headers a preset declares for a gateway.
 *
 * Some gateways require the client to identify itself. OpenCode Go, for example,
 * refuses every request with `400 MissingSessionID` unless a stable per-
 * conversation id is sent in `x-opencode-session`, and asks clients to send their
 * own User-Agent rather than a generic HTTP-library name. Both are static except
 * for the per-conversation id, which the proxy already receives from the CLI as
 * `x-claude-code-session-id`.
 *
 * The template lives on the preset (data), never on the saved provider, so it
 * ships with the app version and needs no migration or edit-form control.
 */

import { getCcHahaVersion } from '../../utils/userAgent.js'

export const UPSTREAM_SESSION_ID_PLACEHOLDER = '$SESSION_ID'
export const UPSTREAM_VERSION_PLACEHOLDER = '$VERSION'

/**
 * Headers a preset must never set: they describe the proxy↔upstream hop's
 * framing or credential, and letting a preset override them would either break
 * the request or silently redirect the credential.
 */
const BLOCKED_UPSTREAM_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'host',
  'content-type',
  'content-length',
  'connection',
])

export type UpstreamHeaderContext = {
  /** Per-conversation id from the inbound request; absent outside a conversation. */
  sessionId?: string | null
}

/**
 * Overlays preset headers onto an outgoing header map, replacing rather than
 * adding.
 *
 * The replacement is case-insensitive on purpose: `Headers` treats `user-agent`
 * and `User-Agent` as one field, so leaving both keys in the map makes fetch send
 * them combined — `"caller, preset"` — which is neither value and silently
 * defeats the point of declaring the header.
 */
export function applyUpstreamHeaders<T extends Record<string, string>>(
  headers: T,
  upstreamHeaders: Record<string, string>,
): T {
  for (const [name, value] of Object.entries(upstreamHeaders)) {
    const lower = name.toLowerCase()
    for (const existing of Object.keys(headers)) {
      if (existing.toLowerCase() === lower) delete headers[existing]
    }
    headers[name] = value
  }
  return headers
}

export function resolveUpstreamHeaders(
  template: Record<string, string> | undefined,
  context: UpstreamHeaderContext = {},
): Record<string, string> {
  if (!template) return {}

  const sessionId = context.sessionId?.trim()
  const resolved: Record<string, string> = {}

  for (const [rawName, rawValue] of Object.entries(template)) {
    const name = rawName.trim()
    if (!name || BLOCKED_UPSTREAM_HEADERS.has(name.toLowerCase())) continue

    // A template that asks for the session id has nothing to send outside a
    // conversation. Omitting the header keeps the upstream's own error visible
    // instead of inventing an identity or sending an empty value.
    if (rawValue.includes(UPSTREAM_SESSION_ID_PLACEHOLDER) && !sessionId) continue

    const value = rawValue
      .split(UPSTREAM_SESSION_ID_PLACEHOLDER).join(sessionId ?? '')
      .split(UPSTREAM_VERSION_PLACEHOLDER).join(getCcHahaVersion())
      .trim()
    if (!value || /[\r\n]/.test(value)) continue

    resolved[name] = value
  }

  return resolved
}
