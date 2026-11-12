/**
 * Streaming card lifecycle state machine for a single chat
 *
 * Renders the LLM's streaming text increments into a Feishu CardKit card that grows with the content.
 * Encapsulates:
 * - The 5 CardKit API calls (create → send → stream × N → settings → update)
 * - Throttling + concurrency protection (FlushController)
 * - Markdown preprocessing (optimizeMarkdownForFeishu + sanitizeTextForCard)
 * - Error fallback: if CardKit fails, switch automatically to im.message.patch + Schema 2.0 card
 * - Rate limits: 230020 skips a frame and retries next time; 230099 table overflow disables CardKit streaming
 *
 * One instance per chatId; index.ts handleServerMessage coordinates the lifecycle.
 */

import type * as Lark from '@larksuiteoapi/node-sdk'
import { randomUUID } from 'node:crypto'
import { FlushController, THROTTLE } from './flush-controller.js'
import {
  createCardEntity,
  sendCardAsMessage,
  streamCardContent,
  setCardStreamingMode,
  updateCardKitCard,
  STREAMING_ELEMENT_ID,
  withImCardRequestTimeout,
} from './cardkit.js'
import { isCardRateLimitError, isCardTableLimitError } from './card-errors.js'
import { optimizeMarkdownForFeishu, sanitizeTextForCard } from './markdown-style.js'

// ---------------------------------------------------------------------------
// Card JSON builders
// ---------------------------------------------------------------------------

/** Initial streaming card: Schema 2.0 + streaming_mode + element_id.
 *
 *  Contains a single markdown element `streaming_content` whose initial content is a loading hint.
 *  renderedText() controls what is displayed (thinking / reasoning / body),
 *  avoiding a static loading element and streaming content showing at once ("two thinking indicators").
 *
 *  On finalize the whole card is updated to just the reply body. */
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
          content: '☁️ *Thinking...*',
          text_align: 'left',
          element_id: STREAMING_ELEMENT_ID,
        },
      ],
    },
  }
}

/** Fully rendered card: Schema 2.0, no streaming_mode, single markdown element.
 *
 *  The mobile "10 lines of code >" bug is avoided by `optimizeMarkdownForFeishu` downgrading
 *  fenced code to plain text, not by a multi-element structure. This is simply
 *  the plainest markdown card. */
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

/** Error card: red header + error text. Used as the abort() fallback. */
export function buildErrorCard(message: string): Record<string, unknown> {
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      title: { tag: 'plain_text', content: '❌ Something went wrong' },
      template: 'red',
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: message || 'Unknown error',
        },
      ],
    },
  }
}

/** Take at most maxLen characters from the end; when longer, prefix "..." and keep the latest maxLen-3 characters.
 *
 *  Thinking is usually a linear "analyze → conclude" process, so the tail is more useful than the head —— users
 *  care most about "what the model is thinking now", not "what it thought five thousand tokens ago". */
