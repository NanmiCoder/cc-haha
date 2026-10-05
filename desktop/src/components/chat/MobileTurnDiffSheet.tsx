import { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { IconButton } from '@/components/ui/IconButton'
import { LoadingState } from '@/components/ui/LoadingState'
import { MobileBottomSheet } from '@/components/ui/MobileBottomSheet'
import { sessionsApi } from '../../api/sessions'
import { WorkspaceDiffSurface } from '../workspace/WorkspaceDiffSurface'

type Props = {
  sessionId: string
  targetUserMessageId: string
  userMessageIndex?: number
  /** Workspace-relative paths of the files this turn changed, in card order. */
  paths: string[]
  /** The file to show; null closes the sheet. */
  openPath: string | null
  onOpenPathChange: (path: string | null) => void
}

type DiffState =
  | { status: 'loading' }
  | { status: 'ready'; diff: string }
  | { status: 'empty' }
  | { status: 'error'; message: string | null }

/**
 * A turn's change to one file, full height on the phone. The desktop opens
 * this in the workspace's review tab beside the chat; a phone has no room
 * beside anything, so the same recorded change opens here instead — unified,
 * lines wrapped, with the turn's other files a tap away.
 */
export function MobileTurnDiffSheet({
  sessionId,
  targetUserMessageId,
  userMessageIndex,
  paths,
  openPath,
  onOpenPathChange,
}: Props) {
  const t = useTranslation()
  const [state, setState] = useState<DiffState>({ status: 'loading' })
  const index = openPath ? paths.indexOf(openPath) : -1

  useEffect(() => {
    if (!openPath) return
    let cancelled = false
    setState({ status: 'loading' })
    void sessionsApi.getTurnCheckpointDiff(sessionId, targetUserMessageId, openPath, userMessageIndex, true)
      .then((result) => {
        if (cancelled) return
        if (result.state === 'ok' && result.diff) setState({ status: 'ready', diff: result.diff })
        else if (result.state === 'ok' || result.state === 'missing') setState({ status: 'empty' })
        else setState({ status: 'error', message: result.error ?? null })
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ status: 'error', message: error instanceof Error ? error.message : null })
      })
    return () => {
      cancelled = true
    }
  }, [openPath, sessionId, targetUserMessageId, userMessageIndex])

  return (
    <MobileBottomSheet
      open={openPath !== null}
      onClose={() => onOpenPathChange(null)}
      title={<span className="block truncate font-mono text-[13px]">{openPath}</span>}
      ariaLabel={openPath ?? t('mobile.diff.title')}
      closeLabel={t('common.close')}
      testId="mobile-turn-diff-sheet"
      tall
      headerExtra={paths.length > 1 ? (
        <div className="flex items-center justify-between gap-2">
          <IconButton
            size="2xl"
            tone="secondary"
            icon={<ChevronLeft size={18} strokeWidth={1.75} aria-hidden="true" />}
            label={t('mobile.diff.previous')}
            disabled={index <= 0}
            onClick={() => onOpenPathChange(paths[index - 1] ?? null)}
          />
          <span className="text-[12px] tabular-nums text-[var(--color-text-tertiary)]">
            {t('mobile.approval.position', { index: index + 1, total: paths.length })}
          </span>
          <IconButton
            size="2xl"
            tone="secondary"
            icon={<ChevronRight size={18} strokeWidth={1.75} aria-hidden="true" />}
            label={t('mobile.diff.next')}
            disabled={index < 0 || index >= paths.length - 1}
            onClick={() => onOpenPathChange(paths[index + 1] ?? null)}
          />
        </div>
      ) : undefined}
    >
      {state.status === 'loading' ? (
        <LoadingState label={t('common.loading')} variant="inline" size="md" className="py-10" />
      ) : state.status === 'ready' && openPath ? (
        <WorkspaceDiffSurface
          value={state.diff}
          path={openPath}
          mode="unified"
          wrapLines
          hideSingleFileHeader
          className="bg-[var(--color-surface)]"
        />
      ) : (
        <p role={state.status === 'error' ? 'alert' : undefined} className="px-4 py-8 text-center text-[13px] text-[var(--color-text-tertiary)]">
          {state.status === 'error' ? (state.message ?? t('mobile.diff.failed')) : t('mobile.diff.empty')}
        </p>
      )}
    </MobileBottomSheet>
  )
}
