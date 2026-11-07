import type { RtcFactory } from './peer'

/**
 * 网页（H5）没有直连：浏览器里的设备凭据是 HttpOnly Cookie，数据通道上的请求
 * 没法带上它，所以 H5 始终走 Cloudflare。原生实现见 rtc.native.ts。
 */
export function nativeRtc(): RtcFactory | undefined {
  return undefined
}
