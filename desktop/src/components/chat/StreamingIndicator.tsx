import { useEffect, useState } from 'react'
import { LoaderCircle, RefreshCw } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { useChatStore } from '../../stores/chatStore'
import { useTabStore } from '../../stores/tabStore'
import { useTranslation, type TranslationKey } from '../../i18n'
import { formatTokenCount } from '../../lib/formatTokenCount'
import { formatDurationSeconds } from '../../lib/backgroundTasks'

function translateServerVerb(
  t: (key: TranslationKey) => string,
  verb: string,
): string {
  const key = `serverVerb.${verb}` as TranslationKey
  const translated = t(key)
  return translated === key ? verb : translated
}

/**
 * What the turn is currently doing, in the user's language.
 *
 * This is the only place in the UI that reports the verb, the elapsed time and
 * the tokens so far — the composer keeps just a Stop button. Do not delete this
 * component on the assumption the composer covers it, and do not fold it into
 * the turn rail either: during `isPreparingTurn` the session is still being
 * created, so the transcript holds no render items and there is no rail to hang
 * it on. That gap is exactly what regressed once before.
 */
export function resolveTurnStatusVerb(
  t: (key: TranslationKey) => string,
  chatState: string,
  statusVerb: string,
): string {
  if (statusVerb) return translateServerVerb(t, statusVerb)
  if (chatState === 'thinking') return t('serverVerb.Thinking')
  if (chatState === 'compacting') return t('serverVerb.Compacting conversation')
  if (chatState === 'tool_executing') return t('serverVerb.Running')
  return t('serverVerb.Working')
}

function formatRetrySeconds(ms: number): number {
  return Math.max(0, Math.ceil(ms / 1000))
}

const HUMAN_READABLE_RETRY_THRESHOLD_MS = 60_000

