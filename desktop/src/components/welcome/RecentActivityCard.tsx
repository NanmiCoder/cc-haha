import { useEffect, useState } from 'react'
import { useTranslation } from '../../i18n'
import { projectsApi, type RecentActivityResult } from '../../api/projects'

type Props = {
  workDir: string
  /** Open the most recent session in a tab. Card hides itself afterward. */
  onContinueSession: (sessionId: string) => void
  /** Apply a "what was just happening" hand-off paragraph into the composer. */
  onApplyHandoff: (text: string) => void
  /**
   * If the parent already has a session live (ActiveSession path), the
   * "Continue this session" button is redundant — hide it.
   */
  hideContinueSessionButton?: boolean
  /**
   * Skip this sessionId when picking "the latest". Used by ActiveSession
   * so the just-created empty session doesn't appear as its own "recent
   * activity"; we want to surface the ACTUAL previous one.
   */
  excludeSessionId?: string
}

const REFRESH_INTERVAL_MS = 60_000

/**
 * Welcome-screen "Recent activity" panel. Reads on-disk derivation from
 * /api/projects/recent-activity (zero-token by design — no model
 * involvement) and renders a compact summary so a returning user can see
 * what their last session in this project was doing without re-explaining.
 *
 * Two actions:
 *   1. "Continue this session" → switch to the previous session's tab.
 *   2. "Apply hand-off" → prefill the composer with a 3-5 line summary
 *      paragraph the user can review/edit before sending. Only THIS path
 *      consumes any tokens, and only if the user explicitly hits Send.
 */
export function RecentActivityCard({
  workDir,
  onContinueSession,
  onApplyHandoff,
  hideContinueSessionButton = false,
  excludeSessionId,
}: Props) {
  const t = useTranslation()
  const [data, setData] = useState<RecentActivityResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!workDir) {
      setData(null)
      return
    }
    let cancelled = false
    const load = async () => {
      setLoading(true)
      setError(null)
      try {
        const result = await projectsApi.recentActivity(workDir, {
          ...(excludeSessionId ? { excludeSessionId } : {}),
        })
        if (!cancelled) setData(result)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load activity')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    // Light periodic refresh — git state can change while the user
    // sits on the welcome screen (commits in another terminal, etc.).
    const id = window.setInterval(() => { void load() }, REFRESH_INTERVAL_MS)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [workDir, excludeSessionId])

  if (!workDir) return null
  if (loading && !data) return null
  if (error || !data) return null
  if (!data.hasActivity) return null

  const { lastSession, git } = data

  // Build the hand-off paragraph the "Apply hand-off" button will prefill.
  const handoffText = buildHandoffText({ data, t })

  return (
    <div
      data-testid="recent-activity-card"
      className="mt-6 w-full max-w-3xl px-4"
    >
      <h2 className="mb-2 text-center text-xs font-medium uppercase tracking-wider text-[var(--color-text-tertiary)]">
        {t('empty.recentActivity.heading')}
      </h2>
      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] p-3">
        <div className="flex items-center gap-3">
          <span
            className="material-symbols-outlined shrink-0 text-[20px] text-[var(--color-text-secondary)]"
            aria-hidden="true"
          >
            history
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            {/* Title row */}
            {lastSession && (
              <div className="flex items-baseline gap-2">
                <span
                  className="truncate text-sm font-medium text-[var(--color-text-primary)]"
                  title={lastSession.title}
                  data-testid="recent-activity-title"
                >
                  {lastSession.title}
                </span>
                <span className="shrink-0 text-[11px] text-[var(--color-text-tertiary)]">
                  {formatRelativeTime(lastSession.modifiedAt, t)}
                </span>
              </div>
            )}

            {/* Single chips row — dense, all the project state in one line */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--color-text-tertiary)]">
              {lastSession && (
                <span className="inline-flex items-center gap-1">
                  <span className="material-symbols-outlined text-[12px]" aria-hidden="true">forum</span>
                  {t('empty.recentActivity.messages', { count: lastSession.messageCount })}
                </span>
              )}
              {lastSession && lastSession.filesEditedCount > 0 && (
                <span
                  className="inline-flex items-center gap-1"
                  data-testid="recent-activity-files"
                  title={lastSession.filesEditedSample.slice(0, 5).map(basename).join(', ')}
                >
                  <span className="material-symbols-outlined text-[12px]" aria-hidden="true">draft</span>
                  {t('empty.recentActivity.filesEdited', { count: lastSession.filesEditedCount })}
                </span>
              )}
              {git?.branch && (
                <span className="inline-flex items-center gap-1" data-testid="recent-activity-branch">
                  <span className="material-symbols-outlined text-[12px]" aria-hidden="true">account_tree</span>
                  {git.branch}
                </span>
              )}
              {git && git.aheadCount > 0 && (
                <span className="inline-flex items-center gap-1" data-testid="recent-activity-ahead">
                  <span className="material-symbols-outlined text-[12px]" aria-hidden="true">north</span>
                  {t('empty.recentActivity.commitsAhead', { count: git.aheadCount })}
                </span>
              )}
              {git && git.dirtyCount > 0 && (
                <span className="inline-flex items-center gap-1" data-testid="recent-activity-dirty">
                  <span className="material-symbols-outlined text-[12px]" aria-hidden="true">edit_note</span>
                  {t('empty.recentActivity.dirtyFiles', { count: git.dirtyCount })}
                </span>
              )}
            </div>
          </div>

          {/* Action buttons — right side, vertical to keep card height short */}
          <div className="flex shrink-0 items-center gap-1.5">
            {!hideContinueSessionButton && lastSession && (
              <button
                type="button"
                onClick={() => onContinueSession(lastSession.sessionId)}
                data-testid="recent-activity-continue-session"
                title={t('empty.recentActivity.continueSession')}
                className="inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] px-2 py-1 text-xs text-[var(--color-text-primary)] transition-colors hover:border-[var(--color-primary)] hover:bg-[var(--color-surface-hover)]"
              >
                <span className="material-symbols-outlined text-[14px]" aria-hidden="true">tab</span>
                <span className="hidden sm:inline">{t('empty.recentActivity.continueSession')}</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => onApplyHandoff(handoffText)}
              data-testid="recent-activity-apply-handoff"
              title={t('empty.recentActivity.applyHandoff')}
              className="inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] px-2 py-1 text-xs text-[var(--color-text-primary)] transition-colors hover:border-[var(--color-primary)] hover:bg-[var(--color-surface-hover)]"
            >
              <span className="material-symbols-outlined text-[14px]" aria-hidden="true">north_east</span>
              <span className="hidden sm:inline">{t('empty.recentActivity.applyHandoff')}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function basename(p: string): string {
  // Last segment, accept either / or \ separator.
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] || p
}

