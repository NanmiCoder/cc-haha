/**
 * User-Agent string helpers.
 *
 * Kept dependency-free so SDK-bundled code (bridge, cli/transports) can
 * import without pulling in auth.ts and its transitive dependency tree.
 */

export function getClaudeCodeUserAgent(): string {
  return `claude-code/${MACRO.VERSION}`
}

/**
 * Version of this application, for upstreams that expect a client to identify
 * itself. `APP_VERSION` is what the desktop and server entry points set at
 * runtime (see api/status.ts, diagnosticsService); `MACRO` is the local-build
 * fallback that preload.ts installs from `CLAUDE_CODE_LOCAL_VERSION`. Neither is
 * guaranteed to exist when this module is evaluated outside those entry points
 * (tests, plain ts runners), so both are guarded rather than assumed.
 */
export function getCcHahaVersion(): string {
  const fromEnv = process.env.APP_VERSION?.trim()
  if (fromEnv) return fromEnv
  return typeof MACRO !== 'undefined' && MACRO.VERSION ? MACRO.VERSION : 'dev'
}
