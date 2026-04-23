/**
 * card-errors 单元测试
 */

import { describe, it, expect } from 'bun:test'
import {
  CARD_ERROR,
  CARD_CONTENT_SUB_ERROR,
  extractLarkApiCode,
  extractSubCode,
  parseCardApiError,
  isCardRateLimitError,
  isCardTableLimitError,
} from '../card-errors.js'

describe('extractLarkApiCode', () => {
  it('从 err.code 直接提取', () => {
    expect(extractLarkApiCode({ code: 230020 })).toBe(230020)
  })

  it('从 err.data.code 提取', () => {
    expect(extractLarkApiCode({ data: { code: 230099 } })).toBe(230099)
  })

  it('从 err.response.data.code 提取（Axios 风格）', () => {
    expect(extractLarkApiCode({ response: { data: { code: 99991672 } } })).toBe(99991672)
  })

  it('数字字符串被强制转成 number', () => {
    expect(extractLarkApiCode({ code: '230020' })).toBe(230020)
  })

  it('三层结构优先级: err.code > err.data.code > err.response.data.code', () => {
    const err = {
      code: 1,
      data: { code: 2 },
      response: { data: { code: 3 } },
    }
    expect(extractLarkApiCode(err)).toBe(1)
  })

  it('none → undefined', () => {
    expect(extractLarkApiCode({})).toBeUndefined()
    expect(extractLarkApiCode(null)).toBeUndefined()
    expect(extractLarkApiCode(undefined)).toBeUndefined()
    expect(extractLarkApiCode('just a string')).toBeUndefined()
    expect(extractLarkApiCode(new Error('plain'))).toBeUndefined()
  })

  it('非有限数字被忽略', () => {
    expect(extractLarkApiCode({ code: NaN })).toBeUndefined()
    expect(extractLarkApiCode({ code: 'not-a-number' })).toBeUndefined()
  })
})

describe('extractSubCode', () => {
  it('识别标准的 ErrCode: 11310', () => {
    const msg = 'Failed to create card content, ext=ErrCode: 11310; ErrMsg: card table number over limit'
    expect(extractSubCode(msg)).toBe(11310)
  })

  it('无 ErrCode 时返回 null', () => {
    expect(extractSubCode('random error message')).toBeNull()
    expect(extractSubCode('')).toBeNull()
  })

  it('ErrCode 大小写容错（冒号后多空格）', () => {
    expect(extractSubCode('ErrCode:  42')).toBe(42)
  })
})

describe('parseCardApiError', () => {
  it('从 SDK 风格错误提取完整结构', () => {
    const err = { code: 230099, msg: 'ErrCode: 11310; ErrMsg: card table number over limit' }
    const parsed = parseCardApiError(err)
    expect(parsed).toEqual({
      code: 230099,
      subCode: 11310,
      errMsg: 'ErrCode: 11310; ErrMsg: card table number over limit',
    })
  })

  it('从 Axios 风格错误（response.data.msg）提取', () => {
    const err = {
      response: {
        data: {
          code: 230020,
          msg: 'rate limited',
        },
      },
    }
    const parsed = parseCardApiError(err)
    expect(parsed?.code).toBe(230020)
    expect(parsed?.errMsg).toBe('rate limited')
    expect(parsed?.subCode).toBeNull()
  })

  it('无 code 时返回 null', () => {
    expect(parseCardApiError({})).toBeNull()
    expect(parseCardApiError(null)).toBeNull()
    expect(parseCardApiError('string')).toBeNull()
  })

  it('有 code 无 msg 时 errMsg 为空字符串', () => {
    const parsed = parseCardApiError({ code: 230020 })
    expect(parsed).toEqual({ code: 230020, subCode: null, errMsg: '' })
  })

  it('fallback 到 err.message', () => {
    const err = Object.assign(new Error('fallback text'), { code: 230099 })
    const parsed = parseCardApiError(err)
    expect(parsed?.errMsg).toBe('fallback text')
  })
})

describe('isCardRateLimitError', () => {
  it('识别 230020', () => {
    expect(isCardRateLimitError({ code: 230020 })).toBe(true)
  })

  it('识别 Axios 风格 230020', () => {
    expect(isCardRateLimitError({ response: { data: { code: 230020 } } })).toBe(true)
  })

  it('不匹配其他 code', () => {
    expect(isCardRateLimitError({ code: 230099 })).toBe(false)
    expect(isCardRateLimitError({ code: 99991672 })).toBe(false)
  })

  it('非错误对象返回 false', () => {
    expect(isCardRateLimitError(null)).toBe(false)
    expect(isCardRateLimitError({})).toBe(false)
    expect(isCardRateLimitError(new Error('random'))).toBe(false)
  })
})

describe('isCardTableLimitError', () => {
  const validMsg = 'Failed to create card content, ext=ErrCode: 11310; ErrMsg: card table number over limit; ErrorValue: table; '

  it('严格三条件匹配: code=230099 + subCode=11310 + msg 含 table number over limit', () => {
    const err = { code: CARD_ERROR.CARD_CONTENT_FAILED, msg: validMsg }
    expect(isCardTableLimitError(err)).toBe(true)
  })

  it('从 Axios 风格的 response.data 匹配', () => {
    const err = {
      response: {
        data: {
          code: 230099,
          msg: validMsg,
        },
      },
    }
    expect(isCardTableLimitError(err)).toBe(true)
  })

  it('230099 + 11310 但没有 "table number over limit" 字样 → false（其它元素超限）', () => {
    const err = {
      code: CARD_ERROR.CARD_CONTENT_FAILED,
      msg: 'ErrCode: 11310; ErrMsg: some other element limit; ',
    }
    expect(isCardTableLimitError(err)).toBe(false)
  })

  it('code 不是 230099 → false', () => {
    const err = { code: 230020, msg: validMsg }
    expect(isCardTableLimitError(err)).toBe(false)
  })

  it('没有 subCode → false', () => {
    const err = { code: 230099, msg: 'card table number over limit (no ErrCode)' }
    expect(isCardTableLimitError(err)).toBe(false)
  })

  it('不区分 "table number" 的大小写', () => {
    const err = {
      code: 230099,
      msg: 'ErrCode: 11310; ErrMsg: CARD TABLE NUMBER OVER LIMIT; ',
    }
    expect(isCardTableLimitError(err)).toBe(true)
  })
})

describe('常量值', () => {
  it('CARD_ERROR.RATE_LIMITED === 230020', () => {
    expect(CARD_ERROR.RATE_LIMITED).toBe(230020)
  })
  it('CARD_ERROR.CARD_CONTENT_FAILED === 230099', () => {
    expect(CARD_ERROR.CARD_CONTENT_FAILED).toBe(230099)
  })
  it('CARD_CONTENT_SUB_ERROR.ELEMENT_LIMIT === 11310', () => {
    expect(CARD_CONTENT_SUB_ERROR.ELEMENT_LIMIT).toBe(11310)
  })
})
