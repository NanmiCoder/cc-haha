/**
 * Feishu CardKit API error code parsing and predicates
 *
 * Reference implementation: openclaw-lark/src/card/card-error.ts + src/core/api-error.ts
 *
 * Error objects thrown by the Lark SDK come in several shapes:
 *   - The SDK attaches Feishu's {code, msg} directly to the error object
 *   - Axios style: error.response.data.{code, msg}
 *   - Nested data.code (some wrapper layers)
 *
 * This module normalizes them into a { code, subCode, errMsg } shape
 * so streaming-card-controller can decide whether to skip a frame and retry, or fall back to the Patch path.
 */

// ---------------------------------------------------------------------------
// Error code constants
// ---------------------------------------------------------------------------

/** Card API level error codes. */
export const CARD_ERROR = {
  /** Send rate limit. Skip the current frame; the next flush continues. */
  RATE_LIMITED: 230020,
  /** Card content creation failed (generic code; inspect the sub-error for the actual cause). */
  CARD_CONTENT_FAILED: 230099,
} as const

/**
 * Sub-error codes of 230099, nested in the `ErrCode: xxx` field of msg.
 * 11310 is the generic "element over limit" code; match errMsg to find the actual cause.
 */
export const CARD_CONTENT_SUB_ERROR = {
  /** Card element (table etc.) count over limit */
  ELEMENT_LIMIT: 11310,
} as const

// ---------------------------------------------------------------------------
// Code extraction
// ---------------------------------------------------------------------------

function coerceCode(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/**
 * Extract the Feishu API code from a Lark SDK error object. Supports three shapes:
 *   - `{ code }`                    (attached directly by the SDK)
 *   - `{ data: { code } }`          (nested in the response body)
 *   - `{ response: { data: { code } } }` (Axios style)
 */
export function extractLarkApiCode(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined
  const e = err as {
    code?: unknown
    data?: { code?: unknown }
    response?: { data?: { code?: unknown } }
  }
  return coerceCode(e.code) ?? coerceCode(e.data?.code) ?? coerceCode(e.response?.data?.code)
}

// ---------------------------------------------------------------------------
// Sub-error extraction
// ---------------------------------------------------------------------------

/**
 * Extract the sub-error code (`ErrCode: xxx`) from the msg string.
 *
 * Example input:
 *   "Failed to create card content, ext=ErrCode: 11310; ErrMsg: card table number over limit; ..."
 * Returns: 11310
 */
export function extractSubCode(msg: string): number | null {
  const match = /ErrCode:\s*(\d+)/.exec(msg)
  if (!match) return null
  const code = Number(match[1])
  return Number.isFinite(code) ? code : null
}

// ---------------------------------------------------------------------------
// Structured error parsing
// ---------------------------------------------------------------------------

export type CardApiErrorInfo = {
  code: number
  subCode: number | null
  errMsg: string
}

/**
 * Parse a card API error structure from any thrown object.
 *
 * Returns { code, subCode, errMsg }, or null when no code can be extracted.
 */
export function parseCardApiError(err: unknown): CardApiErrorInfo | null {
  const code = extractLarkApiCode(err)
  if (code === undefined) return null

  // Extract msg text in priority order
  let errMsg = ''
  if (err && typeof err === 'object') {
    const e = err as {
      msg?: unknown
      message?: unknown
      response?: { data?: { msg?: unknown } }
    }
    if (typeof e.msg === 'string') {
      errMsg = e.msg
    } else if (typeof e.response?.data?.msg === 'string') {
      errMsg = e.response.data.msg
    } else if (typeof e.message === 'string') {
      errMsg = e.message
    }
  }

  const subCode = extractSubCode(errMsg)
  return { code, subCode, errMsg }
}

// ---------------------------------------------------------------------------
// Helper predicates
// ---------------------------------------------------------------------------

/** Whether the error is a card send rate limit (230020). */
export function isCardRateLimitError(err: unknown): boolean {
  const parsed = parseCardApiError(err)
  if (!parsed) return false
  return parsed.code === CARD_ERROR.RATE_LIMITED
}

/**
 * Whether the error is a card table count over limit.
 *
 * Match: code 230099 + subCode 11310 + errMsg contains "table number over limit"
 * (11310 is the generic element-over-limit code and is not enough alone; errMsg must also be checked to pin it to the table count).
 *
 * Actual production error format (measured by openclaw-lark 2026-03):
 *   "Failed to create card content, ext=ErrCode: 11310; ErrMsg: card table number over limit; ErrorValue: table; "
 */
export function isCardTableLimitError(err: unknown): boolean {
  const parsed = parseCardApiError(err)
  if (!parsed) return false
  return (
    parsed.code === CARD_ERROR.CARD_CONTENT_FAILED &&
    parsed.subCode === CARD_CONTENT_SUB_ERROR.ELEMENT_LIMIT &&
    /table number over limit/i.test(parsed.errMsg)
  )
}
