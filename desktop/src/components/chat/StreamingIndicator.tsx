import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { useChatStore } from '../../stores/chatStore'
import { useTabStore } from '../../stores/tabStore'
import { useTranslation, type TranslationKey } from '../../i18n'
import { formatTokenCount } from '../../lib/formatTokenCount'

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}m ${s}s`
}

function translateServerVerb(
  t: (key: TranslationKey) => string,
  verb: string,
): string {
  const key = `serverVerb.${verb}` as TranslationKey
  const translated = t(key)
  return translated === key ? verb : translated
}

function formatRetrySeconds(ms: number): number {
  return Math.max(0, Math.ceil(ms / 1000))
}

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
  const chatState = sessionState?.chatState ?? 'idle'
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
    const statusText = apiRetry.errorStatus !== null
      ? t('chat.retry.httpStatus', { status: apiRetry.errorStatus })
      : formatErrorType(apiRetry.errorType) ?? t('chat.retry.networkError')
    const detailText = apiRetry.errorMessage?.trim()

    return (
      <div
        data-testid="api-retry-indicator"
        role="status"
        aria-live="polite"
        className="mb-2 flex w-full max-w-[min(720px,100%)] flex-wrap items-center gap-2 rounded-md border border-amber-500/35 bg-amber-50/80 px-3 py-2 text-xs text-amber-950 shadow-sm dark:border-amber-400/25 dark:bg-amber-950/30 dark:text-amber-100"
      >
        <RefreshCw size={14} strokeWidth={2.2} className="shrink-0 animate-spin text-amber-700 dark:text-amber-300" aria-hidden="true" />
        <span className="font-medium">{t('chat.retry.title')}</span>
        <span className="rounded-[4px] border border-amber-700/20 bg-white/70 px-1.5 py-0.5 font-mono text-[11px] leading-none text-amber-900 dark:border-amber-300/20 dark:bg-black/15 dark:text-amber-100">
          {t('chat.retry.attempt', { attempt: apiRetry.attempt, max: apiRetry.maxRetries })}
        </span>
        <span className="rounded-[4px] border border-amber-700/20 bg-white/70 px-1.5 py-0.5 font-mono text-[11px] leading-none text-amber-900 dark:border-amber-300/20 dark:bg-black/15 dark:text-amber-100">
          {statusText}
        </span>
        <span className="text-amber-800 dark:text-amber-200">
          {remainingMs > 0
            ? t('chat.retry.waiting', { seconds: formatRetrySeconds(remainingMs) })
            : t('chat.retry.retrying')}
        </span>
        {detailText && (
          <span className="min-w-0 max-w-full truncate text-amber-700 dark:text-amber-200" title={detailText}>
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
        className="mb-2 flex w-fit items-center gap-2 rounded-full border border-[var(--color-border)]/40 bg-[var(--color-surface-container-low)] px-3 py-1"
      >
        <RefreshCw size={12} strokeWidth={2.2} className="shrink-0 animate-spin text-[var(--color-text-secondary)]" aria-hidden="true" />
        <span className="text-xs font-medium text-[var(--color-text-secondary)]">
          {t('chat.fallback.title')}
        </span>
        <span className="text-[10px] text-[var(--color-text-tertiary)]">
          {t('chat.fallback.detail')}
        </span>
        {elapsedSeconds > 0 && (
          <span className="text-[10px] text-[var(--color-text-tertiary)]">
            {formatElapsed(elapsedSeconds)}
          </span>
        )}
      </div>
    )
  }

  let verb: string
  if (statusVerb) {
    verb = translateServerVerb(t, statusVerb)
  } else {
    verb = chatState === 'thinking'
      ? t('serverVerb.Thinking')
      : chatState === 'compacting'
        ? t('serverVerb.Compacting conversation')
      : chatState === 'tool_executing'
        ? t('serverVerb.Running')
        : t('serverVerb.Working')
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="mb-2 flex w-fit items-center gap-2 rounded-full border border-[var(--color-border)]/40 bg-[var(--color-surface-container-low)] px-3 py-1"
    >
      <span className="material-symbols-outlined text-[14px] text-[var(--color-brand)] animate-shimmer" aria-hidden="true">auto_awesome</span>
      <span className="text-xs font-medium text-[var(--color-text-secondary)]">{verb}...</span>
      {elapsedSeconds > 0 && (
        <span className="text-[10px] text-[var(--color-text-tertiary)]">
          {formatElapsed(elapsedSeconds)}
        </span>
      )}
      {streamingTokens > 0 && (
        <span className="text-[10px] text-[var(--color-text-tertiary)]">
          · ↓ {t('common.tokens', { count: formatTokenCount(streamingTokens) })}
        </span>
      )}
    </div>
  )
}
