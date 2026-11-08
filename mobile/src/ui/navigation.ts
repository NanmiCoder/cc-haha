import { router } from 'expo-router'

/**
 * 换电脑、加电脑、移除电脑之后回首页：退回栈里已有的首页（没有才替换成首页）。
 * 用 replace 会在栈上再压一个首页，每多一个都要跟着刷新列表重新渲染全部会话。
 */
export function goHome() {
  router.dismissTo('/')
}
