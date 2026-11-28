import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { CopyButton } from '@/components/ui/CopyButton'
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
const ESCALATED_RETRY_DELAY_MS = 30_000
const ESCALATED_RETRY_ATTEMPT = 3

function formatErrorType(errorType: string | undefined): string | null {
  if (!errorType || errorType === 'unknown') return null
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
      : httpStatusText ?? (apiRetry.errorType === 'connection_error'
        ? t('chat.retry.networkError')
        : formatErrorType(apiRetry.errorType)) ?? t('chat.retry.interrupted')
    const detailText = apiRetry.errorMessage?.trim() || t('chat.retry.missingReason')
    const diagnostics = [
      `${t('chat.retry.session')}: ${activeTabId}`,
      `${t('chat.retry.time')}: ${new Date(apiRetry.receivedAt).toISOString()}`,
      t('chat.retry.attempt', { attempt: apiRetry.attempt, max: apiRetry.maxRetries }),
      statusText,
      apiRetry.errorType,
      apiRetry.requestId ? `${t('chat.retry.requestId')}: ${apiRetry.requestId}` : null,
      detailText,
    ].filter(Boolean).join('\n')
    const waitText = remainingMs <= 0
      ? t('chat.retry.retrying')
      : remainingMs >= HUMAN_READABLE_RETRY_THRESHOLD_MS
        ? t('chat.retry.waitingLong', {
            duration: formatDurationSeconds(remainingMs / 1000, t, 1),
          })
        : t('chat.retry.waiting', { seconds: formatRetrySeconds(remainingMs) })

    const isEscalatedRetry =
      apiRetry.errorType === 'rate_limit' ||
      apiRetry.attempt >= ESCALATED_RETRY_ATTEMPT ||
      apiRetry.retryDelayMs >= ESCALATED_RETRY_DELAY_MS

    if (!isEscalatedRetry) {
      // Early short transient retry: calm muted inline status instead of a loud
      // warning banner, while keeping full diagnostics one click away.
      return (
        <div
          data-testid="api-retry-indicator"
          data-retry-tone="quiet"
          role="status"
          aria-live="polite"
          className="mb-1 flex w-full flex-wrap items-center gap-x-2 gap-y-1 py-0.5 text-[13px] text-[var(--color-text-tertiary)]"
        >
          <span className="codex-shimmer-text font-medium">{t('chat.retry.title')}</span>
          <span className="font-mono text-[11px] tabular-nums">
            {t('chat.retry.attempt', { attempt: apiRetry.attempt, max: apiRetry.maxRetries })}
          </span>
          <span className="font-mono text-[11px] tabular-nums">{statusText}</span>
          <span className="text-[12px] tabular-nums">{waitText}</span>
          <details className="w-full min-w-0 text-xs">
            <summary className="cursor-pointer rounded-[var(--radius-sm)] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]">
              {t('chat.retry.details')}
            </summary>
            <pre className="scrollbar-autohide mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-[var(--color-text-secondary)]">{diagnostics}</pre>
            <p className="mt-2 text-[var(--color-text-tertiary)]">{t('chat.retry.historyHint')}</p>
            <CopyButton
              text={diagnostics}
              label={t('chat.retry.copyDiagnostics')}
              copiedLabel={t('common.copied')}
              className="mt-2 rounded-[var(--radius-sm)] border border-[var(--color-border)] px-2 py-1 text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
            />
          </details>
        </div>
      )
    }

    return (
      <div
        data-testid="api-retry-indicator"
        data-retry-tone="escalated"
        role="status"
        aria-live="polite"
        className="mb-2 flex w-full flex-wrap items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-warning-container)] px-3 py-2 text-xs text-[var(--color-on-warning-container)]"
      >
        <RefreshCw size={14} strokeWidth={1.75} className="shrink-0 animate-spin" aria-hidden="true" />
        <span className="font-medium">{t('chat.retry.title')}</span>
        <Badge mono pill={false} bordered className="leading-none">
          {t('chat.retry.attempt', { attempt: apiRetry.attempt, max: apiRetry.maxRetries })}
        </Badge>
        <Badge mono pill={false} bordered className="leading-none">
          {statusText}
        </Badge>
        <span>{waitText}</span>
        <details className="w-full min-w-0">
          <summary className="cursor-pointer rounded-[var(--radius-sm)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]">
            {t('chat.retry.details')}
          </summary>
          <pre className="scrollbar-autohide mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px]">{diagnostics}</pre>
          <p className="mt-2">{t('chat.retry.historyHint')}</p>
          <CopyButton
            text={diagnostics}
            label={t('chat.retry.copyDiagnostics')}
            copiedLabel={t('common.copied')}
            className="mt-2 rounded-[var(--radius-sm)] border border-current px-2 py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
          />
        </details>
      </div>
    )
  }

  if (streamingFallback) {
    // 预期内的降级等待（非错误）：非流式响应一次性返回，期间无增量输出。
    return (
      <div
        data-testid="streaming-fallback-indicator"
        role="status"
        aria-live="polite"
        className="flex min-h-6 w-fit max-w-full flex-wrap items-center gap-x-1.5 py-0.5 text-[13px] text-[var(--color-text-secondary)]"
      >
        <span className="codex-shimmer-text font-medium">
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
    <div
      data-testid="turn-status-indicator"
      role="status"
      aria-live="polite"
      className="flex min-h-6 w-fit max-w-full items-center gap-1.5 py-0.5 text-[13px] text-[var(--color-text-tertiary)]"
    >
      <span className="codex-shimmer-text min-w-0 truncate font-medium">{verb}...</span>
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
  )
}

/** Elapsed time and token count: small, monospaced, steady-width digits. */
const STATUS_META_CLASS = 'shrink-0 whitespace-nowrap font-mono text-[11px] tabular-nums text-[var(--color-text-tertiary)]'
