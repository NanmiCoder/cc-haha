/**
 * 单个 chat 的流式卡片生命周期状态机
 *
 * 负责把 LLM 的流式文本增量渲染成一张随着内容生长的飞书 CardKit 卡片。
 * 封装了：
 * - CardKit API 的 5 步调用（create → send → stream × N → settings → update）
 * - 节流 + 并发保护（FlushController）
 * - Markdown 预处理（optimizeMarkdownForFeishu + sanitizeTextForCard）
 * - 错误降级：CardKit 挂了自动切到 im.message.patch + Schema 2.0 卡
 * - 速率限制：230020 跳帧，下次重试；230099 表格超限禁用 CardKit 流式
 *
 * 每个 chatId 一个实例，由 index.ts 的 handleServerMessage 协调 lifecycle。
 */

import type * as Lark from '@larksuiteoapi/node-sdk'
import { FlushController, THROTTLE } from './flush-controller.js'
import {
  createCardEntity,
  sendCardAsMessage,
  streamCardContent,
  setCardStreamingMode,
  updateCardKitCard,
  STREAMING_ELEMENT_ID,
} from './cardkit.js'
import { isCardRateLimitError, isCardTableLimitError } from './card-errors.js'
import { optimizeMarkdownForFeishu, sanitizeTextForCard } from './markdown-style.js'

// ---------------------------------------------------------------------------
// Card JSON builders
// ---------------------------------------------------------------------------

/** 初始流式卡片：Schema 2.0 + streaming_mode + element_id。
 *
 *  只包含一个 markdown 元素 `streaming_content`，初始内容为 loading 提示。
 *  由 renderedText() 统一控制显示状态（思考中 / reasoning / 正文），
 *  避免静态 loading 元素和 streaming 内容同时显示造成"两个思考中"。
 *
 *  finalize 时整卡 update 替换为纯答复正文。 */
export function buildInitialStreamingCard(): Record<string, unknown> {
  return {
    schema: '2.0',
    config: {
      streaming_mode: true,
      update_multi: true,
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: '☁️ *正在思考中...*',
          text_align: 'left',
          element_id: STREAMING_ELEMENT_ID,
        },
      ],
    },
  }
}

/** 已渲染完成的卡片：Schema 2.0，无 streaming_mode，单 markdown 元素。
 *
 *  代码块的 "10 行代码 >" 手机端 bug 是通过 `optimizeMarkdownForFeishu` 把
 *  fenced code 降级成纯文字来规避的，不依赖多元素结构。这里就是最朴素的
 *  一张纯 markdown 卡片。 */
export function buildRenderedCard(renderedMarkdown: string): Record<string, unknown> {
  return {
    schema: '2.0',
    config: {
      update_multi: true,
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: renderedMarkdown || ' ',
          text_align: 'left',
        },
      ],
    },
  }
}

/** 错误卡片：红色 header + 错误文本。用于 abort() 兜底。 */
export function buildErrorCard(message: string): Record<string, unknown> {
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      title: { tag: 'plain_text', content: '❌ 出错了' },
      template: 'red',
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: message || '未知错误',
        },
      ],
    },
  }
}

/** 从末尾截取最多 maxLen 个字符；超过时前缀 "..." 保留最新 maxLen-3 个字。
 *
 *  思考内容往往是"先分析 → 得出结论"的线性过程，截取末尾比截取开头更有用 —— 用户
 *  最关心的是"模型现在在想什么"，不是"五千个 token 前在想什么"。 */
