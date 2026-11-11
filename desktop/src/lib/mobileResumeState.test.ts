import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installMobileResumeState, MOBILE_CAPTURE_EVENT, MOBILE_RESTORE_EVENT, parseMobileResumeSnapshot } from './mobileResumeState'

const mocks = vi.hoisted(() => ({
  remote: true,
  tab: { activeTabId: 'chat-a' as string | null, tabs: [{ sessionId: 'chat-a', type: 'session' }] },
  sessions: {} as Record<string, { composerDraft?: { input: string, attachments: unknown[] } }>,
  getSummary: vi.fn(), open: vi.fn(), connect: vi.fn(), setDraft: vi.fn(),
}))
vi.mock('./publicAccessRuntime', () => ({ isPublicAccessRuntime: () => mocks.remote }))
vi.mock('@/api/sessions', () => ({ sessionsApi: { getSummary: mocks.getSummary } }))
vi.mock('@/stores/tabStore', () => ({ useTabStore: { getState: () => mocks.tab } }))
vi.mock('@/stores/sessionStore', () => ({ useSessionStore: { getState: () => ({ openHistoricalSession: mocks.open }) } }))
vi.mock('@/stores/chatStore', () => ({ useChatStore: { getState: () => ({ sessions: mocks.sessions, setComposerDraft: mocks.setDraft, connectToSession: mocks.connect }) } }))
let cleanup: (() => void) | undefined
const snapshot = { version: 1, sessionId: 'chat-a', drafts: [{ sessionId: 'chat-a', text: 'unsent text' }] }
const settle = async () => {
  await Promise.resolve()
  await Promise.resolve()
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.remote = true
  mocks.tab = { activeTabId: 'chat-a', tabs: [{ sessionId: 'chat-a', type: 'session' }] }
  mocks.sessions = {}
  mocks.getSummary.mockResolvedValue({ id: 'chat-a', title: 'My chat' })
})
afterEach(() => {
  cleanup?.()
  delete window.__ccHahaMobileState
})

describe('native mobile UI handoff', () => {
  it('flushes live text and exports no attachments, cookies or store fields', () => {
    mocks.sessions = { 'chat-a': { composerDraft: { input: 'old', attachments: [{ path: '/private/file' }] } } }
    const flush = () => { mocks.sessions['chat-a']!.composerDraft!.input = 'latest unsent text' }
    window.addEventListener(MOBILE_CAPTURE_EVENT, flush)
    cleanup = installMobileResumeState()
    expect(window.__ccHahaMobileState!.capture()).toEqual({ version: 1, sessionId: 'chat-a', drafts: [{ sessionId: 'chat-a', text: 'latest unsent text' }] })
    window.removeEventListener(MOBILE_CAPTURE_EVENT, flush)
  })

  it('validates the snapshot version, UTF-8 byte budget, session IDs and duplicates', () => {
    expect(parseMobileResumeSnapshot({ ...snapshot, cookie: 'ignored', drafts: [{ ...snapshot.drafts[0], command: 'never execute' }] })).toEqual(snapshot)
    for (const value of [null, {}, { ...snapshot, version: 2 }, { ...snapshot, sessionId: '../secret' },
      { ...snapshot, drafts: Array(6).fill(snapshot.drafts[0]) },
      { ...snapshot, drafts: [...snapshot.drafts, ...snapshot.drafts] },
      { ...snapshot, drafts: [{ sessionId: 'chat-a', text: '中'.repeat(5462) }] },
    ]) expect(parseMobileResumeSnapshot(value)).toBeNull()
  })

  it('restores selection and text once, without sending a message or replacing newer text', async () => {
    mocks.sessions = { 'chat-b': { composerDraft: { input: 'typed now', attachments: [] } } }
    const restored = vi.fn()
    window.addEventListener(MOBILE_RESTORE_EVENT, restored)
    cleanup = installMobileResumeState()
    expect(window.__ccHahaMobileState!.restore({ ...snapshot, drafts: [...snapshot.drafts, { sessionId: 'chat-b', text: 'stale' }] })).toBe(true)
    expect(window.__ccHahaMobileState!.capture()).toBeNull()
    await settle()
    expect(mocks.setDraft).toHaveBeenCalledTimes(1)
    expect(mocks.setDraft).toHaveBeenCalledWith('chat-a', { input: 'unsent text', attachments: [], mentions: [] })
    expect(mocks.open).toHaveBeenCalledWith({ id: 'chat-a', title: 'My chat' })
    expect(mocks.connect).toHaveBeenCalledWith('chat-a')
    expect(restored).toHaveBeenCalledTimes(1)
    expect(window.__ccHahaMobileState!.restore(snapshot)).toBe(false)
    window.removeEventListener(MOBILE_RESTORE_EVENT, restored)
  })

  it('does not navigate after a newer user selection or mutate a disposed page', async () => {
    let resolve!: (value: unknown) => void
    mocks.getSummary.mockImplementation(() => new Promise(r => { resolve = r }))
    cleanup = installMobileResumeState()
    window.__ccHahaMobileState!.restore(snapshot)
    mocks.tab.activeTabId = 'chat-b'
    resolve({ id: 'chat-a', title: 'A' })
    await settle()
    expect(mocks.open).not.toHaveBeenCalled()
    cleanup()
    mocks.setDraft.mockClear()
    cleanup = installMobileResumeState()
    window.__ccHahaMobileState!.restore(snapshot)
    cleanup()
    resolve({ id: 'chat-a' })
    await settle()
    expect(mocks.setDraft).not.toHaveBeenCalled()
  })

  it('limits capture and does not expose the bridge in the desktop app', () => {
    mocks.sessions = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`chat-${i}`, { composerDraft: { input: 'draft', attachments: [] } }]))
    cleanup = installMobileResumeState()
    expect(window.__ccHahaMobileState!.capture()!.drafts).toHaveLength(5)
    cleanup()
    mocks.remote = false
    cleanup = installMobileResumeState()
    expect(window.__ccHahaMobileState).toBeUndefined()
  })
})
