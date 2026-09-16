import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { SessionSelectionController, SESSION_SELECTION_TTL_MS, listProjectSessionHistory } from '../session-selection.js'
import type { RecentProject, SessionListItem } from '../http-client.js'
import { SessionStore } from '../session-store.js'
import type { ServerMessage } from '../ws-bridge.js'

let tmp: string
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'im-session-picker-')) })
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

function session(id: string, workDir: string, extra: Partial<SessionListItem> = {}): SessionListItem {
  return { id, title: `历史 ${id}`, createdAt: '2026-08-01', modifiedAt: '2026-08-31', messageCount: 3, projectPath: 'encoded', workDir, workDirExists: true, ...extra }
}

function project(name: string, realPath: string): RecentProject {
  return { projectName: name, realPath, projectPath: realPath, isGit: true, repoName: name, branch: 'main', modifiedAt: '2026-08-31', sessionCount: 3 }
}

function harness() {
  const store = new SessionStore(path.join(tmp, 'sessions.json'))
  store.set('chat', 'current', tmp)
  const notices: string[] = []
  const connections: string[] = []
  const resets: string[] = []
  const events: ServerMessage[] = []
  const fetches: number[] = []
  const state = {
    sessions: [session('old', tmp)], projects: [project('demo', tmp)],
    exists: true, open: true, busy: false, now: 0, clears: 0, projectClears: 0,
    preflightError: false, fetchError: false, busyDuringPreflight: false,
    handler: undefined as ((message: ServerMessage) => void) | undefined,
  }
  const controller = new SessionSelectionController({
    sessionStore: store,
    httpClient: {
      async listSessions(options) {
        if (state.fetchError) throw new Error('offline')
        const offset = options?.offset ?? 0
        fetches.push(offset)
        return { sessions: state.sessions.slice(offset, offset + (options?.limit ?? 20)), total: state.sessions.length }
      },
      async listRecentProjects() { return state.projects },
      async matchProject(query) {
        const matches = state.projects.filter((p) => p.projectName === query || p.realPath === query)
        return matches.length === 1 ? { project: matches[0] } : matches.length ? { ambiguous: matches } : {}
      },
      async sessionExists() {
        if (state.preflightError) throw new Error('offline')
        if (state.busyDuringPreflight) state.busy = true
        return state.exists
      },
    },
    bridge: {
      resetSession(chatId) { resets.push(chatId) },
      connectSession(_chatId, id) { connections.push(id); return true },
      onServerMessage(_chatId, handler) { state.handler = handler },
      async waitForOpen() { state.handler?.({ type: 'status', marker: 'restored' }); return state.open },
    },
    async sendNotice(_chatId, text) { notices.push(text) },
    onServerMessage(_chatId, message) { events.push(message) },
    clearTransientState() { state.clears++ },
    clearProjectSelection() { state.projectClears++ },
    isBusy() { return state.busy },
    now: () => state.now,
  })
  return { controller, store, notices, connections, resets, events, fetches, state }
}

