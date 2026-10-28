/** 通知引导页的触发判定与「继续」流程。保持纯函数、不依赖原生模块，方便单测。 */

export type NotifyPermission = 'undetermined' | 'granted' | 'denied' | 'unknown'

export type NotifyGateInput = {
  platform: string
  /** AppContext 已读完本机保存的电脑列表。 */
  appReady: boolean
  hostCount: number
  preferencesReady: boolean
  preferencesError: boolean
  /** preferences.notifyPrompted：引导页已经出现过（或系统早已问过）。 */
  prompted: boolean
  /** 系统通知权限；还没读到时为 unknown。 */
  permission: NotifyPermission
  /** 当前在首页（刚连上电脑回到首页，或冷启动落在首页）。 */
  onHome: boolean
}

export type NotifyGateDecision = 'show' | 'markPrompted' | 'none'

/**
 * 把 expo-notifications 的权限结果归成三态。注意安卓：没问过时它报 `denied`，
 * 只是 `canAskAgain` 仍为 true；只有「没授权且不能再问」才是用户真的拒绝了。
 * iOS 没问过是 `undetermined`，拒绝后 `canAskAgain` 为 false，同样适用。
 */
export function classifyPermission(result: {
  granted: boolean
  status: string
  canAskAgain?: boolean
}): Exclude<NotifyPermission, 'unknown'> {
  if (result.granted) return 'granted'
  if (result.status === 'undetermined') return 'undetermined'
  return result.canAskAgain === false ? 'denied' : 'undetermined'
}

/**
 * 只在「系统还没问过」且用户停在首页时弹引导页（每次运行只推一次由调用方保证）；
 * 系统已经有答案（允许或拒绝）就静默记下，以后永远不再弹。
 */
export function decideNotifyPrompt(input: NotifyGateInput): NotifyGateDecision {
  if (input.platform === 'web') return 'none'
  if (!input.appReady || input.hostCount === 0) return 'none'
  if (!input.preferencesReady || input.preferencesError) return 'none'
  if (input.prompted) return 'none'
  if (input.permission === 'unknown') return 'none'
  if (input.permission !== 'undetermined') return 'markPrompted'
  if (!input.onHome) return 'none'
  return 'show'
}

/**
 * 点「继续」：先确保 Android 渠道存在，再弹系统授权，最后无论允许、拒绝还是出错
 * 都记为已引导并离开——拒绝不能挡住用户使用 App。
 */
export async function continueNotifyPrompt(deps: {
  ensureChannel(): Promise<void>
  request(): Promise<unknown>
  markPrompted(): Promise<void>
  /** 系统授权流程结束后通知推送登记重新检查权限。 */
  decided?(): void
}) {
  try {
    await deps.ensureChannel()
  } catch {
    // 渠道失败时仍照常请求，Android 12 及以下没有运行时授权框。
  }
  try {
    await deps.request()
  } catch {
    // 请求失败等同于没有授权，设置页里还能再开。
  }
  try {
    await deps.markPrompted()
  } catch {
    // 偏好写入失败只会让下次启动再引导一次，不拦住用户。
  }
  deps.decided?.()
}

type Listener = () => void
const listeners = new Set<Listener>()

/** 推送登记订阅「权限已有答案」，不必等下一次回到前台才补登记。 */
export function subscribePermissionDecided(listener: Listener) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function emitPermissionDecided() {
  for (const listener of [...listeners]) listener()
}
