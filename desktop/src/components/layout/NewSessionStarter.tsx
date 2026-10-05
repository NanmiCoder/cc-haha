import { useId, useMemo } from 'react'
import { CircleX, Eye, Hammer, MessageSquare, SearchCode, type LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useTranslation, type TranslationKey } from '../../i18n'
import { useChatStore } from '../../stores/chatStore'
import { useSessionStore } from '../../stores/sessionStore'
import type { SessionListItem } from '../../types/session'
import { getSessionProjectKey, isSameOrChildPath } from './sidebarTaskGroups'

const RECENT_LIMIT = 3

/** Explicit keys, so a literal-only i18n scan sees every one of them. */
const SUGGESTIONS: ReadonlyArray<{ id: string; icon: LucideIcon; key: TranslationKey }> = [
  { id: 'explain-repo', icon: SearchCode, key: 'empty.suggestion.explainRepo' },
  { id: 'fix-tests', icon: CircleX, key: 'empty.suggestion.fixTests' },
  { id: 'review-changes', icon: Eye, key: 'empty.suggestion.reviewChanges' },
  { id: 'new-feature', icon: Hammer, key: 'empty.suggestion.newFeature' },
]

type Translate = ReturnType<typeof useTranslation>

export type NewSessionStarterProps = {
  /**
   * The project the new session will run in — a project root or work dir.
   * Recent sessions are drawn from it; null lists recent sessions anywhere.
   */
  projectPath: string | null | undefined
  /** Shown beside the recent-sessions heading. */
  projectLabel?: string | null
  /** The draft session on screen, which must not list itself as "recent". */
  excludeSessionId?: string | null
  /** Puts a suggestion's text into the composer; the caller owns the draft. */
  onSuggestion: (text: string) => void
}

/**
 * What sits under the composer on a blank session (「素」, su-12): a row of
 * starter prompts and the last few sessions in the same project, so picking
 * up yesterday's thread is one click from the place a new one starts.
 */
export function NewSessionStarter({
  projectPath,
  projectLabel,
  excludeSessionId,
  onSuggestion,
}: NewSessionStarterProps) {
  const t = useTranslation()
  const sessions = useSessionStore((s) => s.sessions)
  const recentTitleId = useId()

  const recent = useMemo(
    () => pickRecentSessions(sessions, projectPath ?? null, excludeSessionId ?? null),
    [excludeSessionId, projectPath, sessions],
  )

  const openSession = (session: SessionListItem) => {
    useSessionStore.getState().openHistoricalSession(session)
    useChatStore.getState().connectToSession(session.id)
  }

  return (
    <div data-testid="new-session-starter" className="flex w-full flex-col items-center">
      <div
        role="group"
        aria-label={t('empty.suggestions')}
        className="flex flex-wrap justify-center gap-2"
      >
        {SUGGESTIONS.map(({ id, icon: Icon, key }) => (
          <Button
            key={id}
            variant="secondary"
            size="base"
            icon={<Icon size={14} strokeWidth={1.75} className="text-[var(--color-text-tertiary)]" aria-hidden="true" />}
            onClick={() => onSuggestion(t(key))}
          >
            {t(key)}
          </Button>
        ))}
      </div>

      {recent.length > 0 && (
        <section
          aria-labelledby={recentTitleId}
          className="mt-12 w-full max-w-[720px]"
        >
          <h2 className="flex items-baseline gap-2 px-2.5 pb-1.5 text-[12px] font-semibold text-[var(--color-text-secondary)]">
            <span id={recentTitleId}>{t('empty.recentTitle')}</span>
            {projectLabel ? (
              <span className="min-w-0 truncate font-normal text-[var(--color-text-tertiary)]">{projectLabel}</span>
            ) : null}
          </h2>
          <ul>
            {recent.map((session) => (
              <li key={session.id}>
                <button
                  type="button"
                  onClick={() => openSession(session)}
                  title={session.title || t('session.untitled')}
                  className="flex h-9 w-full items-center gap-2.5 rounded-[var(--radius-sm)] px-2.5 text-left text-[13px] text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
                >
                  <MessageSquare size={14} strokeWidth={1.75} className="shrink-0 text-[var(--color-text-tertiary)]" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{session.title || t('session.untitled')}</span>
                  <span className="shrink-0 text-[12px] tabular-nums text-[var(--color-text-tertiary)]">
                    {formatRelativeTime(session.modifiedAt, t)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

/**
 * Sessions that belong to `projectPath` — by project key, or by a work dir
 * inside it — newest first. Empty sessions (no messages) are left out: they
 * are other blank drafts, not threads worth returning to.
 */
export function pickRecentSessions(
  sessions: SessionListItem[],
  projectPath: string | null,
  excludeSessionId: string | null,
  limit = RECENT_LIMIT,
): SessionListItem[] {
  const target = projectPath?.trim() ? projectPath : null
  // Equality through `isSameOrChildPath` both ways, so the macOS `/private`
  // spelling of a temp path still matches the one the shell used.
  const samePlace = (a: string, b: string) => isSameOrChildPath(a, b) && isSameOrChildPath(b, a)
  const inProject = (session: SessionListItem) => {
    if (!target) return true
    if (samePlace(getSessionProjectKey(session), target)) return true
    return session.workDir ? samePlace(session.workDir, target) : false
  }
  return sessions
    .filter((session) => session.id !== excludeSessionId && session.messageCount > 0 && inProject(session))
    .sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : a.modifiedAt > b.modifiedAt ? -1 : 0))
    .slice(0, limit)
}

function formatRelativeTime(dateStr: string, t: Translate): string {
  const date = new Date(dateStr)
  const timestamp = date.getTime()
  if (!Number.isFinite(timestamp)) return ''
  const min = Math.floor((Date.now() - timestamp) / 60000)
  if (min < 1) return t('session.timeJustNow')
  if (min < 60) return t('session.timeMinutes', { n: min })
  const hr = Math.floor(min / 60)
  if (hr < 24) return t('session.timeHours', { n: hr })
  const day = Math.floor(hr / 24)
  if (day < 30) return t('session.timeDays', { n: day })
  return new Intl.DateTimeFormat(undefined, { month: 'numeric', day: 'numeric' }).format(date)
}
