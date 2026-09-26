import { useSettingsStore } from '../../stores/settingsStore'
import { useTranslation } from '../../i18n'
import { formatExactMessageTimestamp, formatMessageHoverTime } from '../../lib/formatMessageTimestamp'
import { formatDurationMs } from '../../lib/backgroundTasks'
import { formatActivityTokens } from './activityGroupModel'
import type { TurnCompletion } from '../../lib/turnCompletion'

type Props = {
  completion: TurnCompletion
}

/**
 * Compact metadata for the last reply's action row: when the turn ended, how
 * many tokens it spent and how long it took. The parent action row keeps this
 * visible on pointer and touch layouts alike (#1151).
 *
 * Usage comes before duration, matching the activity digest's ordering. Both
 * parts are optional and render nothing when absent: a turn whose calls reported
 * no usage (older transcripts, a provider that returns none) keeps its clock
 * rather than showing a confident zero.
 */
export function TurnCompletionStamp({ completion }: Props) {
  const locale = useSettingsStore((state) => state.locale)
  // 例外：本 footer 的 usage 面向所有会话保留、不随会话扩展信息开关隐藏，
  // 只有 fork 新增的 duration 受开关控制。
  const sessionExtendedInfo = useSettingsStore((state) => state.sessionExtendedInfo)
  const t = useTranslation()

  const clockLabel = formatMessageHoverTime(completion.completedAt, locale)
  if (!clockLabel) return null

  const duration = formatDurationMs(completion.durationMs, t)
  const usageLabel =
    typeof completion.outputTokens === 'number' && completion.outputTokens > 0
      ? formatActivityTokens(completion.outputTokens)
      : ''

  return (
    <span
      data-turn-completion
      className="inline-flex min-w-0 items-center gap-2 whitespace-nowrap text-[11px] font-medium tabular-nums text-[var(--color-text-tertiary)]"
    >
      <span title={formatExactMessageTimestamp(completion.completedAt, locale) || clockLabel}>
        {clockLabel}
      </span>
      {usageLabel ? (
        <>
          <span aria-hidden="true">·</span>
          <span data-turn-completion-usage>{t('chat.turnUsage', { tokens: usageLabel })}</span>
        </>
      ) : null}
      {sessionExtendedInfo !== false && duration ? (
        <>
          <span aria-hidden="true">·</span>
          <span data-turn-completion-duration>{t('chat.turnDuration', { duration })}</span>
        </>
      ) : null}
    </span>
  )
}
