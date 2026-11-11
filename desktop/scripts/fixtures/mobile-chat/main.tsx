import { createRoot } from 'react-dom/client'
import '../../../src/theme/globals.css'
import { setBaseUrl } from '../../../src/api/client'
import { MobileShell } from '../../../src/components/mobile/MobileShell'
import { browserHost } from '../../../src/lib/desktopHost/browserHost'
import { createDefaultSessionState, useChatStore } from '../../../src/stores/chatStore'
import { useProviderStore } from '../../../src/stores/providerStore'
import { useSessionStore } from '../../../src/stores/sessionStore'
import { useSessionRuntimeStore } from '../../../src/stores/sessionRuntimeStore'
import { useSettingsStore } from '../../../src/stores/settingsStore'
import { useUIStore } from '../../../src/stores/uiStore'
import { useTabStore } from '../../../src/stores/tabStore'
import { useTeamStore } from '../../../src/stores/teamStore'
import { useWorkspaceContentStore } from '../../../src/stores/workspaceContentStore'
import { useSessionDelegationStore } from '../../../src/stores/sessionDelegationStore'
import { DEEPSEEK_ACCOUNT_CATALOG_MODELS } from '../../../src/constants/deepseekAccountProvider'
import type { SessionListItem } from '../../../src/types/session'
import { THEME_MODES, type ThemeMode } from '../../../src/types/settings'

// Render the real phone shell, retained full-page draft, EmptySession, ActiveSession and
// both composers. Only the data/transport boundaries are replaced. There is no
// backend, provider, native bridge, filesystem access or user configuration.
const params = new URLSearchParams(location.search)
const requestedTheme = params.get('theme')
const theme = THEME_MODES.includes(requestedTheme as ThemeMode) ? requestedTheme as ThemeMode : 'white'
document.documentElement.dataset.theme = theme
history.replaceState(null, '', `/remote/mobile-chat-fixture?theme=${encodeURIComponent(theme)}`)
setBaseUrl(location.origin)
window.desktopHost = browserHost

const evidence = {
  requests: [] as string[],
  unexpected: [] as string[],
  creates: [] as unknown[],
  sends: [] as unknown[],
  runtimeUpdates: [] as unknown[],
  navigation: [] as unknown[],
  connects: [] as string[],
  disconnects: [] as string[],
}
Object.defineProperty(evidence, 'state', { enumerable: true, get: () => ({
  activeTabId: useTabStore.getState().activeTabId,
  draft: useUIStore.getState().newSessionDraft,
}) })
Object.assign(window, { mobileChatSmoke: evidence })
window.addEventListener('error', event => evidence.unexpected.push(event.message))
window.addEventListener('unhandledrejection', event => evidence.unexpected.push(String(event.reason)))
window.addEventListener('popstate', event => evidence.navigation.push({ type: 'popstate', state: event.state }))

const timestamp = new Date().toISOString()
const workDir = '/fixture/mobile-project'
const existing: SessionListItem = {
  id: 'fixture-existing', title: '继续完善手机交互', createdAt: timestamp, modifiedAt: timestamp,
  messageCount: 2, projectPath: workDir, projectRoot: workDir, workDir, workDirExists: true,
  runtimeProviderId: 'deepseek-account', runtimeModelId: 'deepseek-flash', permissionMode: 'default',
}
const accountModels = { main: 'deepseek-flash', haiku: 'deepseek-flash', sonnet: 'deepseek-v4-pro', opus: 'deepseek-v4-pro' }
const availableModels = DEEPSEEK_ACCOUNT_CATALOG_MODELS.map(model => ({ ...model, description: '', context: '1M' }))
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

