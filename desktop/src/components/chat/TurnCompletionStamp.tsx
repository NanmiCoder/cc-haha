import { useSettingsStore } from '../../stores/settingsStore'
import { useTranslation } from '../../i18n'
import { formatExactMessageTimestamp, formatMessageHoverTime } from '../../lib/formatMessageTimestamp'
import { formatDurationMs } from '../../lib/backgroundTasks'
import type { TurnCompletion } from '../../lib/turnCompletion'

type Props = {
  completion: TurnCompletion
}

/**
 * Compact metadata for the last reply's action row: when the turn ended and how
 * long it took. The parent action row keeps this visible on pointer and touch
 * layouts alike (#1151).
 */
export function TurnCompletionStamp({ completion }: Props) {
  const locale = useSettingsStore((state) => state.locale)
  const t = useTranslation()

  const clockLabel = formatMessageHoverTime(completion.completedAt, locale)
  if (!clockLabel) return null

  const duration = formatDurationMs(completion.durationMs, t)

  return (
    <span
      data-turn-completion
      className="inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap text-xs tabular-nums text-[var(--color-text-tertiary)]"
    >
      <span title={formatExactMessageTimestamp(completion.completedAt, locale) || clockLabel}>
        {clockLabel}
      </span>
      {duration ? (
        <>
          <span aria-hidden="true" className="h-[3px] w-[3px] shrink-0 rounded-full bg-[var(--color-text-tertiary)]" />
          <span data-turn-completion-duration>{t('chat.turnDuration', { duration })}</span>
        </>
      ) : null}
    </span>
  )
}
