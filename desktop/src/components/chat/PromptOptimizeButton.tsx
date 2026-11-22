import { useEffect, useState, type FocusEvent, type MouseEvent } from 'react'
import { Check, Wand } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { Spinner } from '@/components/ui/Spinner'
import { useTranslation } from '@/i18n'
import type { PromptOptimizeController } from './usePromptOptimize'

/** How long the post-optimization restore pill stays visible without pointer/focus. */
export const PROMPT_OPTIMIZE_NOTICE_MS = 8_000

const keepCaret = (event: MouseEvent) => event.preventDefault()

type PromptOptimizeButtonProps = {
  controller: PromptOptimizeController
  canOptimize: boolean
  /** 44px touch target on phones, hidden when idle with an empty draft. */
  mobile?: boolean
}

export function PromptOptimizeButton({
  controller,
  canOptimize,
  mobile = false,
}: PromptOptimizeButtonProps) {
  const t = useTranslation()
  const { isOptimizing, restoreSnapshot, optimize, cancel, restore, dismissRestore } = controller
  const [attended, setAttended] = useState(false)
  const snapshotId = restoreSnapshot?.id

  useEffect(() => {
    setAttended(false)
  }, [snapshotId])

  useEffect(() => {
    if (snapshotId === undefined || attended) return
    const timer = setTimeout(dismissRestore, PROMPT_OPTIMIZE_NOTICE_MS)
    return () => clearTimeout(timer)
  }, [attended, dismissRestore, snapshotId])

  if (mobile && !canOptimize && !isOptimizing && !restoreSnapshot) {
    return null
  }

  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setAttended(false)
    }
  }

  const iconSize = mobile ? 20 : 16

  return (
    <div data-testid="prompt-optimize" className="relative flex shrink-0 items-center">
      {isOptimizing ? (
        <IconButton
          icon={<Spinner size={iconSize} tone="brand" />}
          label={t('chat.promptOptimize.cancel')}
          size={mobile ? '2xl' : 'md'}
          tone="brand"
          filled
          aria-busy="true"
          data-testid="prompt-optimize-button"
          onMouseDown={keepCaret}
          onClick={cancel}
        />
      ) : (
        <IconButton
          icon={<Wand size={iconSize} strokeWidth={1.75} aria-hidden="true" />}
          label={t('chat.promptOptimize.action')}
          size={mobile ? '2xl' : 'md'}
          tone="secondary"
          disabled={!canOptimize}
          data-testid="prompt-optimize-button"
          onMouseDown={keepCaret}
          onClick={() => { void optimize() }}
        />
      )}

      {restoreSnapshot && !isOptimizing ? (
        <div
          role="status"
          data-testid="prompt-optimize-notice"
          onPointerEnter={() => setAttended(true)}
          onPointerLeave={() => setAttended(false)}
          onFocus={() => setAttended(true)}
          onBlur={handleBlur}
          className="dropdown-glass popover-motion absolute bottom-full right-0 z-[var(--z-popover)] mb-2 inline-flex min-h-[30px] w-max max-w-[min(22rem,calc(100vw-2rem))] items-center gap-2 rounded-full py-1 pl-3 pr-1 text-xs text-[var(--color-text-secondary)]"
        >
          <Check size={13} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-[var(--color-success)]" />
          <span className="min-w-0 flex-1">{t('chat.promptOptimize.done')}</span>
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0"
            onMouseDown={keepCaret}
            onClick={restore}
          >
            {t('chat.promptOptimize.restore')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