// All application fetches terminate here, including accidental requests. The
// only browser network is Vite's local module/assets transport. OAuth routes
// deliberately return 403: public access must use the safe auth-status API.
window.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input), location.origin)
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
  evidence.requests.push(`${method} ${url.pathname}${url.search}`)
  if (url.origin !== location.origin) {
    evidence.unexpected.push(`External fetch blocked: ${url.href}`)
    throw new Error('External network is forbidden in this fixture')
  }
  if (url.pathname.startsWith('/api/haha-')) return json({ error: 'PUBLIC_ACCESS_ROUTE_FORBIDDEN' }, 403)
  if (url.pathname === '/api/providers') return json({ providers: [], activeId: 'deepseek-account', providerOrder: ['deepseek-account'], deepSeekAccountModels: accountModels,
    builtInProviderAvailability: { 'claude-official': false, 'openai-official': false, 'grok-official': false, 'deepseek-account': true },
  })
  if (url.pathname === '/api/providers/auth-status') {
    const id = url.searchParams.get('providerId') ?? 'deepseek-account'
    return json({ hasAuth: id === 'deepseek-account', source: id === 'deepseek-account' ? 'deepseek-oauth' : 'none' })
  }
  if (url.pathname === '/api/skills/mentions') return json({ plugins: [], skills: [] })
  if (url.pathname === '/api/skills') return json({ skills: [] })
  if (url.pathname === '/api/agents') return json({ agents: [], activeAgents: [] })
  if (url.pathname === '/api/sessions/live-status') return json({ sessions: [] })
  if (url.pathname === '/api/sessions/repository-context') return json({ state: 'not_git_repo', workDir, repoRoot: null, repoName: null, currentBranch: null, defaultBranch: null, dirty: false, branches: [], worktrees: [] })
  if (url.pathname === '/api/sessions/recent-projects') return json({ projects: [] })
  if (/^\/api\/sessions\/[^/]+\/git-info$/.test(url.pathname)) return json({ isGitRepo: false, branch: null, worktree: null })
  if (/^\/api\/sessions\/[^/]+\/ultracode$/.test(url.pathname)) return json({ enabled: false, active: false, available: false })
  if (/^\/api\/sessions\/[^/]+\/slash-commands$/.test(url.pathname)) return json({ commands: [] })
  if (/^\/api\/teams\/session\/[^/]+\/plan$/.test(url.pathname)) return json({ plan: null })
  if (/^\/api\/sessions\/[^/]+\/inspection$/.test(url.pathname)) return json({ active: false, status: { sessionId: url.pathname.split('/')[3], workDir, permissionMode: 'default', model: 'deepseek-v4-pro' } })
  if (/^\/api\/sessions\/[^/]+\/turn-checkpoints$/.test(url.pathname)) return json({ checkpoints: [] })
  if (/^\/api\/sessions\/[^/]+\/workspace\/status$/.test(url.pathname)) return json({ state: 'not_git_repo', workDir, repoName: null, branch: null, isGitRepo: false, changedFiles: [] })
  if (url.pathname === '/api/voice/catalog') return json({ supported: false, providers: [], preferences: { enabled: false, providerId: '', language: 'auto', downloadSource: 'auto' }, limits: { maxAudioSeconds: 60, maxAudioBytes: 1_000_000 } })
  evidence.unexpected.push(`${method} ${url.pathname}`)
  throw new Error(`Unexpected fixture API: ${method} ${url.pathname}`)
}

const existingChat = { ...createDefaultSessionState(), connectionState: 'connected' as const, connectionSnapshotReady: true, historyHydrated: true, historyStatus: 'ready' as const, messages: [
  { id: 'fixture-user', type: 'user_text' as const, content: '让手机上新建聊天和选择模型更顺手。', timestamp: Date.now() - 20_000 },
  { id: 'fixture-assistant', type: 'assistant_text' as const, content: '可以。我们先把聊天放到首页，让模型选择在发送前就清楚可见。', timestamp: Date.now() - 10_000 },
] }
useUIStore.setState({ theme })
useUIStore.getState().startNewSessionDraft(workDir)
useSettingsStore.setState({ locale: 'zh', autoUpdateEnabled: false, leanModeEnabled: false,
  currentModel: availableModels[0], availableModels,
  activeProviderName: 'DeepSeek Account', permissionMode: 'default', effortLevel: 'medium',
})
useTabStore.setState({ tabs: [], activeTabId: null })
useSessionRuntimeStore.setState({ selections: {} })
useSessionStore.setState({ sessions: [existing], isLoading: false, error: null,
  fetchSessions: async () => {},
  createSession: async (cwd, options) => {
    const id = 'fixture-created'
    evidence.creates.push({ workDir: cwd, options })
    useSessionStore.setState(state => ({ sessions: [{ ...existing, id, title: '手机模型选择验证', messageCount: 0 }, ...state.sessions], activeSessionId: id }))
    return id
  },
})
useChatStore.setState({ sessions: { [existing.id]: existingChat },
  connectToSession: id => {
    evidence.connects.push(id)
    if (!useChatStore.getState().sessions[id]) useChatStore.setState(state => ({ sessions: { ...state.sessions, [id]: { ...createDefaultSessionState(), connectionState: 'connected', connectionSnapshotReady: true, historyHydrated: true, historyStatus: 'ready' } } }))
  },
  disconnectSession: id => { evidence.disconnects.push(id) },
  setSessionRuntime: (sessionId, selection) => { evidence.runtimeUpdates.push({ sessionId, selection }) },
  sendMessage: (sessionId, content, attachments, options) => {
    evidence.sends.push({ sessionId, content, attachments, options, runtimeSelection: useSessionRuntimeStore.getState().selections[sessionId] })
    useChatStore.setState(state => ({ sessions: { ...state.sessions, [sessionId]: { ...(state.sessions[sessionId] ?? createDefaultSessionState()), messages: [{ id: 'fixture-sent', type: 'user_text', content, timestamp: Date.now() }] } } }))
    return true
  },
})
useTeamStore.setState({ fetchTeamForSession: async () => {} })
useWorkspaceContentStore.setState({ loadStatus: async () => {} })
useSessionDelegationStore.setState({ refresh: async () => {} })
await useProviderStore.getState().fetchProviders()
createRoot(document.getElementById('root')!).render(<MobileShell layout="phone" preferencesRequest={null} />)
