import * as fs from 'node:fs'
import * as path from 'node:path'
import type { AdapterHttpClient, RecentProject, SessionListItem } from './http-client.js'
import { t } from './i18n.js'
import type { SessionStore } from './session-store.js'
import type { ServerMessage, WsBridge } from './ws-bridge.js'

export type SessionRestoreDeps = {
  httpClient: Pick<AdapterHttpClient, 'sessionExists'>
  bridge: Pick<WsBridge, 'resetSession' | 'connectSession' | 'onServerMessage' | 'waitForOpen'>
  sessionStore: Pick<SessionStore, 'get' | 'set' | 'delete'>
  onServerMessage: (chatId: string, message: ServerMessage) => void | Promise<void>
  clearTransientState: (chatId: string) => void
  isBusy?: (chatId: string) => boolean
}

export type SessionSelectionDeps = SessionRestoreDeps & {
  httpClient: Pick<AdapterHttpClient, 'sessionExists' | 'listRecentProjects' | 'matchProject' | 'listSessions'>
  sendNotice: (chatId: string, text: string) => Promise<void>
  clearProjectSelection: (chatId: string) => void
  now?: () => number
}

/** Attaching an IM is a binding change, never a new transcript or a prompt. */
export async function restoreSelectedSession(
  deps: SessionRestoreDeps,
  chatId: string,
  session: Pick<SessionListItem, 'id' | 'workDir' | 'title'>,
): Promise<{ ok: boolean; message: string }> {
  const busy = () => deps.isBusy?.(chatId) ?? false
  if (busy()) return { ok: false, message: t('selection.busyPermission') }
  try {
    if (!session.workDir || !await deps.httpClient.sessionExists(session.id)) {
      return { ok: false, message: t('selection.gone') }
    }
  } catch (err) {
    return { ok: false, message: t('selection.checkFailed', { error: err instanceof Error ? err.message : String(err) }) }
  }
  // A server event may have started a turn while the preflight was in flight.
  if (busy()) return { ok: false, message: t('selection.busy') }

  const previous = deps.sessionStore.get(chatId)
  const buffered: ServerMessage[] = []
  deps.bridge.resetSession(chatId)
  try {
    deps.bridge.connectSession(chatId, session.id)
    deps.bridge.onServerMessage(chatId, (message) => { buffered.push(message) })
    if (!await deps.bridge.waitForOpen(chatId)) throw new Error(t('server.connectTimeout'))
    deps.sessionStore.set(chatId, session.id, session.workDir)
  } catch (err) {
    deps.bridge.resetSession(chatId)
    if (previous) {
      try {
        deps.bridge.connectSession(chatId, previous.sessionId)
        deps.bridge.onServerMessage(chatId, (message) => deps.onServerMessage(chatId, message))
      } catch {
        // The persisted binding is still intact; normal message recovery retries.
      }
    }
    return { ok: false, message: t('selection.restoreFailed', { error: err instanceof Error ? err.message : String(err) }) }
  }
  deps.clearTransientState(chatId)
  deps.bridge.onServerMessage(chatId, (message) => deps.onServerMessage(chatId, message))
  for (const message of buffered) {
    try {
      await deps.onServerMessage(chatId, message)
    } catch (err) {
      console.warn('[SessionSelection] Failed to present restored state:', err)
    }
  }
  return {
    ok: true,
    message: t('selection.restored', {
      title: oneLine(session.title || t('selection.untitled'), 80),
      workDir: session.workDir,
      id: session.id,
    }),
  }
}

const PAGE_SIZE = 8
const FETCH_SIZE = 100
export const SESSION_SELECTION_TTL_MS = 15 * 60 * 1000
type Picker = {
  expiresAt: number
  page: number
} & (
  | { kind: 'projects'; projects: RecentProject[] }
  | { kind: 'sessions'; project: string; sessions: SessionListItem[] }
)

function oneLine(value: string, length = 100): string {
  return value.replace(/[\r\n\t]+/g, ' ').slice(0, length)
}

