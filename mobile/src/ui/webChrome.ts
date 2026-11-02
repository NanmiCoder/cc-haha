import { Platform } from 'react-native'
import { isH5 } from '../state/h5'

/**
 * 开发用的网页预览（`bun run web`）在电脑浏览器里画 iPhone：顶部按 54pt 状态栏、
 * 底部按 34pt Home 指示条留白，方便和设计稿对照。H5 跑在真手机的浏览器里，
 * 用浏览器给的真实安全区（index.html 的 viewport-fit=cover），和原生一样处理。
 */
export const simulatedPhoneChrome = Platform.OS === 'web' && !isH5