describe('IM history selection (#1286)', () => {
  it('lists current project history without touching its binding, then persists the selected original ID', async () => {
    const h = harness()
    await h.controller.handleInput('chat', '/sessions')
    expect(h.notices.at(-1)).toContain('历史 old')
    expect(h.store.get('chat')?.sessionId).toBe('current')
    expect(h.resets).toEqual([])
    await h.controller.handleInput('chat', '/resume 1')
    expect(h.connections).toEqual(['old'])
    expect(h.state.clears).toBe(1)
    expect(h.events).toEqual([{ type: 'status', marker: 'restored' }])
    expect(new SessionStore(path.join(tmp, 'sessions.json')).get('chat')?.sessionId).toBe('old')
    expect(h.notices.at(-1)).toContain('可以继续发送消息')
  })

  it('starts with a project picker when no binding survives an upgrade', async () => {
    const h = harness()
    h.store.delete('chat')
    await h.controller.handleInput('chat', '/sessions')
    expect(h.notices.at(-1)).toContain('历史会话所在的项目')
    await h.controller.handleInput('chat', '1')
    expect(h.notices.at(-1)).toContain('历史 old')
    await h.controller.handleInput('chat', '1')
    expect(h.store.get('chat')?.sessionId).toBe('old')
  })

  it('includes old desktop worktree sessions under their logical project, across server pages', async () => {
    const h = harness()
    h.state.sessions = Array.from({ length: 100 }, (_, i) => session(`other-${i}`, '/another'))
    h.state.sessions.push(session('worktree-old', path.join(tmp, 'worktrees', 'old'), { projectRoot: tmp }))
    await h.controller.handleInput('chat', '/sessions demo')
    expect(h.fetches).toEqual([0, 100])
    expect(h.notices.at(-1)).toContain('worktree-old')
    expect(h.notices.at(-1)).not.toContain('other-')
    await h.controller.handleInput('chat', '/resume 1')
    expect(h.store.get('chat')?.workDir).toBe(path.join(tmp, 'worktrees', 'old'))
  })

  it('uses the active worktree logical root for /sessions and identifies the active session', async () => {
    const h = harness()
    const worktree = path.join(tmp, 'worktrees', 'active')
    h.store.set('chat', 'current', worktree)
    h.state.sessions.push(session('current', worktree, { projectRoot: tmp }))
    await h.controller.handleInput('chat', '会话列表')
    expect(h.notices.at(-1)).toContain('历史 current（当前）')
    expect(h.notices.at(-1)).toContain('历史 old')
  })

  it('accepts an exact worktree directory as well as its logical project root', async () => {
    const worktree = path.join(tmp, 'worktrees', 'active')
    const all = [session('main', tmp), session('branch', worktree, { projectRoot: tmp })]
    const client = { async listSessions() { return { sessions: all, total: all.length } } }
    expect((await listProjectSessionHistory(client, worktree)).map((s) => s.id)).toEqual(['branch'])
    expect((await listProjectSessionHistory(client, tmp)).map((s) => s.id)).toEqual(['branch', 'main'])
  })

  it('keeps numbered options stable when the server order changes and pages beyond the first eight', async () => {
    const h = harness()
    h.state.sessions = Array.from({ length: 12 }, (_, i) => session(`id-${String(i).padStart(2, '0')}`, tmp))
    await h.controller.handleInput('chat', '/sessions')
    h.state.sessions.reverse()
    await h.controller.handleInput('chat', '/sessions next')
    expect(h.notices.at(-1)).toContain('9. 历史 id-08')
    await h.controller.handleInput('chat', '/resume 1')
    expect(h.notices.at(-1)).toContain('编号无效')
    await h.controller.handleInput('chat', '/resume 9')
    expect(h.store.get('chat')?.sessionId).toBe('id-08')
  })

  it('lets a bound chat select a different project without creating a new session', async () => {
    const h = harness()
    h.state.projects = [project('demo', tmp), project('demo', path.join(tmp, 'other'))]
    h.state.sessions.push(session('second', path.join(tmp, 'other')))
    await h.controller.handleInput('chat', '/sessions demo')
    expect(h.notices.at(-1)).toContain('2. demo')
    await h.controller.handleInput('chat', '2')
    await h.controller.handleInput('chat', '1')
    expect(h.store.get('chat')?.sessionId).toBe('second')
    await h.controller.handleInput('chat', '/sessions projects')
    expect(h.notices.at(-1)).toContain('历史会话所在的项目')
  })

  for (const fault of ['exists', 'open', 'busy', 'preflightError', 'busyDuringPreflight'] as const) {
    it(`preserves the previous binding on ${fault} failure`, async () => {
      const h = harness()
      await h.controller.handleInput('chat', '/sessions')
      h.state[fault] = !['exists', 'open'].includes(fault)
      await h.controller.handleInput('chat', '/resume 1')
      expect(h.store.get('chat')?.sessionId).toBe('current')
      expect(h.state.clears).toBe(0)
      expect(h.events).toEqual([])
      expect(h.connections).toEqual(fault === 'open' ? ['old', 'current'] : [])
      expect(h.notices.at(-1)).not.toContain('已恢复会话')
    })
  }

  it('does not create a binding when the first attempted connection fails', async () => {
    const h = harness()
    h.store.delete('chat')
    await h.controller.handleInput('chat', '/sessions demo')
    h.state.open = false
    await h.controller.handleInput('chat', '/resume 1')
    expect(h.store.get('chat')).toBeNull()
    expect(h.resets).toHaveLength(2)
  })

  it('does not consume ordinary chat, permission commands, or another chat numeric replies', async () => {
    const h = harness()
    await h.controller.handleInput('chat', '/sessions')
    expect(await h.controller.handleInput('other', '1')).toBe(false)
    expect(await h.controller.handleInput('chat', '/allow request')).toBe(false)
    expect(await h.controller.handleInput('chat', '继续修复刚才的代码')).toBe(false)
    await h.controller.handleInput('chat', '/resume 1')
    expect(h.notices.at(-1)).toContain('不存在或已过期')
    expect(h.connections).toEqual([])
  })

  it('rejects expired selection and lets users explicitly cancel', async () => {
    const h = harness()
    await h.controller.handleInput('chat', '/sessions')
    h.state.now += SESSION_SELECTION_TTL_MS
    expect(await h.controller.handleInput('chat', '1')).toBe(true)
    expect(h.notices.at(-1)).toContain('已过期')
    await h.controller.handleInput('chat', '/sessions')
    await h.controller.handleInput('chat', '/cancel')
    expect(h.notices.at(-1)).toContain('当前会话未改变')
    expect(await h.controller.handleInput('chat', '1')).toBe(false)
    expect(h.connections).toEqual([])
  })

  it('reports missing projects, empty history, and HTTP errors without losing the active session', async () => {
    const h = harness()
    await h.controller.handleInput('chat', '/sessions unknown')
    expect(h.notices.at(-1)).toContain('未找到项目')
    h.state.sessions = [session('gone', tmp, { workDirExists: false })]
    await h.controller.handleInput('chat', '/sessions')
    expect(h.notices.at(-1)).toContain('没有可恢复会话')
    h.state.fetchError = true
    await h.controller.handleInput('chat', '/sessions')
    expect(h.notices.at(-1)).toContain('offline')
    expect(h.store.get('chat')?.sessionId).toBe('current')
    expect(h.resets).toEqual([])
  })
})