function canonicalPath(value: string): string {
  try {
    return fs.realpathSync(value)
  } catch {
    return path.resolve(value)
  }
}

/** The API's project filter addresses one transcript directory, while recent
 * projects group worktrees. Filter logical roots after reading all summary pages. */
export async function listProjectSessionHistory(
  httpClient: Pick<AdapterHttpClient, 'listSessions'>,
  project: string,
  all?: SessionListItem[],
): Promise<SessionListItem[]> {
  const root = canonicalPath(project)
  return (all ?? await loadSessionHistory(httpClient)).filter((session) =>
    session.workDir && session.workDirExists !== false && (
      canonicalPath(session.projectRoot || session.workDir) === root || canonicalPath(session.workDir) === root
    ),
  ).sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.id.localeCompare(b.id))
}

async function loadSessionHistory(httpClient: Pick<AdapterHttpClient, 'listSessions'>): Promise<SessionListItem[]> {
  const sessions = new Map<string, SessionListItem>()
  let offset = 0
  let total: number
  do {
    const result = await httpClient.listSessions({ limit: FETCH_SIZE, offset })
    for (const session of result.sessions) sessions.set(session.id, session)
    total = result.total
    offset += FETCH_SIZE
  } while (offset < total)
  return [...sessions.values()]
}

/** Text-first picker shared by every IM, with a stable, chat-local snapshot. */
export class SessionSelectionController {
  private readonly pickers = new Map<string, Picker>()
  private readonly now: () => number

  constructor(private readonly deps: SessionSelectionDeps) {
    this.now = deps.now ?? Date.now
  }

  clear(chatId: string): void {
    this.pickers.delete(chatId)
  }

  async handleInput(chatId: string, input: string): Promise<boolean> {
    const text = input.trim()
    const list = /^(?:\/sessions|会话列表)(?:\s+(.*))?$/.exec(text)
    const resume = /^(?:\/resume|继续会话)(?:\s+(.*))?$/.exec(text)
    const cancel = text === '/cancel' || text === '取消选择'
    const picker = this.pickers.get(chatId)
    const numberReply = /^\d+$/.test(text) && Boolean(picker)
    if (!list && !resume && !cancel && !numberReply) {
      // Normal chat is never a fuzzy session query. Other commands (especially
      // permission approval) retain their original routing and pending picker.
      if (text && !text.startsWith('/') && !['帮助', '状态', '停止', '清空', 'trợ giúp', 'trạng thái', 'dừng', 'xóa'].includes(text)) this.clear(chatId)
      return false
    }

    try {
      if (cancel) {
        this.clear(chatId)
        this.deps.clearProjectSelection(chatId)
        await this.deps.sendNotice(chatId, t('selection.cancelled'))
      } else if (list && ['next', 'prev'].includes(list[1] ?? '')) {
        const active = await this.requirePicker(chatId, picker)
        if (!active) return true
        const count = active.kind === 'projects' ? active.projects.length : active.sessions.length
        const nextPage = active.page + (list[1] === 'next' ? 1 : -1)
        active.page = Math.max(0, Math.min(Math.ceil(count / PAGE_SIZE) - 1, nextPage))
        await this.show(chatId, active)
      } else if (list || (resume && !resume[1])) {
        this.clear(chatId)
        this.deps.clearProjectSelection(chatId)
        await this.open(chatId, list?.[1])
      } else {
        const active = await this.requirePicker(chatId, picker)
        if (!active) return true
        await this.select(chatId, active, resume?.[1] ?? text)
      }
    } catch (err) {
      await this.deps.sendNotice(chatId, t('selection.restoreError', { error: err instanceof Error ? err.message : String(err) }))
    }
    return true
  }

  private async requirePicker(chatId: string, picker: Picker | undefined): Promise<Picker | null> {
    if (picker && picker.expiresAt > this.now()) return picker
    this.clear(chatId)
    await this.deps.sendNotice(chatId, t('selection.expired'))
    return null
  }

