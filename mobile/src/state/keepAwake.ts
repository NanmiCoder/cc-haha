export const KEEP_AWAKE_TAG = 'cc-haha-keep-awake'

export type KeepAwakeAdapter = {
  activate(tag: string): Promise<void>
  deactivate(tag: string): Promise<void>
}

/**
 * 原生端（Android / iOS）通过 expo-keep-awake 始终可用；网页版只在浏览器提供
 * Screen Wake Lock API 时展示开关。
 */
export function isKeepAwakeAvailable(
  platform: string,
  nav: { wakeLock?: unknown } | undefined = typeof navigator === 'undefined' ? undefined : navigator
): boolean {
  if (platform !== 'web') return true
  return Boolean(nav && 'wakeLock' in nav && nav.wakeLock)
}

/**
 * 按「用户开关 && App 在前台」维持屏幕常亮：
 * - 切到后台时主动释放，回到前台再重新申请（Android Activity 重建、网页 WakeLock
 *   在页面隐藏后被浏览器自动回收都需要重新申请）；
 * - 串行执行申请与释放：申请尚未完成时若被关闭或切后台，完成后立即补释放，不泄漏常亮状态；
 * - 底层调用异常（如旧安装包缺少原生模块、系统拒绝）静默吸收，绝不导致崩溃，并在下次回到前台时重试。
 */
export class KeepAwakeController {
  #enabled = false
  #foreground = false
  #active = false
  #inFlight = false
  #disposed = false

  constructor(
    private adapter: KeepAwakeAdapter,
    private tag = KEEP_AWAKE_TAG
  ) {}

  get active() {
    return this.#active
  }

  setEnabled(enabled: boolean) {
    if (this.#disposed || this.#enabled === enabled) return
    this.#enabled = enabled
    this.#reconcile()
  }

  setForeground(foreground: boolean) {
    if (this.#disposed) return
    if (this.#foreground === foreground) {
      // 上次在前台申请失败（如启动早期 Activity 未就绪）时，再次激活前台可以补试一次。
      if (foreground && this.#enabled && !this.#active) this.#reconcile()
      return
    }
    this.#foreground = foreground
    this.#reconcile()
  }

  dispose() {
    if (this.#disposed) return
    this.#disposed = true
    this.#enabled = false
    this.#foreground = false
    this.#reconcile()
  }

  #want() {
    return !this.#disposed && this.#enabled && this.#foreground
  }

  #reconcile() {
    if (this.#inFlight) return
    const want = this.#want()
    if (want === this.#active) return
    this.#inFlight = true
    if (want) {
      let succeeded = false
      void Promise.resolve()
        .then(() => this.adapter.activate(this.tag))
        .then(() => {
          succeeded = true
          this.#active = true
        })
        .catch(() => {
          this.#active = false
        })
        .finally(() => {
          this.#inFlight = false
          // 申请失败且目标没变时不再原地死循环；等下次切回前台或重新开启再试。
          if (succeeded ? this.#want() !== this.#active : this.#want() !== want) this.#reconcile()
        })
    } else {
      this.#active = false
      void Promise.resolve()
        .then(() => this.adapter.deactivate(this.tag))
        .catch(() => {})
        .finally(() => {
          this.#inFlight = false
          if (this.#want() !== this.#active) this.#reconcile()
        })
    }
  }
}
