/**
 * 节流 + mutex + 冲突重刷的通用 flush 调度器
 *
 * 这是个纯调度原语 —— 不含任何业务逻辑（发送卡片、构造 markdown 等）。
 * 实际 flush 工作由构造函数注入的 doFlush 回调负责。
 *
 * 语义:
 *   - throttledUpdate(throttleMs) 被流式数据触发，按窗口节流
 *   - flush() 被 mutex 保护，相同时刻只有一个在跑
 *   - flush 进行中的新数据标记 needsReflush，API 结束后立即补刷
 *   - 长间隔（> 2000ms）后的第一次 flush 延迟 300ms 批量，避免抖动
 *   - complete() 后拒绝所有新 flush
 *
 * 参考实现: openclaw-lark/src/card/flush-controller.ts
 */

// ---------------------------------------------------------------------------
// Throttle constants
// ---------------------------------------------------------------------------

export const THROTTLE = {
  /** CardKit cardElement.content() 最小间隔 —— 官方为流式设计，可高频 */
  CARDKIT_MS: 100,
  /** im.message.patch 最小间隔 —— 严格速率限制（230020） */
  PATCH_MS: 1500,
  /** 长间隔判定阈值。elapsed > 2000ms 触发批量模式 */
  LONG_GAP_THRESHOLD_MS: 2000,
  /** 长间隔后第一帧的额外延迟，让文本积累更完整 */
  BATCH_AFTER_GAP_MS: 300,
} as const

// ---------------------------------------------------------------------------
// FlushController
// ---------------------------------------------------------------------------

export class FlushController {
  private flushInProgress = false
  private flushResolvers: Array<() => void> = []
  private needsReflush = false
  private pendingFlushTimer: ReturnType<typeof setTimeout> | null = null
  private lastUpdateTime = 0
  private isCompleted = false
  private _cardMessageReady = false

  constructor(private readonly doFlush: () => Promise<void>) {}

  /** 标记完成 —— 当前 flush 跑完后不再接受新的。 */
  complete(): void {
    this.isCompleted = true
  }

  /** 取消任何挂起的延迟 flush 计时器。 */
  cancelPendingFlush(): void {
    if (this.pendingFlushTimer) {
      clearTimeout(this.pendingFlushTimer)
      this.pendingFlushTimer = null
    }
  }

  /** 等待当前正在跑的 flush 结束。没在跑则立即返回。 */
  waitForFlush(): Promise<void> {
    if (!this.flushInProgress) return Promise.resolve()
    return new Promise<void>((resolve) => this.flushResolvers.push(resolve))
  }

  /**
   * 标记卡片消息是否已发送成功，决定 flush 是否被放行。
   *
   * 首次变 true 时同步更新 lastUpdateTime，让第一次 throttledUpdate
   * 看到一个小的 elapsed，匹配 openclaw 的 "card 创建完立即可刷" 行为。
   */
  setCardMessageReady(ready: boolean): void {
    this._cardMessageReady = ready
    if (ready) this.lastUpdateTime = Date.now()
  }

  cardMessageReady(): boolean {
    return this._cardMessageReady
  }

  /**
   * 执行一次 flush（mutex 保护 + 冲突重刷）。
   *
   * 如果已有 flush 在跑，设置 needsReflush，当前 flush 结束后自动补一次。
   */
  async flush(): Promise<void> {
    if (!this.cardMessageReady() || this.flushInProgress || this.isCompleted) {
      if (this.flushInProgress && !this.isCompleted) this.needsReflush = true
      return
    }
    this.flushInProgress = true
    this.needsReflush = false
    // 在 API 调用 **之前** 更新时间戳，防止并发调用者也进入 flush
    this.lastUpdateTime = Date.now()
    try {
      await this.doFlush()
      this.lastUpdateTime = Date.now()
    } finally {
      this.flushInProgress = false
      const resolvers = this.flushResolvers
      this.flushResolvers = []
      for (const resolve of resolvers) resolve()

      // 如果 API 调用期间有新事件进来，立即补一次 flush
      if (this.needsReflush && !this.isCompleted && !this.pendingFlushTimer) {
        this.needsReflush = false
        this.pendingFlushTimer = setTimeout(() => {
          this.pendingFlushTimer = null
          void this.flush()
        }, 0)
      }
    }
  }

  /**
   * 节流更新入口。
   *
   * @param throttleMs - 最小 flush 间隔。CardKit 传 THROTTLE.CARDKIT_MS，
   *   Patch 降级路径传 THROTTLE.PATCH_MS。
   */
  async throttledUpdate(throttleMs: number): Promise<void> {
    if (!this.cardMessageReady()) return

    const now = Date.now()
    const elapsed = now - this.lastUpdateTime

    if (elapsed >= throttleMs) {
      this.cancelPendingFlush()
      if (elapsed > THROTTLE.LONG_GAP_THRESHOLD_MS) {
        // 长间隔批量模式：工具调用 / 推理回来后的第一帧延迟 300ms
        // 让文本积累更完整，避免只显示一两个字
        this.lastUpdateTime = now
        this.pendingFlushTimer = setTimeout(() => {
          this.pendingFlushTimer = null
          void this.flush()
        }, THROTTLE.BATCH_AFTER_GAP_MS)
      } else {
        await this.flush()
      }
    } else if (!this.pendingFlushTimer) {
      // 在节流窗口内 —— 延迟到窗口结束再刷
      const delay = throttleMs - elapsed
      this.pendingFlushTimer = setTimeout(() => {
        this.pendingFlushTimer = null
        void this.flush()
      }, delay)
    }
  }
}
