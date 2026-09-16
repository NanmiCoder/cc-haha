import { describe, expect, test } from 'bun:test'
import { NativeCommandError, NATIVE_HELPER_ERROR_MAP, NATIVE_SERVER_ERROR_CODES, toNativeErrorMetadata } from './nativeError.js'

describe('native error metadata boundary', () => {
  test('preserves all 21 official code names and only maps proven native causes', () => {
    expect(Object.keys(NATIVE_SERVER_ERROR_CODES)).toHaveLength(21)
    expect(new Set(Object.values(NATIVE_SERVER_ERROR_CODES)).size).toBe(21)
    for (const [nativeCode, errorName] of Object.entries(NATIVE_HELPER_ERROR_MAP)) {
      expect(toNativeErrorMetadata(new NativeCommandError('Fixture message', nativeCode))).toEqual({
        name: 'SkyComputerUseError', message: 'Fixture message', nativeCode,
        code: NATIVE_SERVER_ERROR_CODES[errorName], errorName, request: null, requestType: 'jsonRPC',
      })
    }
  })

  test('unknown, ambiguous, stale and result-unknown causes never become guessed server errors', () => {
    for (const nativeCode of ['app_denied', 'stale_process', 'stale_snapshot', 'bad_payload', 'user_interference_result_unknown', 'future_error', '__proto__']) {
      expect(toNativeErrorMetadata(new NativeCommandError('Fixture message', nativeCode))).toEqual({
        name: 'Error', message: 'Fixture message', nativeCode,
      })
    }
    expect(toNativeErrorMetadata(new NativeCommandError('message'))).toEqual({ name: 'Error', message: 'message' })
  })

  test('client TypeErrors remain distinct and plain Error properties do not forge a native code', () => {
    expect(toNativeErrorMetadata(new TypeError('pages must be a finite number > 0'))).toEqual({ name: 'TypeError', message: 'pages must be a finite number > 0' })
    const error = Object.assign(new Error('not_trusted'), { code: -10009, nativeCode: 'not_trusted' })
    expect(toNativeErrorMetadata(error)).toEqual({ name: 'Error', message: 'not_trusted' })
  })
})