function truncateReasoningPreview(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  return '...' + text.slice(text.length - maxLen + 3)
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

export type StreamingCardPhase =
  | 'idle' // after constructor, before ensureCreated
  | 'creating' // ensureCreated in progress
  | 'streaming' // initial card sent, accepting appendText
  | 'finalizing' // finalize in progress
  | 'completed' // finalize done
  | 'aborted' // abort called

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

/** Maximum reasoning preview characters kept; beyond that take the tail with an ellipsis prefix. */
const REASONING_PREVIEW_CHARS = 600

/** How many consecutive streamCardContent failures before giving up on CardKit streaming.
 *  Set to 3 rather than 1 so a single blip (network, transient validation failure, etc.) does not freeze
 *  the whole card until finalize —— which users experience as "long wait → dump everything at once". */
const STREAM_FAIL_DISABLE_THRESHOLD = 3

export class StreamingCard {
  // ---- lifecycle state ----
  private phase: StreamingCardPhase = 'idle'
  /** Shared by pre-creation, content_start and terminal operations. */
  private creationPromise: Promise<void> | null = null

  // ---- CardKit state ----
  /** CardKit card_id. null = CardKit creation failed and we fell back to patch mode. */
  private cardId: string | null = null
  /** IM message_id. Should always be set (otherwise even patch is impossible). */
  private messageId: string | null = null
  /** Same idempotency key for the first IM send and any create fallback. */
  private readonly outboundMessageUuid = randomUUID()
  /** Monotonically increasing sequence number for CardKit cardElement.content(). */
  private sequence = 0
  /** CardKit streaming still working. Set to false after 230099 or N consecutive unknown errors;
   *  intermediate frames are skipped, final finalize still tries settings+update (cardId still valid). */
  private cardKitStreamActive = false
  /** Consecutive unknown streamCardContent error count. Reset on any success. */
  private consecutiveStreamFailures = 0

  // ---- text state ----
  private accumulatedText = ''
  private lastFlushedText = ''
  /** Accumulated thinking_delta, rendered as the reasoning preview blockquote at the top of the card. */
  private accumulatedReasoningText = ''
  /** Tool call trace: ordered by startTool calls; completeTool updates status. */
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
   * Create the card for the first time (CardKit main path; on failure fall back to sending a Schema 2.0 card + patch).
   * Idempotent: while creating, waits for the same creation; once created, returns immediately.
   */
  async ensureCreated(): Promise<void> {
    if (this.creationPromise) return this.creationPromise
    if (this.phase !== 'idle') return
    this.phase = 'creating'
    this.creationPromise = this.createCard()
    return this.creationPromise
  }

  private async createCard(): Promise<void> {
    try {
      // CardKit main path
      const cardId = await createCardEntity(
        this.deps.larkClient,
        buildInitialStreamingCard(),
      )
      const messageId = await sendCardAsMessage(
        this.deps.larkClient,
        this.deps.chatId,
        cardId,
        this.deps.replyToMessageId,
        this.outboundMessageUuid,
      )
      this.cardId = cardId
      this.messageId = messageId
      this.cardKitStreamActive = true
      this.sequence = 1
      if (this.phase === 'creating') this.phase = 'streaming'
      this.flushController.setCardMessageReady(true)
    } catch (cardKitErr) {
      // CardKit unavailable (permissions, network, API compatibility, etc.) → fall back to direct card + patch
      console.warn(
        '[Feishu StreamingCard] CardKit create/send failed, falling back to im.message.patch:',
        cardKitErr instanceof Error ? cardKitErr.message : cardKitErr,
      )
      try {
        const fallbackResp = await withImCardRequestTimeout('im.message.create', () =>
          this.deps.larkClient.im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: {
              receive_id: this.deps.chatId,
              msg_type: 'interactive',
              content: JSON.stringify(buildRenderedCard(' ')),
              uuid: this.outboundMessageUuid,
            },
          }),
        )
        const mid = fallbackResp.data?.message_id
        if (!mid) {
          throw new Error('fallback im.message.create returned no message_id')
        }
        this.cardId = null
        this.messageId = mid
        this.cardKitStreamActive = false
        if (this.phase === 'creating') this.phase = 'streaming'
        this.flushController.setCardMessageReady(true)
      } catch (fallbackErr) {
        // Even the fallback failed —— nothing can be displayed
        console.error(
          '[Feishu StreamingCard] Fallback card creation also failed:',
          fallbackErr instanceof Error ? fallbackErr.message : fallbackErr,
        )
        this.phase = 'aborted'
        this.flushController.complete()
        throw fallbackErr
      }
    }

    // Once the card is writable, if there is already buffered content (text / reasoning / tools),
    // trigger a flush immediately —— otherwise state from content_start{tool_use} or thinking arriving
    // during ensureCreated stays stuck at the throttle gate and the user never sees it.
    if (this.phase === 'streaming' && this.hasAnyContent()) {
      void this.flushController.throttledUpdate(this.currentThrottle())
    }
  }

  /** Append a text delta. Does not wait; just schedules a throttled flush. */
  appendText(delta: string): void {
    if (!delta) return
    if (this.phase === 'completed' || this.phase === 'aborted') return
    this.accumulatedText += delta
    void this.flushController.throttledUpdate(this.currentThrottle())
  }

  /** Append a reasoning/thinking delta —— parallel to appendText, rendered as the top preview. */
  appendReasoning(delta: string): void {
    if (!delta) return
    if (this.phase === 'completed' || this.phase === 'aborted') return
    this.accumulatedReasoningText += delta
    void this.flushController.throttledUpdate(this.currentThrottle())
  }

  /** Record a tool_use start. Deduped by toolUseId (or name+index when absent). */
  startTool(toolUseId: string | undefined, toolName: string | undefined): void {
    if (this.phase === 'completed' || this.phase === 'aborted') return
    if (!toolName) return
    const id = toolUseId || `${toolName}#${this.toolSteps.length}`
    if (this.toolSteps.some((s) => s.id === id)) return
    this.toolSteps.push({ id, name: toolName, status: 'running' })
    void this.flushController.throttledUpdate(this.currentThrottle())
  }

  /** Switch the given tool's status from running to done. Match by id first, then fall back to name. */
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

  /** Whether there is any renderable content (text / reasoning / tools). */
  private hasAnyContent(): boolean {
    return (
      this.accumulatedText.length > 0 ||
      this.accumulatedReasoningText.length > 0 ||
      this.toolSteps.length > 0
    )
  }

  /**
   * Streaming finished; switch to the final state.
   * - Wait for any in-progress creation, then waitForFlush to ensure intermediate frames are written
   * - Then close streaming_mode (CardKit path only)
   * - Finally update with the fully rendered card
   * - complete locks the FlushController; later appendText calls are ignored
   */
  async finalize(): Promise<void> {
    if (this.phase === 'completed' || this.phase === 'aborted') return
    if (this.phase === 'idle') {
      // Never started —— mark complete directly
      this.phase = 'completed'
      this.flushController.complete()
      return
    }
    this.phase = 'finalizing'
    this.flushController.cancelPendingFlush()
    // Pre-creation is fire-and-forget; IDs are only available after it settles.
    // Creation must not move a terminal operation back to streaming.
    await this.creationPromise?.catch(() => {})
    if (this.phase !== 'finalizing') return
    await this.flushController.waitForFlush()

    const finalText = this.terminalText()
    try {
      if (this.cardId) {
        // CardKit path: settings(false) + card.update (even if intermediate streams failed)
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
        // Patch fallback path: full replace
        await withImCardRequestTimeout('im.message.patch', () =>
          this.deps.larkClient.im.message.patch({
            path: { message_id: this.messageId! },
            data: { content: JSON.stringify(buildRenderedCard(finalText)) },
          }),
        )
      }
    } catch (err) {
      console.error(
        '[Feishu StreamingCard] finalize failed:',
        err instanceof Error ? err.message : err,
      )
      if (this.messageId) {
        try {
          await withImCardRequestTimeout('im.message.patch', () =>
            this.deps.larkClient.im.message.patch({
              path: { message_id: this.messageId! },
              data: { content: JSON.stringify(buildRenderedCard(finalText)) },
            }),
          )
        } catch (fallbackErr) {
          console.error(
            '[Feishu StreamingCard] finalize fallback patch failed:',
            fallbackErr instanceof Error ? fallbackErr.message : fallbackErr,
          )
        }
      }
      // Don't throw —— the user has already seen some version of the content; a finalize failure is not fatal
    } finally {
      this.phase = 'completed'
      this.lastFlushedText = finalText
      this.flushController.complete()
    }
  }

  /** Abort on error —— try to render the error message on the card. */
  async abort(err: Error): Promise<void> {
    if (this.phase === 'completed' || this.phase === 'aborted') return
    const wasIdle = this.phase === 'idle'
    this.phase = 'aborted'
    this.flushController.cancelPendingFlush()
    await this.creationPromise?.catch(() => {})
    await this.flushController.waitForFlush().catch(() => {})

    if (wasIdle || !this.messageId) {
      // Card was never created, so the error can't be rendered —— the caller falls back to sendText
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
        ).catch(() => {}) // closing the stream failing doesn't matter; update is what counts
        this.sequence += 1
        await updateCardKitCard(
          this.deps.larkClient,
          this.cardId,
          errCard,
          this.sequence,
        )
      } else {
        await withImCardRequestTimeout('im.message.patch', () =>
          this.deps.larkClient.im.message.patch({
            path: { message_id: this.messageId! },
            data: { content: JSON.stringify(errCard) },
          }),
        )
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

  /** Throttle duration to use right now. */
  private currentThrottle(): number {
    return this.cardKitStreamActive ? THROTTLE.CARDKIT_MS : THROTTLE.PATCH_MS
  }

  /** Combine reasoning + toolSteps + answerText through the sanitize + optimize pipeline.
   *
   *  Order is tools → reasoning → answer, separated by dividers:
   *  - tools always at the very top so the user first sees "what is running now"
   *  - reasoning in the middle (thinking text)
   *  - answer at the bottom
   *
   *  The whole card uses only the plainest markdown: plain text + emoji + bold + line break.
   *  **No** blockquote / list / heading —— these trigger extra <br> injection and H downgrades
   *  in optimizeMarkdownForFeishu, and historically caused
   *  Feishu CardKit validation errors (the root cause of the "long wait → dump at once" regression).
   *  Empty sections are skipped; returns the waiting hint when all are empty. */
  private renderedText(): string {
    const sections: string[] = []

    if (this.toolSteps.length > 0) {
      // Single-line inline form: ⚙️ Bash · ✅ Read · ⚙️ Glob ...
      // Separated by middle dots; less likely than a markdown list to trigger Feishu layout glitches
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
      // openclaw style: one header line + blank line + raw text. No quoting / indenting, so the Feishu
      // markdown element renders it as a normal paragraph.
      sections.push(`💭 **Thinking**\n\n${preview}`)
    }

    if (this.accumulatedText) {
      sections.push(this.accumulatedText)
    }

    if (sections.length === 0) return '☁️ *Thinking...*'

    // Separate sections with a divider line, more stable than plain blank lines
    const composed = sections.join('\n\n---\n\n')

    // Apply the table limit before optimize —— sanitize is most accurate on raw markdown
    const limited = sanitizeTextForCard(composed)
    return optimizeMarkdownForFeishu(limited, 2)
  }

  /** Final text: render only the final reply body, discarding reasoning and toolSteps.
   *
   *  Reasoning and tool calls are "in-progress" information already shown during streaming;
   *  after message_complete the user should see a clean reply card (aligned with the Desktop UI).
   *  This method is only for finalize; do not use it for intermediate frames.
   *
   *  Edge case: if there is no accumulatedText at all (e.g. an abnormal case where only thinking
   *  produced no answer), fall back to renderedText() so at least the reasoning is kept. */
  private terminalText(): string {
    if (this.accumulatedText) {
      const limited = sanitizeTextForCard(this.accumulatedText)
      return optimizeMarkdownForFeishu(limited, 2)
    }
    return this.renderedText()
  }

  /** doFlush called by FlushController. */
  private async performFlush(): Promise<void> {
    if (this.phase !== 'streaming') return
    if (!this.messageId) return

    // CardKit intermediate frames disabled but cardId still valid —— skip intermediate flushes,
    // wait for finalize to do the final settings + update with cardId
    if (this.cardId && !this.cardKitStreamActive) return

    const finalText = this.renderedText()
    if (finalText === this.lastFlushedText) return

    if (this.cardKitStreamActive && this.cardId) {
      // CardKit main path
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
          // Skip frame —— the next throttledUpdate retries
          return
        }
        if (isCardTableLimitError(err)) {
          // Table overflow —— disable streaming intermediate frames; finalize sends the full card via update
          console.warn(
            '[Feishu StreamingCard] 230099 table limit, disabling CardKit streaming',
          )
          this.cardKitStreamActive = false
          return
        }
        // Other errors —— skip the frame and retry, so a single failure doesn't freeze the card in its initial state.
        // Only after consecutive failures exceed the threshold do we deem CardKit unavailable and fall back —— otherwise
        // users see the "long wait → flush everything at once when done" experience
        // regression (caused by disabling streaming the moment streamCardContent errors).
        this.consecutiveStreamFailures += 1
        const errMsg = err instanceof Error ? err.message : String(err)
        if (this.consecutiveStreamFailures === 1) {
          // Log the first-frame failure once to avoid a log storm
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
      // Patch fallback path (CardKit never succeeded)
      try {
        await withImCardRequestTimeout('im.message.patch', () =>
          this.deps.larkClient.im.message.patch({
            path: { message_id: this.messageId! },
            data: { content: JSON.stringify(buildRenderedCard(finalText)) },
          }),
        )
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