type Translate = ReturnType<typeof useTranslation>

/**
 * Build a hand-off paragraph from the activity result. Kept short on
 * purpose — it's a starter, not a transcript replay. Same-locale via t().
 */
export function buildHandoffText({
  data,
  t,
}: {
  data: RecentActivityResult
  t: Translate
}): string {
  const lines: string[] = []
  const { lastSession, git } = data

  if (lastSession) {
    if (git?.branch) {
      lines.push(
        t('empty.recentActivity.handoff.branchLine', {
          branch: git.branch,
          title: lastSession.title,
        }),
      )
    } else {
      lines.push(
        t('empty.recentActivity.handoff.titleLine', {
          title: lastSession.title,
        }),
      )
    }

    if (lastSession.filesEditedCount > 0) {
      const sample = lastSession.filesEditedSample.slice(0, 5).join(', ')
      const moreSuffix =
        lastSession.filesEditedCount > 5
          ? t('empty.recentActivity.handoff.filesMore', {
              count: lastSession.filesEditedCount - 5,
            })
          : ''
      lines.push(
        t('empty.recentActivity.handoff.filesLine', {
          files: sample,
          more: moreSuffix,
        }),
      )
    }
  }

  if (git) {
    if (git.aheadCount > 0) {
      lines.push(
        t('empty.recentActivity.handoff.aheadLine', { count: git.aheadCount }),
      )
    }
    if (git.dirtyCount > 0) {
      lines.push(
        t('empty.recentActivity.handoff.dirtyLine', { count: git.dirtyCount }),
      )
    }
  }

  lines.push('')
  lines.push(t('empty.recentActivity.handoff.continuePrompt'))

  return lines.join('\n')
}

function formatRelativeTime(iso: string, t: Translate): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const diffMs = Date.now() - d.getTime()
  const min = Math.round(diffMs / 60_000)
  if (min < 1) return t('empty.recentActivity.justNow')
  if (min < 60) return t('empty.recentActivity.minutesAgo', { count: min })
  const hr = Math.round(min / 60)
  if (hr < 24) return t('empty.recentActivity.hoursAgo', { count: hr })
  const day = Math.round(hr / 24)
  return t('empty.recentActivity.daysAgo', { count: day })
}
