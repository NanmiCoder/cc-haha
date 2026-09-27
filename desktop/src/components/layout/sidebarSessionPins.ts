import type { MessageEntry, SessionListItem } from '../../types/session'

/**
 * Session-level pinning and archiving.
 *
 * Project pinning lives in the sidebar's own preferences; these two sets are
 * deliberately local-only UI state. They never leave the renderer, never reach
 * the server, and never change what a session *is* — a pinned session is still
 * the same transcript in the same project, it just gets surfaced twice: once at
 * the top of the list under its own heading, and once in place under its project.
 */
export const SESSION_PINNED_STORAGE_KEY = 'cc-haha-sidebar-pinned-sessions'
export const SESSION_ARCHIVED_STORAGE_KEY = 'cc-haha-sidebar-archived-sessions'

/** Synthetic group keys. They are not real project keys and are not draggable. */
export const PINNED_SESSIONS_GROUP_KEY = '__cc_haha_pinned_sessions__'
export const ARCHIVED_SESSIONS_GROUP_KEY = '__cc_haha_archived_sessions__'

export type SidebarSessionGroup = {
  key: string
  title: string
  subtitle: string | null
  workDir: string | undefined
  sessions: SessionListItem[]
}

export type SidebarSessionGroupLabels = {
  pinned: string
  archived: string
}

function readStoredSessionIds(storageKey: string): Set<string> {
  if (typeof localStorage === 'undefined') return new Set()
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey) ?? '[]')
    return new Set(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [])
  } catch {
    return new Set()
  }
}

function writeStoredSessionIds(storageKey: string, sessionIds: Set<string>): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(storageKey, JSON.stringify([...sessionIds]))
  } catch {
    // Pinning and archiving are UI preferences; ignore storage failures.
  }
}

export function readStoredSessionPins(): Set<string> {
  return readStoredSessionIds(SESSION_PINNED_STORAGE_KEY)
}

export function writeStoredSessionPins(sessionIds: Set<string>): void {
  writeStoredSessionIds(SESSION_PINNED_STORAGE_KEY, sessionIds)
}

export function readStoredArchivedSessions(): Set<string> {
  return readStoredSessionIds(SESSION_ARCHIVED_STORAGE_KEY)
}

export function writeStoredArchivedSessions(sessionIds: Set<string>): void {
  writeStoredSessionIds(SESSION_ARCHIVED_STORAGE_KEY, sessionIds)
}

export function isSyntheticSessionGroupKey(key: string): boolean {
  return key === PINNED_SESSIONS_GROUP_KEY || key === ARCHIVED_SESSIONS_GROUP_KEY
}

export function toggleIdInSet(set: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(set)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

/**
 * Re-shape the project groups so pinned and archived sessions also appear under
 * their own headings.
 *
 * A pinned session is *moved* out of its project into the leading group, and an
 * archived session out of its project into the trailing one. Both are moved
 * rather than duplicated so a project never renders the same row twice, which
 * would give the row two independent context menus for one identity.
 *
 * Pinning wins when a session is somehow in both sets: the leading group is the
 * one the user asked to see first.
 */
export function groupPinnedAndArchivedSessions(
  groups: SidebarSessionGroup[],
  pinnedSessionIds: ReadonlySet<string>,
  archivedSessionIds: ReadonlySet<string>,
  labels: SidebarSessionGroupLabels,
): SidebarSessionGroup[] {
  if (pinnedSessionIds.size === 0 && archivedSessionIds.size === 0) return groups

  const pinnedSessions: SessionListItem[] = []
  const archivedSessions: SessionListItem[] = []
  const remainingGroups: SidebarSessionGroup[] = []

  for (const group of groups) {
    const keptSessions: SessionListItem[] = []
    for (const session of group.sessions) {
      if (pinnedSessionIds.has(session.id)) {
        pinnedSessions.push(session)
      } else if (archivedSessionIds.has(session.id)) {
        archivedSessions.push(session)
      } else {
        keptSessions.push(session)
      }
    }
    if (keptSessions.length > 0) remainingGroups.push({ ...group, sessions: keptSessions })
  }

  return [
    ...(pinnedSessions.length > 0
      ? [{
        key: PINNED_SESSIONS_GROUP_KEY,
        title: labels.pinned,
        subtitle: null,
        workDir: undefined,
        sessions: pinnedSessions,
      }]
      : []),
    ...remainingGroups,
    ...(archivedSessions.length > 0
      ? [{
        key: ARCHIVED_SESSIONS_GROUP_KEY,
        title: labels.archived,
        subtitle: null,
        workDir: undefined,
        sessions: archivedSessions,
      }]
      : []),
  ]
}

function renderMessageContent(content: unknown): string {
  if (content === null || content === undefined) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map(renderMessageContent).filter(Boolean).join('\n\n')
  }
  if (typeof content === 'object') {
    const record = content as Record<string, unknown>
    if (typeof record.text === 'string') return record.text
    if (record.content !== undefined) return renderMessageContent(record.content)
    try {
      return `\`\`\`json\n${JSON.stringify(content, null, 2)}\n\`\`\``
    } catch {
      return String(content)
    }
  }
  return String(content)
}

export function sessionMarkdownFileName(title: string, sessionId: string): string {
  const safeTitle = title.replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 80) || 'session'
  return `${safeTitle}-${sessionId}.md`
}

export type SessionTranscriptMetadata = {
  projectPath?: string | null
  sessionFilePath?: string | null
  exportedAt?: string
}

/**
 * Render one session as Markdown.
 *
 * `messages` comes from the server's assembled history, so this stays a pure
 * formatting function and can be unit-tested without a host.
 */
export function buildSessionTranscriptMarkdown(
  session: Pick<SessionListItem, 'id' | 'title'>,
  messages: MessageEntry[],
  metadata: SessionTranscriptMetadata = {},
): string {
  const title = session.title || 'Untitled'
  const lines = [
    `# ${title}`,
    '',
    `- Session ID: ${session.id}`,
    `- Project Path: ${metadata.projectPath ?? ''}`,
    `- Session Path: ${metadata.sessionFilePath ?? ''}`,
    `- Exported: ${metadata.exportedAt ?? ''}`,
  ]

  for (const message of messages) {
    const role = message.type || 'message'
    const timestamp = message.timestamp ? ` - ${message.timestamp}` : ''
    const body = renderMessageContent(message.content)
    lines.push('', `## ${role}${timestamp}`, '', body)
  }

  return `${lines.join('\n')}\n`
}
