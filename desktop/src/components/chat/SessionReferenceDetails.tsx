import type { SessionCandidate } from '@/api/sessionCollaboration'
import { StatusDot, type Tone } from '@/components/ui/Badge'
import { useTranslation, type TranslationKey } from '@/i18n'
import { formatExactMessageTimestamp, formatMessageTimestamp } from '@/lib/formatMessageTimestamp'
import { useSettingsStore } from '@/stores/settingsStore'

const states: Record<string, { label: TranslationKey, tone: Tone }> = {
  running: { label: 'chat.collaborationRunning', tone: 'success' },
  blocked: { label: 'chat.collaborationBlocked', tone: 'warning' },
  queued: { label: 'chat.collaborationQueued', tone: 'neutral' },
  stopped: { label: 'chat.collaborationStopped', tone: 'neutral' },
  failed: { label: 'chat.collaborationFailed', tone: 'danger' },
}

/** Keep stable identity visible even when titles and project directories coincide. */
export function SessionReferenceDetails({ session, shortId }: { session: SessionCandidate, shortId: string }) {
  const t = useTranslation()
  const locale = useSettingsStore(state => state.locale)
  const state = states[session.status]
  const time = formatMessageTimestamp(session.updatedAt, t, locale)
  const project = session.cwd.replace(/\\/g, '/').replace(/\/$/, '').split('/').filter(Boolean).slice(-2).join('/') || t('chat.sessionNoProject')
  return <>
    <span className="min-w-0 flex-1 truncate" title={session.cwd || project}>
      <span aria-hidden="true">{project}</span><span className="sr-only">{session.cwd || project}</span>
    </span>
    {state ? <span className="inline-flex shrink-0 items-center gap-1" title={t(state.label)}><StatusDot tone={state.tone} /><span>{t(state.label)}</span></span> : null}
    {time ? <time dateTime={session.updatedAt} title={formatExactMessageTimestamp(session.updatedAt, locale)} className="hidden shrink-0 tabular-nums sm:inline">{time}</time> : null}
    <span title={session.sessionId} className="max-w-[35%] shrink-0 truncate font-mono tabular-nums">{shortId}</span>
  </>
}
