import { Platform } from 'react-native'
import { h5EntryUrl, type H5Location } from '../core/h5Session'

/**
 * 桌面服务端托管给手机浏览器的这份网页版（H5 构建，见 app.config.ts 的 withH5Build）。
 * 导出时 Expo 把这个公开变量内联进包里；开发用的 `bun run web` 预览和原生 App 都不是 H5。
 */
export const isH5 = Platform.OS === 'web' && process.env.EXPO_PUBLIC_CC_HAHA_H5 === '1'

export function h5Location(): H5Location {
  return { origin: window.location.origin, hostname: window.location.hostname }
}

/** 回到桌面 H5 入口重新连接（令牌页或远程配对页），完成后入口会再送回这里。 */
export function reconnectH5(remote: boolean) {
  window.location.assign(h5EntryUrl(h5Location(), remote))
}