function formatErrorType(errorType: string | undefined): string | null {
  if (!errorType) return null
  return errorType
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function StreamingIndicator() {
  const t = useTranslation()
  const [now, setNow] = useState(() => Date.now())
  const activeTabId = useTabStore((s) => s.activeTabId)
  const sessionState = useChatStore((s) => activeTabId ? s.sessions[activeTabId] : undefined)
  const chatState = sessionState?.isPreparingTurn
    ? 'thinking'
    : sessionState?.chatState ?? 'idle'
  const statusVerb = sessionState?.statusVerb ?? ''
  const apiRetry = sessionState?.apiRetry ?? null
  const streamingFallback = sessionState?.streamingFallback ?? null
  const elapsedSeconds = sessionState?.elapsedSeconds ?? 0
  // chars ÷ 4 estimates output tokens for this turn, mirroring the CLI spinner.
  const streamingTokens = Math.round((sessionState?.streamingResponseChars ?? 0) / 4)

  useEffect(() => {
    if (!apiRetry) return undefined
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [apiRetry?.receivedAt, apiRetry?.retryDelayMs])

  if (apiRetry) {
    const remainingMs = Math.max(0, apiRetry.retryDelayMs - (now - apiRetry.receivedAt))
    const httpStatusText = apiRetry.errorStatus !== null
      ? t('chat.retry.httpStatus', { status: apiRetry.errorStatus })
      : null
    const statusText = apiRetry.errorType === 'rate_limit'
      ? [t('chat.retry.rateLimit'), httpStatusText].filter(Boolean).join(' · ')
      : httpStatusText ?? formatErrorType(apiRetry.errorType) ?? t('chat.retry.networkError')
    const detailText = apiRetry.errorMessage?.trim()
    const waitText = remainingMs <= 0
      ? t('chat.retry.retrying')
      : remainingMs >= HUMAN_READABLE_RETRY_THRESHOLD_MS
        ? t('chat.retry.waitingLong', {
            duration: formatDurationSeconds(remainingMs / 1000, t, 1),
          })
        : t('chat.retry.waiting', { seconds: formatRetrySeconds(remainingMs) })

    return (
      <div
        data-testid="api-retry-indicator"
        role="status"
        aria-live="polite"
        className="mb-2 flex w-full flex-wrap items-center gap-2 rounded-[var(--radius-md)] bg-[var(--color-warning-container)] px-3 py-2 text-xs text-[var(--color-on-warning-container)]"
      >
        <RefreshCw size={14} strokeWidth={1.75} className="shrink-0 animate-spin" aria-hidden="true" />
        <span className="font-medium">{t('chat.retry.title')}</span>
        {/*
          Neutral rather than `tone="warning"`: these chips sit on the warning
          container itself, so a warning-tinted chip would disappear into it,
          and the warning accent as foreground on that fill measures 2.66:1 in
          the light theme (see components/AGENTS.md §3.2).
        */}
        <Badge mono pill={false} bordered className="leading-none">
          {t('chat.retry.attempt', { attempt: apiRetry.attempt, max: apiRetry.maxRetries })}
        </Badge>
        <Badge mono pill={false} bordered className="leading-none">
          {statusText}
        </Badge>
        <span>{waitText}</span>
        {detailText && (
          <span className="min-w-0 max-w-full truncate opacity-80" title={detailText}>
            {detailText}
          </span>
        )}
      </div>
    )
  }

  if (streamingFallback) {
    // 预期内的降级等待（非错误）：非流式响应一次性返回，期间无增量输出。
    // 用中性样式的轻提示 + 回合计时，与 api_retry 的警示横幅区分开。
    return (
      <div
        data-testid="streaming-fallback-indicator"
        role="status"
        aria-live="polite"
        className="flex min-h-7 w-fit max-w-full flex-wrap items-center gap-x-2 text-[13px] text-[var(--color-text-secondary)]"
      >
        <RefreshCw size={14} strokeWidth={1.75} className="shrink-0 animate-spin text-[var(--color-text-tertiary)]" aria-hidden="true" />
        <span className="font-medium text-[var(--color-text-primary)]">
          {t('chat.fallback.title')}
        </span>
        <span className="text-xs text-[var(--color-text-tertiary)]">
          {t('chat.fallback.detail')}
        </span>
        {elapsedSeconds > 0 && (
          <span className={STATUS_META_CLASS}>
            {formatDurationSeconds(elapsedSeconds, t)}
          </span>
        )}
      </div>
    )
  }

  const verb = resolveTurnStatusVerb(t, chatState, statusVerb)

  return (
    <>
      <style>{TURN_STATUS_STYLES}</style>
      <div
        data-testid="turn-status-indicator"
        role="status"
        aria-live="polite"
        // Bare line, not a pill: it sits at the end of the live turn, and a
        // bordered chip here would read as a second, competing status object.
        className="flex h-7 w-fit max-w-full items-center gap-2 text-[13px] text-[var(--color-text-secondary)]"
      >
        {/* The ring a running tool row spins, in the running colour: the
            turn is working, and it says so the way the rest of the timeline
            does rather than with a decorative "AI" glyph. */}
        <LoaderCircle
          size={15}
          strokeWidth={1.75}
          aria-hidden="true"
          className="turn-status-spinner shrink-0 text-[var(--color-info)] motion-safe:animate-spin"
        />
        <span className="turn-status-shimmer min-w-0 truncate font-medium">{verb}...</span>
        {elapsedSeconds > 0 && (
          <span className={STATUS_META_CLASS}>{formatDurationSeconds(elapsedSeconds, t)}</span>
        )}
        {streamingTokens > 0 && (
          <>
            <span aria-hidden="true" className="h-[3px] w-[3px] shrink-0 rounded-full bg-[var(--color-text-tertiary)]" />
            <span className={STATUS_META_CLASS}>
              ↓ {t('common.tokens', { count: formatTokenCount(streamingTokens) })}
            </span>
          </>
        )}
      </div>
    </>
  )
}

/** Elapsed time and token count: small, monospaced, steady-width digits. */
const STATUS_META_CLASS = 'shrink-0 whitespace-nowrap font-mono text-[11px] tabular-nums text-[var(--color-text-tertiary)]'

/**
 * The verb reads as live through a light sweeping across it, and the ring
 * spins; neither moves the layout. Reduced motion keeps both still and leaves
 * the text in its plain secondary colour.
 */
const TURN_STATUS_STYLES = `
@keyframes turn-status-sweep {
  from { background-position: 100% 0; }
  to { background-position: -100% 0; }
}
.turn-status-shimmer {
  background: linear-gradient(90deg, var(--color-text-tertiary) 0%, var(--color-text-tertiary) 40%, var(--color-text-primary) 50%, var(--color-text-tertiary) 60%, var(--color-text-tertiary) 100%);
  background-size: 200% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  animation: turn-status-sweep 2.2s linear infinite;
}
@media (prefers-reduced-motion: reduce) {
  .turn-status-shimmer {
    animation: none;
    background: none;
    color: var(--color-text-secondary);
  }
}
`
