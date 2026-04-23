/**
 * Feishu CardKit API 错误码解析与谓词
 *
 * 参考实现: openclaw-lark/src/card/card-error.ts + src/core/api-error.ts
 *
 * Lark SDK 抛出的错误对象结构有多种：
 *   - SDK 把 Feishu 的 {code, msg} 直接挂在 error 对象上
 *   - Axios 风格: error.response.data.{code, msg}
 *   - data.code 嵌套（某些包装层）
 *
 * 此模块把这些统一成 { code, subCode, errMsg } 结构，
 * 供 streaming-card-controller 判断是否跳帧重试、或降级到 Patch 路径。
 */

// ---------------------------------------------------------------------------
// Error code constants
// ---------------------------------------------------------------------------

/** 卡片 API 级别错误码。 */
export const CARD_ERROR = {
  /** 发送频率限制。需跳过当前帧，下次 flush 继续。 */
  RATE_LIMITED: 230020,
  /** 卡片内容创建失败（通用码，需看子错误确认具体原因）。 */
  CARD_CONTENT_FAILED: 230099,
} as const

/**
 * 230099 的子错误码，嵌套在 msg 的 `ErrCode: xxx` 字段中。
 * 11310 是通用的"元素超限"码，需配合 errMsg 匹配具体原因。
 */
export const CARD_CONTENT_SUB_ERROR = {
  /** 卡片元素（表格等）数量超限 */
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
 * 从 Lark SDK 抛错对象中提取飞书 API code。支持三种结构：
 *   - `{ code }`                    (SDK 直接挂载)
 *   - `{ data: { code } }`          (响应体嵌套)
 *   - `{ response: { data: { code } } }` (Axios 风格)
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
 * 从 msg 字符串里提取子错误码（`ErrCode: xxx`）。
 *
 * 示例输入:
 *   "Failed to create card content, ext=ErrCode: 11310; ErrMsg: card table number over limit; ..."
 * 返回: 11310
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
 * 从任意抛错对象中解析卡片 API 错误结构。
 *
 * 返回 { code, subCode, errMsg }。无法提取 code 时返回 null。
 */
export function parseCardApiError(err: unknown): CardApiErrorInfo | null {
  const code = extractLarkApiCode(err)
  if (code === undefined) return null

  // 按优先级提取 msg 文本
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

/** 判断错误是否为卡片发送频率限制（230020）。 */
export function isCardRateLimitError(err: unknown): boolean {
  const parsed = parseCardApiError(err)
  if (!parsed) return false
  return parsed.code === CARD_ERROR.RATE_LIMITED
}

/**
 * 判断错误是否为卡片表格数超限。
 *
 * 匹配条件: code 230099 + subCode 11310 + errMsg 含 "table number over limit"
 * （11310 是通用元素超限码，光靠它不够；必须同时检查 errMsg 锁定是表格数量问题）。
 *
 * 实际生产错误格式（openclaw-lark 2026-03 实测）:
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
