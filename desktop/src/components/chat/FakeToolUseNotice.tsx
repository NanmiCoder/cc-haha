import { useTranslation } from '../../i18n'
import type { FakeToolUseBlock } from '../../lib/fakeToolUseDetection'

type Props = {
  blocks: ReadonlyArray<FakeToolUseBlock>
}

/**
 * Inline notice rendered in the assistant message bubble when the model
 * emitted XML-style `<tool_use>` blocks as plain text. Communicates two
 * things:
 *
 *   1. The model TRIED to call a tool — we don't pretend nothing happened.
 *   2. NOTHING ran — the user shouldn't trust any "Done." or follow-up
 *      claims that depend on the call's output.
 *
 * Single notice per message regardless of block count, with a small
 * "+N more" tail when the model retried multiple times in the same turn
 * (a common pattern after the model self-corrects: "工具用错了, 重来:").
 */
export function FakeToolUseNotice({ blocks }: Props) {
  const t = useTranslation()
  if (blocks.length === 0) return null

  const first = blocks[0]!
  const remaining = blocks.length - 1
  const toolName = first.name === 'unknown' ? null : first.name
  const body = toolName
    ? t('providerCompat.notice.body', { tool: toolName })
    : t('providerCompat.notice.bodyUnknown')

  return (
    <div
      data-testid="fake-tool-use-notice"
      className="my-2 flex items-start gap-2 rounded-[8px] border border-[var(--color-warning)]/30 bg-[var(--color-warning)]/8 px-3 py-2 text-[12px] text-[var(--color-text-secondary)]"
    >
      <span
        className="material-symbols-outlined mt-0.5 shrink-0 text-[16px] text-[var(--color-warning)]"
        aria-hidden="true"
      >
        warning
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-medium text-[var(--color-text-primary)]">
          {t('providerCompat.notice.title')}
        </div>
        <div className="mt-0.5 leading-snug">
          {body}
          {remaining > 0 && (
            <span
              className="ml-1 text-[var(--color-text-tertiary)]"
              data-testid="fake-tool-use-notice-more"
            >
              {' '}
              (+{remaining})
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
