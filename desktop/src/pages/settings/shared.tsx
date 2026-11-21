
/**
 * The few things more than one Settings panel needs.
 *
 * Extracted while splitting `Settings.tsx` into one module per panel, so a
 * panel never imports from the file that imports it. The hand-rolled checkbox
 * mark that used to live here is gone: settings toggles are `Switch` rows of
 * the shared skeleton (`components/settings/SettingsSection`), and dialog
 * checkboxes use `ui/Checkbox`.
 */

export function isValidHttpProxyUrl(value: string) {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * RFC 9110 field-name token, matching the validation the server applies to a
 * saved provider's upstream headers before it stores them.
 */
const UPSTREAM_HEADER_NAME_PATTERN = /^[!#$%&'*+-.^_`|~0-9A-Za-z]+$/

/**
 * Serialize a saved provider's upstream headers to one "Name: value" line each,
 * so the edit form can show them as editable text.
 */
export function formatUpstreamHeaders(headers: Record<string, string>): string {
  return Object.entries(headers).map(([name, value]) => `${name}: ${value}`).join('\n')
}

/**
 * Parse the form's "Name: value" lines into a header map. Returns an error
 * naming the first malformed line instead of saving something the proxy would
 * silently drop.
 */
export function parseUpstreamHeadersInput(text: string): { headers?: Record<string, string>; error?: string } {
  const trimmed = text.trim()
  if (!trimmed) return {}
  const headers: Record<string, string> = {}
  for (const line of trimmed.split(/\r?\n/)) {
    const sep = line.indexOf(':')
    const name = sep === -1 ? line.trim() : line.slice(0, sep).trim()
    const value = sep === -1 ? '' : line.slice(sep + 1).trim()
    if (!name || !UPSTREAM_HEADER_NAME_PATTERN.test(name)) return { error: name || line.trim() }
    if (!value) return { error: name }
    headers[name] = value
  }
  return { headers }
}

/**
 * Headers the proxy never sends upstream: they describe the proxy↔upstream
 * hop's framing or credential (see src/server/proxy/upstreamHeaders.ts). The
 * form accepts them but flags them, since the resolver drops them silently.
 */
const BLOCKED_UPSTREAM_HEADERS = new Set(['authorization', 'x-api-key', 'host', 'content-type', 'content-length', 'connection'])

/**
 * Returns the first declared header name the proxy would silently drop, so
 * the form can warn instead of letting the setting appear to work.
 */
export function findBlockedUpstreamHeader(headers: Record<string, string>): string | undefined {
  return Object.keys(headers).find((name) => BLOCKED_UPSTREAM_HEADERS.has(name.toLowerCase()))
}
