/**
 * card-errors unit tests
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
  it('extracts directly from err.code', () => {
    expect(extractLarkApiCode({ code: 230020 })).toBe(230020)
  })

  it('extracts from err.data.code', () => {
    expect(extractLarkApiCode({ data: { code: 230099 } })).toBe(230099)
  })

  it('extracts from err.response.data.code (Axios style)', () => {
    expect(extractLarkApiCode({ response: { data: { code: 99991672 } } })).toBe(99991672)
  })

  it('coerces numeric strings to number', () => {
    expect(extractLarkApiCode({ code: '230020' })).toBe(230020)
  })

  it('three-level priority: err.code > err.data.code > err.response.data.code', () => {
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

  it('ignores non-finite numbers', () => {
    expect(extractLarkApiCode({ code: NaN })).toBeUndefined()
    expect(extractLarkApiCode({ code: 'not-a-number' })).toBeUndefined()
  })
})

describe('extractSubCode', () => {
  it('recognizes the standard ErrCode: 11310', () => {
    const msg = 'Failed to create card content, ext=ErrCode: 11310; ErrMsg: card table number over limit'
    expect(extractSubCode(msg)).toBe(11310)
  })

  it('returns null without ErrCode', () => {
    expect(extractSubCode('random error message')).toBeNull()
    expect(extractSubCode('')).toBeNull()
  })

  it('tolerates ErrCode casing (extra spaces after the colon)', () => {
    expect(extractSubCode('ErrCode:  42')).toBe(42)
  })
})

describe('parseCardApiError', () => {
  it('extracts the full structure from an SDK-style error', () => {
    const err = { code: 230099, msg: 'ErrCode: 11310; ErrMsg: card table number over limit' }
    const parsed = parseCardApiError(err)
    expect(parsed).toEqual({
      code: 230099,
      subCode: 11310,
      errMsg: 'ErrCode: 11310; ErrMsg: card table number over limit',
    })
  })

  it('extracts from an Axios-style error (response.data.msg)', () => {
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

  it('returns null without code', () => {
    expect(parseCardApiError({})).toBeNull()
    expect(parseCardApiError(null)).toBeNull()
    expect(parseCardApiError('string')).toBeNull()
  })

  it('errMsg is an empty string when there is a code but no msg', () => {
    const parsed = parseCardApiError({ code: 230020 })
    expect(parsed).toEqual({ code: 230020, subCode: null, errMsg: '' })
  })

  it('falls back to err.message', () => {
    const err = Object.assign(new Error('fallback text'), { code: 230099 })
    const parsed = parseCardApiError(err)
    expect(parsed?.errMsg).toBe('fallback text')
  })
})

describe('isCardRateLimitError', () => {
  it('recognizes 230020', () => {
    expect(isCardRateLimitError({ code: 230020 })).toBe(true)
  })

  it('recognizes Axios-style 230020', () => {
    expect(isCardRateLimitError({ response: { data: { code: 230020 } } })).toBe(true)
  })

  it('does not match other codes', () => {
    expect(isCardRateLimitError({ code: 230099 })).toBe(false)
    expect(isCardRateLimitError({ code: 99991672 })).toBe(false)
  })

  it('returns false for non-error objects', () => {
    expect(isCardRateLimitError(null)).toBe(false)
    expect(isCardRateLimitError({})).toBe(false)
    expect(isCardRateLimitError(new Error('random'))).toBe(false)
  })
})

describe('isCardTableLimitError', () => {
  const validMsg = 'Failed to create card content, ext=ErrCode: 11310; ErrMsg: card table number over limit; ErrorValue: table; '

  it('strict three-condition match: code=230099 + subCode=11310 + msg contains table number over limit', () => {
    const err = { code: CARD_ERROR.CARD_CONTENT_FAILED, msg: validMsg }
    expect(isCardTableLimitError(err)).toBe(true)
  })

  it('matches from Axios-style response.data', () => {
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

  it('230099 + 11310 without "table number over limit" → false (other element over limit)', () => {
    const err = {
      code: CARD_ERROR.CARD_CONTENT_FAILED,
      msg: 'ErrCode: 11310; ErrMsg: some other element limit; ',
    }
    expect(isCardTableLimitError(err)).toBe(false)
  })

  it('code is not 230099 → false', () => {
    const err = { code: 230020, msg: validMsg }
    expect(isCardTableLimitError(err)).toBe(false)
  })

  it('no subCode → false', () => {
    const err = { code: 230099, msg: 'card table number over limit (no ErrCode)' }
    expect(isCardTableLimitError(err)).toBe(false)
  })

  it('"table number" is case-insensitive', () => {
    const err = {
      code: 230099,
      msg: 'ErrCode: 11310; ErrMsg: CARD TABLE NUMBER OVER LIMIT; ',
    }
    expect(isCardTableLimitError(err)).toBe(true)
  })
})

describe('constant values', () => {
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
