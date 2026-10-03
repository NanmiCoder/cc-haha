/**
 * Shared rules for a teammate turn that ended on an error. Both team runtimes
 * use them: the desktop's process members (classified from the CLI `result`
 * text) and in-process teammates (classified from the turn's API-error message).
 *
 * A transient failure is a provider or transport hiccup — a truncated or
 * stalled stream, 5xx/529/429, a timeout or a dropped connection. Third-party
 * gateways produce these far more often than the first-party API, and an
 * unattended team has nobody watching for a member that silently stopped, so
 * the runtime continues the member with backoff instead of parking it.
 * Everything else (auth, billing, context overflow, invalid requests) reaches
 * the lead immediately, because retrying cannot fix it.
 */

const NON_TRANSIENT_FAILURE = /prompt is too long|context (length|window)|maximum context|credit balance|not logged in|invalid api key|invalid x-api-key|authentication|unauthori[sz]ed|forbidden|\b40[13]\b|billing|payment required|\b402\b|extra usage is required|invalid_request_error|model[_ ]not[_ ]found|no such model|unsupported model|max(imum)? turns|request was aborted|interrupted by user/i
const TRANSIENT_FAILURE = /stream_truncated|stream_error|ended without (a )?(finish_reason|message_stop)|provider stream ended|stream ended without|without receiving any events|overloaded|repeated 529|\b5\d\d\b|server_error|api_error|internal server error|bad gateway|service unavailable|gateway time-?out|timed? ?out|timeout|stream idle|stalled|econnreset|econnrefused|etimedout|epipe|socket hang up|fetch failed|connection (error|reset|closed)|network|terminated|rate.?limit|\b429\b|too many requests/i

export function isTransientTurnFailure(text: string): boolean {
  if (!text.trim()) return false
  if (NON_TRANSIENT_FAILURE.test(text)) return false
  return TRANSIENT_FAILURE.test(text)
}

/** Backoff between automatic continuations of a member after transient failures. */
export const TEAMMATE_AUTO_CONTINUE_DELAYS_MS = [15_000, 45_000, 120_000, 300_000, 600_000]

export function formatTeammateAutoContinuePrompt(reason: string, attempt: number, max: number): string {
  return [
    `[Team runtime notice] Your previous turn stopped early because of a transient model/API error (${reason || 'unknown error'}; automatic retry ${attempt} of ${max}).`,
    'Continue your assigned work from where you left off. Do not redo steps that already finished. If your work is already complete, report the result to the team lead with SendMessage and mark your task completed.',
  ].join('\n')
}

export type MemberAutoRetry = { attempt: number; max: number; nextAt: number }

/**
 * The failure state the desktop team runtime records on a team-file member.
 * Reads defensively: the team file is shared, persisted JSON.
 */
export function readMemberFailure(entry: Record<string, unknown>): { lastError?: string; autoRetry?: MemberAutoRetry } {
  const lastError = typeof entry.lastError === 'string' && entry.lastError.trim() ? entry.lastError : undefined
  const raw = entry.autoRetry as Partial<MemberAutoRetry> | undefined
  const autoRetry = raw && typeof raw === 'object' &&
    Number.isFinite(raw.attempt) && Number.isFinite(raw.max) && Number.isFinite(raw.nextAt)
    ? { attempt: raw.attempt!, max: raw.max!, nextAt: raw.nextAt! }
    : undefined
  return { ...(lastError ? { lastError } : {}), ...(autoRetry ? { autoRetry } : {}) }
}

/** First non-empty line, control characters removed, capped for a notification. */
export function summarizeTurnFailure(text: string, limit = 200): string {
  const line = text.split('\n').find(candidate => candidate.trim())?.trim() ?? ''
  const clean = line.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean
}