function truncateReasoningPreview(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  return '...' + text.slice(text.length - maxLen + 3)
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

export type StreamingCardPhase =
  | 'idle' // constructor 后、ensureCreated 之前
  | 'creating' // ensureCreated 进行中
  | 'streaming' // 初始卡已发出，接受 appendText
  | 'finalizing' // finalize 进行中
  | 'completed' // finalize 完成
  | 'aborted' // abort 已调用

export type StreamingCardDeps = {
  larkClient: Lark.Client
  chatId: string
  replyToMessageId?: string
}

/** One entry in the tool-use trace displayed above the answer text. */
type ToolStep = {
  /** Prefer toolUseId for dedup; fall back to a synthetic id when missing. */
  id: string
  name: string
  status: 'running' | 'done'
}

/** 最多保留的 reasoning 预览字符数，超过则取末尾 + 省略号前缀。 */
const REASONING_PREVIEW_CHARS = 600

/** 连续 streamCardContent 失败多少次后才放弃 CardKit 流式。
 *  设成 3 而不是 1，是为了避免单次抖动（网络、临时校验失败等）把整张卡片
 *  冻结到 finalize —— 用户看到的就是 "long wait → 一次性 dump"。 */
const STREAM_FAIL_DISABLE_THRESHOLD = 3

export class StreamingCard {
  // ---- lifecycle state ----
  private phase: StreamingCardPhase = 'idle'

  // ---- CardKit state ----
  /** CardKit card_id。null = CardKit 创建失败，已退到 patch fallback 模式。 */
  private cardId: string | null = null
  /** IM message_id。始终应该有值（否则连 patch 也做不了）。 */
  private messageId: string | null = null
  /** CardKit cardElement.content() 单调递增序列号。 */
  private sequence = 0
  /** CardKit 流式还在工作。230099 或连续 N 次未知错误之后置为 false，
   *  中间帧将跳过，最终 finalize 仍会尝试 settings+update（cardId 仍然有效）。 */
  private cardKitStreamActive = false
  /** 连续 streamCardContent 未知错误计数。一次成功就清零。 */
  private consecutiveStreamFailures = 0

  // ---- text state ----
  private accumulatedText = ''
  private lastFlushedText = ''
  /** 累积 thinking_delta，渲染为卡片顶部的推理预览 blockquote。 */
  private accumulatedReasoningText = ''
  /** 工具调用轨迹：按 startTool 调用顺序排列，completeTool 改其 status。 */
  private toolSteps: ToolStep[] = []

  // ---- flush ----
  private flushController: FlushController

  constructor(private readonly deps: StreamingCardDeps) {
    this.flushController = new FlushController(() => this.performFlush())
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  /**
   * 首次创建卡片（CardKit 主路径；失败则降级到直发 Schema 2.0 卡 + patch）。
   * 幂等：已创建/正在创建时直接返回。
   */
  async ensureCreated(): Promise<void> {
    if (this.phase !== 'idle') return
    this.phase = 'creating'

    try {
      // CardKit 主路径
      const cardId = await createCardEntity(
        this.deps.larkClient,
        buildInitialStreamingCard(),
      )
      const messageId = await sendCardAsMessage(
        this.deps.larkClient,
        this.deps.chatId,
        cardId,
        this.deps.replyToMessageId,
      )
      this.cardId = cardId
      this.messageId = messageId
      this.cardKitStreamActive = true
      this.sequence = 1
      this.phase = 'streaming'
      this.flushController.setCardMessageReady(true)
    } catch (cardKitErr) {
      // CardKit 不可用（权限、网络、API 兼容性等）→ 降级到直发卡片 + patch
      console.warn(
        '[Feishu StreamingCard] CardKit create/send failed, falling back to im.message.patch:',
        cardKitErr instanceof Error ? cardKitErr.message : cardKitErr,
      )
      try {
        const fallbackResp = await this.deps.larkClient.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: this.deps.chatId,
            msg_type: 'interactive',
            content: JSON.stringify(buildRenderedCard(' ')),
          },
        })
        const mid = fallbackResp.data?.message_id
        if (!mid) {
          throw new Error('fallback im.message.create returned no message_id')
        }
        this.cardId = null
        this.messageId = mid
        this.cardKitStreamActive = false
        this.phase = 'streaming'
        this.flushController.setCardMessageReady(true)
      } catch (fallbackErr) {
        // 兜底都失败了 —— 无法显示任何东西
        console.error(
          '[Feishu StreamingCard] Fallback card creation also failed:',
          fallbackErr instanceof Error ? fallbackErr.message : fallbackErr,
        )
        this.phase = 'aborted'
        throw fallbackErr
      }
    }

    // 卡片可写之后若已有 buffered 内容（text / reasoning / tools），
    // 立刻触发一次 flush —— 否则 content_start{tool_use} 或 thinking 在
    // ensureCreated 期间到达的状态会一直卡在节流 gate 上，用户看不到。
    if (this.hasAnyContent()) {
      void this.flushController.throttledUpdate(this.currentThrottle())
    }
  }

  /** 追加文本增量。不等待，只安排一次节流 flush。 */
  appendText(delta: string): void {
    if (!delta) return
    if (this.phase === 'completed' || this.phase === 'aborted') return
    this.accumulatedText += delta
    void this.flushController.throttledUpdate(this.currentThrottle())
  }

  /** 追加 reasoning/thinking delta —— 与 appendText 并列，渲染为顶部预览。 */
  appendReasoning(delta: string): void {
    if (!delta) return
    if (this.phase === 'completed' || this.phase === 'aborted') return
    this.accumulatedReasoningText += delta
    void this.flushController.throttledUpdate(this.currentThrottle())
  }

  /** 记录一次 tool_use 开始。dedupe 按 toolUseId（缺省时按 name+index）。 */
  startTool(toolUseId: string | undefined, toolName: string | undefined): void {
    if (this.phase === 'completed' || this.phase === 'aborted') return
    if (!toolName) return
    const id = toolUseId || `${toolName}#${this.toolSteps.length}`
    if (this.toolSteps.some((s) => s.id === id)) return
    this.toolSteps.push({ id, name: toolName, status: 'running' })
    void this.flushController.throttledUpdate(this.currentThrottle())
  }

  /** 把指定 tool 的状态从 running 切到 done。先按 id 匹配，再 fallback name。 */
  completeTool(toolUseId: string | undefined, toolName: string | undefined): void {
    if (this.phase === 'completed' || this.phase === 'aborted') return
    let step: ToolStep | undefined
    if (toolUseId) {
      step = this.toolSteps.find((s) => s.id === toolUseId)
    }
    if (!step && toolName) {
      for (let i = this.toolSteps.length - 1; i >= 0; i--) {
        const s = this.toolSteps[i]!
        if (s.name === toolName && s.status === 'running') {
          step = s
          break
        }
      }
    }
    if (!step) return
    if (step.status === 'done') return
    step.status = 'done'
    void this.flushController.throttledUpdate(this.currentThrottle())
  }

  /** 是否已有任何可渲染内容（文本 / 推理 / 工具）。 */
  private hasAnyContent(): boolean {
    return (
      this.accumulatedText.length > 0 ||
      this.accumulatedReasoningText.length > 0 ||
      this.toolSteps.length > 0
    )
  }

  /**
   * 流式结束，切到最终态。
   * - 先 waitForFlush 确保中间帧写入完成
   * - 然后 close streaming_mode（仅 CardKit 路径）
   * - 最后用完整 rendered 卡片 update
   * - complete FlushController 锁死，后续 appendText 被忽略
   */
  async finalize(): Promise<void> {
    if (this.phase === 'completed' || this.phase === 'aborted') return
    if (this.phase === 'idle') {
      // 完全没开始 —— 直接标记完成
      this.phase = 'completed'
      this.flushController.complete()
      return
    }
    this.phase = 'finalizing'
    this.flushController.cancelPendingFlush()
    await this.flushController.waitForFlush()

    const finalText = this.terminalText()
    try {
      if (this.cardId) {
        // CardKit 路径: settings(false) + card.update（即使中间 stream 曾失败）
        this.sequence += 1
        await setCardStreamingMode(
          this.deps.larkClient,
          this.cardId,
          false,
          this.sequence,
        )
        this.sequence += 1
        await updateCardKitCard(
          this.deps.larkClient,
          this.cardId,
          buildRenderedCard(finalText),
          this.sequence,
        )
      } else if (this.messageId) {
        // Patch fallback 路径: 全量替换
        await this.deps.larkClient.im.message.patch({
          path: { message_id: this.messageId },
          data: { content: JSON.stringify(buildRenderedCard(finalText)) },
        })
      }
    } catch (err) {
      console.error(
        '[Feishu StreamingCard] finalize failed:',
        err instanceof Error ? err.message : err,
      )
      // 不抛出 —— 用户已经看到某种版本的内容，finalize 失败不是致命错误
    } finally {
      this.phase = 'completed'
      this.lastFlushedText = finalText
      this.flushController.complete()
    }
  }

  /** 错误中止 —— 尝试把错误信息渲染到卡片上。 */
  async abort(err: Error): Promise<void> {
    if (this.phase === 'completed' || this.phase === 'aborted') return
    const wasIdle = this.phase === 'idle'
    this.phase = 'aborted'
    this.flushController.cancelPendingFlush()
    await this.flushController.waitForFlush().catch(() => {})

    if (wasIdle || !this.messageId) {
      // 卡片还没创建成功，没法渲染错误 —— 由上层 sendText 兜底
      this.flushController.complete()
      return
    }

    const errCard = buildErrorCard(
      `${err.message}${this.accumulatedText ? '\n\n——\n\n' + this.accumulatedText : ''}`,
    )
    try {
      if (this.cardId) {
        this.sequence += 1
        await setCardStreamingMode(
          this.deps.larkClient,
          this.cardId,
          false,
          this.sequence,
        ).catch(() => {}) // 关流失败无所谓，update 才是关键
        this.sequence += 1
        await updateCardKitCard(
          this.deps.larkClient,
          this.cardId,
          errCard,
          this.sequence,
        )
      } else {
        await this.deps.larkClient.im.message.patch({
          path: { message_id: this.messageId },
          data: { content: JSON.stringify(errCard) },
        })
      }
    } catch (renderErr) {
      console.error(
        '[Feishu StreamingCard] abort render failed:',
        renderErr instanceof Error ? renderErr.message : renderErr,
      )
    } finally {
      this.flushController.complete()
    }
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  /** 当前应使用的节流时长。 */
  private currentThrottle(): number {
    return this.cardKitStreamActive ? THROTTLE.CARDKIT_MS : THROTTLE.PATCH_MS
  }

  /** 组合 reasoning + toolSteps + answerText，经 sanitize + optimize 管道出来。
   *
   *  顺序为 tools → reasoning → answer，以分隔符隔开：
   *  - tools 永远在最顶部，方便用户先看到 "现在在跑什么"
   *  - reasoning 居中（thinking 文本）
   *  - answer 在底部
   *
   *  整张卡片只用最朴素的 markdown：plain text + emoji + bold + line break。
   *  **不使用** blockquote / list / heading —— 这些会被
   *  optimizeMarkdownForFeishu 触发额外的 <br> 注入和 H 降级，并且历史上
   *  曾导致飞书 CardKit 校验报错（"long wait → 一次性 dump" 退化的根因）。
   *  任意 section 为空则忽略；全部为空时返回等待提示。 */
  private renderedText(): string {
    const sections: string[] = []

    if (this.toolSteps.length > 0) {
      // 单行 inline 形式: ⚙️ Bash · ✅ Read · ⚙️ Glob ...
      // 用中点分隔，比 markdown list 更不容易触发 Feishu 排版异常
      const inline = this.toolSteps
        .map((s) => `${s.status === 'done' ? '✅' : '⚙️'} ${s.name}`)
        .join(' · ')
      sections.push(`🛠️ ${inline}`)
    }

    if (this.accumulatedReasoningText) {
      const preview = truncateReasoningPreview(
        this.accumulatedReasoningText,
        REASONING_PREVIEW_CHARS,
      )
      // openclaw 风格: 一行 header + 空行 + 原文。不引用 / 不缩进，让飞书
      // markdown 元素按普通段落渲染。
      sections.push(`💭 **思考中**\n\n${preview}`)
    }

    if (this.accumulatedText) {
      sections.push(this.accumulatedText)
    }

    if (sections.length === 0) return '☁️ *正在思考中...*'

    // 用一行分隔符把 sections 分开，比单纯空行更稳定
    const composed = sections.join('\n\n---\n\n')

    // 表格数限制在 optimize 之前做 —— sanitize 对原始 markdown 最准
    const limited = sanitizeTextForCard(composed)
    return optimizeMarkdownForFeishu(limited, 2)
  }

  /** 终态文本: 只渲染最终答复正文，丢弃 reasoning 和 toolSteps。
   *
   *  推理过程和工具调用是"过程态"信息，已经在流式中展示给用户看过；
   *  message_complete 之后用户应该看到一张干净的答复卡（与 Desktop UI 对齐）。
   *  这个方法专供 finalize 调用，不要在中间帧用。
   *
   *  边界情况: 如果完全没有 accumulatedText（比如纯 thinking 没产出答案
   *  这种异常 case），退回到 renderedText() 至少把推理留下来当兜底。 */
  private terminalText(): string {
    if (this.accumulatedText) {
      const limited = sanitizeTextForCard(this.accumulatedText)
      return optimizeMarkdownForFeishu(limited, 2)
    }
    return this.renderedText()
  }

  /** FlushController 调用的 doFlush。 */
  private async performFlush(): Promise<void> {
    if (this.phase !== 'streaming') return
    if (!this.messageId) return

    // CardKit 中间帧被禁用但 cardId 仍有效 —— 跳过中间 flush，
    // 等 finalize 用 cardId 做最终 settings + update
    if (this.cardId && !this.cardKitStreamActive) return

    const finalText = this.renderedText()
    if (finalText === this.lastFlushedText) return

    if (this.cardKitStreamActive && this.cardId) {
      // CardKit 主路径
      this.sequence += 1
      try {
        await streamCardContent(
          this.deps.larkClient,
          this.cardId,
          STREAMING_ELEMENT_ID,
          finalText,
          this.sequence,
        )
        this.lastFlushedText = finalText
        this.consecutiveStreamFailures = 0
      } catch (err) {
        if (isCardRateLimitError(err)) {
          // 跳帧 —— 下次 throttledUpdate 会重试
          return
        }
        if (isCardTableLimitError(err)) {
          // 表格超限 —— 禁用流式中间帧，等 finalize 用 update 一次性发完整卡
          console.warn(
            '[Feishu StreamingCard] 230099 table limit, disabling CardKit streaming',
          )
          this.cardKitStreamActive = false
          return
        }
        // 其他错误 —— 跳帧重试，避免单次失败把整张卡冻在最初状态。
        // 只有连续失败超过阈值才认定 CardKit 不可用并降级 —— 否则
        // 用户会看到 "long wait → 完事后一次性把所有内容刷出来" 的体验
        // 退化（这是 streamCardContent 一旦报错就 disable 流式造成的）。
        this.consecutiveStreamFailures += 1
        const errMsg = err instanceof Error ? err.message : String(err)
        if (this.consecutiveStreamFailures === 1) {
          // 首帧失败先记录一次，避免日志风暴
          console.warn(
            '[Feishu StreamingCard] stream flush failed (will retry):',
            errMsg,
          )
        }
        if (this.consecutiveStreamFailures >= STREAM_FAIL_DISABLE_THRESHOLD) {
          console.error(
            `[Feishu StreamingCard] stream flush failed ${this.consecutiveStreamFailures}× consecutively, disabling CardKit streaming until finalize:`,
            errMsg,
          )
          this.cardKitStreamActive = false
        }
        return
      }
    } else {
      // Patch fallback 路径（CardKit 从未成功）
      try {
        await this.deps.larkClient.im.message.patch({
          path: { message_id: this.messageId },
          data: { content: JSON.stringify(buildRenderedCard(finalText)) },
        })
        this.lastFlushedText = finalText
      } catch (err) {
        if (isCardRateLimitError(err)) return
        console.error(
          '[Feishu StreamingCard] patch flush failed:',
          err instanceof Error ? err.message : err,
        )
      }
    }
  }

  // ------------------------------------------------------------------
  // Test helpers (exposed for unit tests, not part of public API)
  // ------------------------------------------------------------------

  /** @internal */
  _getPhase(): StreamingCardPhase {
    return this.phase
  }

  /** @internal */
  _getCardId(): string | null {
    return this.cardId
  }

  /** @internal */
  _getMessageId(): string | null {
    return this.messageId
  }

  /** @internal */
  _getSequence(): number {
    return this.sequence
  }

  /** @internal */
  _isCardKitStreamActive(): boolean {
    return this.cardKitStreamActive
  }

  /** @internal */
  _getAccumulatedText(): string {
    return this.accumulatedText
  }

  /** @internal */
  _getAccumulatedReasoning(): string {
    return this.accumulatedReasoningText
  }

  /** @internal */
  _getToolSteps(): ReadonlyArray<ToolStep> {
    return this.toolSteps
  }

  /** @internal */
  _getFlushController(): FlushController {
    return this.flushController
  }
}
