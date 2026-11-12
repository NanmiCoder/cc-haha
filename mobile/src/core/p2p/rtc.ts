import type { RtcFactory } from './peer'

/**
 * Web (H5) has no direct: the device credential in the browser is an HttpOnly cookie, and requests on the data channel
 * cannot carry it, so H5 always uses Cloudflare. Native implementation in rtc.native.ts.
 */
export function nativeRtc(): RtcFactory | undefined {
  return undefined
}
