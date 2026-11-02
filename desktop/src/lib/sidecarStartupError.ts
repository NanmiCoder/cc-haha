// Shared by the Electron host, which writes these startup timeouts, and the
// startup error page, which reacts to them. On either timeout the host keeps
// the sidecar running instead of killing it, so pressing Retry resumes waiting
// on the same process and its local index rebuild keeps its progress (#1746).
const LISTENING_PHRASE = 'the process is alive and may still be rebuilding its local index'
const NOT_LISTENING_PHRASE = 'the process may still be initializing'

export function formatSidecarStartupTimeout(options: {
  /** Whether a TCP connect to the port succeeded after /health stayed silent. */
  listening: boolean
  host: string
  port: number
  healthUrl: string
  timeoutMs: number
  lastProbeError?: string
}): string {
  const seconds = Math.round(options.timeoutMs / 1000)
  const reason = options.lastProbeError ? ` (last probe: ${options.lastProbeError})` : ''
  if (options.listening) {
    return `desktop server is listening on ${options.host}:${options.port} but did not answer ` +
      `${options.healthUrl} within ${seconds} seconds; ${LISTENING_PHRASE}${reason}`
  }
  return `desktop server never started listening on ${options.host}:${options.port} within ` +
    `${seconds} seconds; ${NOT_LISTENING_PHRASE}${reason}`
}

export function isRetainedSidecarStartupTimeout(message: string): boolean {
  return message.includes(LISTENING_PHRASE) || message.includes(NOT_LISTENING_PHRASE)
}