  private async open(chatId: string, query?: string): Promise<void> {
    if (query === 'projects') return this.openProjects(chatId, await this.deps.httpClient.listRecentProjects())
    if (query) {
      const { project, ambiguous } = await this.deps.httpClient.matchProject(query)
      if (project) return this.openProject(chatId, project.realPath)
      if (ambiguous?.length) return this.openProjects(chatId, ambiguous)
      await this.deps.sendNotice(chatId, t('selection.projectNotFound', { query: oneLine(query) }))
      return
    }
    const current = this.deps.sessionStore.get(chatId)
    if (current) {
      // Recent projects collapse worktrees into their root. Find the stored
      // session's logical root before choosing the default history list.
      const sessions = await loadSessionHistory(this.deps.httpClient)
      const active = sessions.find((session) => session.id === current.sessionId)
      return this.openProject(chatId, active?.projectRoot || current.workDir, sessions)
    }
    await this.openProjects(chatId, await this.deps.httpClient.listRecentProjects())
  }

  private async openProjects(chatId: string, projects: RecentProject[]): Promise<void> {
    if (!projects.length) {
      await this.deps.sendNotice(chatId, t('selection.noProjects'))
      return
    }
    const picker: Picker = { kind: 'projects', projects, page: 0, expiresAt: this.now() + SESSION_SELECTION_TTL_MS }
    this.pickers.set(chatId, picker)
    await this.show(chatId, picker)
  }

  private async openProject(chatId: string, project: string, all?: SessionListItem[]): Promise<void> {
    const sessions = await listProjectSessionHistory(this.deps.httpClient, project, all)
    if (!sessions.length) {
      this.clear(chatId)
      await this.deps.sendNotice(chatId, t('selection.projectNoSessions', { project }))
      return
    }
    const picker: Picker = { kind: 'sessions', project, sessions, page: 0, expiresAt: this.now() + SESSION_SELECTION_TTL_MS }
    this.pickers.set(chatId, picker)
    await this.show(chatId, picker)
  }

  private async select(chatId: string, picker: Picker, query: string): Promise<void> {
    const index = /^\d+$/.test(query) ? Number(query) - 1 : -1
    const start = picker.page * PAGE_SIZE
    const visible = index >= start && index < start + PAGE_SIZE
    if (picker.kind === 'projects') {
      const project = visible ? picker.projects[index] : undefined
      if (project) return this.openProject(chatId, project.realPath)
    } else {
      const session = visible ? picker.sessions[index] : undefined
      if (session) {
        const result = await restoreSelectedSession(this.deps, chatId, session)
        if (result.ok) this.clear(chatId)
        await this.deps.sendNotice(chatId, result.message)
        return
      }
    }
    await this.deps.sendNotice(chatId, t('selection.invalidNumber'))
  }

  private async show(chatId: string, picker: Picker): Promise<void> {
    const start = picker.page * PAGE_SIZE
    const currentId = this.deps.sessionStore.get(chatId)?.sessionId
    const items = picker.kind === 'projects' ? picker.projects : picker.sessions
    const lines = picker.kind === 'projects'
      ? picker.projects.slice(start, start + PAGE_SIZE).map((project, i) => `${start + i + 1}. ${oneLine(project.projectName, 60)}\n${oneLine(project.realPath, 180)}`)
      : picker.sessions.slice(start, start + PAGE_SIZE).map((session, i) => `${start + i + 1}. ${oneLine(session.title || t('selection.untitled'), 60)}${session.id === currentId ? t('selection.current') : ''}\n${session.modifiedAt.slice(0, 16).replace('T', ' ')} · ${t('selection.messageCount', { count: session.messageCount })} · ${session.id.slice(0, 8)}`)
    await this.deps.sendNotice(chatId, [
      picker.kind === 'projects' ? t('selection.pickerProjects') : t('selection.pickerSessions', { project: picker.project }),
      t('selection.page', { page: picker.page + 1, total: Math.ceil(items.length / PAGE_SIZE) }),
      '', ...lines, '',
      picker.kind === 'projects' ? t('selection.projectsHint') : t('selection.sessionsHint'),
      t('selection.paging'),
      t('selection.footer'),
    ].join('\n'))
  }
}
