import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getSlashCommands: vi.fn(),
  getInspection: vi.fn(),
  getSessionUsage: vi.fn(),
  getGitInfo: vi.fn(),
  getMemberTranscript: vi.fn(),
  getWorkbench: vi.fn(),
  sendMemberMessage: vi.fn(),
  updateMemberRuntime: vi.fn(),
  listReferences: vi.fn(),
  listAgents: vi.fn(),
  wsSend: vi.fn(),
}))

vi.mock('../../api/sessions', () => ({
  sessionsApi: {
    getSlashCommands: mocks.getSlashCommands,
    getInspection: mocks.getInspection,
    getSessionUsage: mocks.getSessionUsage,
    getGitInfo: mocks.getGitInfo,
  },
}))

vi.mock('../../api/teams', () => ({
  teamsApi: {
    getMemberTranscript: mocks.getMemberTranscript,
    getWorkbench: mocks.getWorkbench,
    sendMemberMessage: mocks.sendMemberMessage,
    updateMemberRuntime: mocks.updateMemberRuntime,
    getWorkbenchForSession: vi.fn(),
    get: vi.fn(),
    list: vi.fn(),
    delete: vi.fn(),
  },
}))

vi.mock('../../api/composerReferences', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../api/composerReferences')>(),
  composerReferencesApi: { list: mocks.listReferences },
}))

vi.mock('../../api/agents', () => ({ agentsApi: { list: mocks.listAgents } }))

vi.mock('@/api/voice', () => ({
  voiceApi: {
    catalog: vi.fn(async () => ({
      supported: false,
      providers: [],
      preferences: { enabled: false, providerId: 'sensevoice-local', language: 'auto', downloadSource: 'auto', correctionEnabled: false, correctionProviderId: null, correctionModelId: null },
      limits: { maxAudioSeconds: 60, maxAudioBytes: 1_000_000 },
      correction: { defaultTarget: null, target: null },
    })),
    transcribe: vi.fn(),
    providerStatus: vi.fn(),
    updatePreferences: vi.fn(),
    prepare: vi.fn(),
    cancelPrepare: vi.fn(),
    removeAssets: vi.fn(),
  },
}))

vi.mock('../../api/websocket', () => ({
  wsManager: {
    connect: vi.fn(),
    disconnect: vi.fn(),
    onConnectionState: vi.fn(() => () => {}),
    onMessage: vi.fn(() => () => {}),
    clearHandlers: vi.fn(),
    send: mocks.wsSend,
  },
}))

vi.mock('../../hooks/useMobileViewport', () => ({ useMobileViewport: () => false }))

import { ApiError } from '../../api/client'
import { ChatInput } from './ChatInput'
import { getComposerElement, getComposerText, setComposerText, stubRangeGeometry } from './composerTestUtils'
import { useChatStore } from '../../stores/chatStore'
import { useContextUsageStore } from '../../stores/contextUsageStore'
import { useHahaDeepSeekOAuthStore } from '../../stores/hahaDeepSeekOAuthStore'
import { useHahaGrokOAuthStore } from '../../stores/hahaGrokOAuthStore'
import { useHahaOAuthStore } from '../../stores/hahaOAuthStore'
import { useHahaOpenAIOAuthStore } from '../../stores/hahaOpenAIOAuthStore'
import { useProviderStore } from '../../stores/providerStore'
import { useSessionRuntimeStore } from '../../stores/sessionRuntimeStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useTabStore } from '../../stores/tabStore'
import { memberSessionId, useTeamStore } from '../../stores/teamStore'
import { useUIStore } from '../../stores/uiStore'
import type { TeamMember, TeamWorkbenchSnapshot } from '../../types/team'

const MEMBER_CLI_SESSION = 'member-cli-session'
const TEAM = 'review-team'
const AGENT_ID = 'reviewer@review-team'
const INCARNATION = 'review-team:2026-11-03:lead-session'

const zhipu = {
  id: 'zhipu', presetId: 'custom', name: 'Zhipu', apiFormat: 'anthropic' as const,
  apiKey: 'fixture', baseUrl: 'http://127.0.0.1:1',
  models: { main: 'glm-5.3', haiku: 'glm-5.1', sonnet: 'glm-5.1', opus: 'glm-5.3' },
}

const inspection = {
  active: true,
  context: {
    categories: [{ name: 'Messages', tokens: 190_000, color: '#2D628F' }],
    totalTokens: 190_000,
    maxTokens: 200_000,
    rawMaxTokens: 200_000,
    percentage: 95,
    gridRows: [],
    model: 'glm-5.3',
    memoryFiles: [],
    mcpTools: [],
    agents: [],
  },
}

function snapshotWith(member: TeamMember): TeamWorkbenchSnapshot {
  return {
    version: `v-${member.model}`,
    generatedAt: '2026-11-03T00:00:00.000Z',
    team: {
      name: TEAM,
      incarnationId: INCARNATION,
      leadAgentId: 'team-lead@review-team',
      leadSessionId: 'lead-session',
      createdAt: String(Date.parse('2026-11-03T00:00:00.000Z')),
      members: [member],
    },
    tasks: [],
    messages: [],
  } as TeamWorkbenchSnapshot
}

const baseMember: TeamMember = {
  agentId: AGENT_ID,
  name: 'reviewer',
  role: 'reviewer',
  status: 'idle',
  activity: 'idle',
  sessionId: MEMBER_CLI_SESSION,
  model: 'glm-5.3',
  providerId: 'zhipu',
  providerName: 'Zhipu',
}

let restoreRangeGeometry: () => void = () => {}

/** Opens the member's conversation the way the workbench does and mounts its composer. */
async function renderMemberComposer(member: TeamMember = baseMember) {
  const snapshot = snapshotWith(member)
  useTeamStore.setState({
    workbenchesBySession: {
      'lead-session': { teamName: TEAM, snapshots: [snapshot], loading: false, error: null },
    },
  })
  useTabStore.getState().openTab('lead-session', 'Lead')
  act(() => {
    useTeamStore.getState().openMemberSession(member, snapshot.team, snapshot)
  })
  const tabId = memberSessionId(AGENT_ID, INCARNATION)
  expect(useTabStore.getState().activeTabId).toBe(tabId)
  await waitFor(() => expect(useChatStore.getState().sessions[tabId]?.messages.length).toBe(1))
  render(<ChatInput />)
  return tabId
}

describe('ChatInput in a team member conversation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    restoreRangeGeometry = stubRangeGeometry()
    useSettingsStore.setState({ locale: 'en', effortLevel: 'low' })
    useChatStore.setState(useChatStore.getInitialState(), true)
    useTabStore.setState(useTabStore.getInitialState(), true)
    useSessionRuntimeStore.setState(useSessionRuntimeStore.getInitialState(), true)
    useContextUsageStore.setState({ bySession: {} })
    useTeamStore.getState().clearTeam()
    useProviderStore.setState({ hasLoadedProviders: true, isLoading: false, providers: [zhipu], activeId: null })
    useHahaOAuthStore.setState({ fetchStatus: async () => {} })
    useHahaOpenAIOAuthStore.setState({ fetchStatus: async () => {} })
    useHahaGrokOAuthStore.setState({ fetchStatus: async () => {} })
    useHahaDeepSeekOAuthStore.setState({ fetchStatus: async () => {} })
    mocks.getMemberTranscript.mockResolvedValue({
      messages: [{
        id: 'member-reply',
        type: 'assistant',
        content: [{ type: 'text', text: 'Reviewing the auth flow.' }],
        timestamp: '2026-11-03T00:01:00.000Z',
      }],
    })
    mocks.getSlashCommands.mockResolvedValue({
      commands: [
        { name: 'compact', description: 'Compact conversation context', kind: 'command' },
        { name: 'clear', description: 'Clear conversation history', kind: 'command' },
        { name: 'model', description: 'Switch AI model', kind: 'command' },
        { name: 'goal', description: 'Set a completion goal', kind: 'command' },
        { name: 'review', description: 'Review code changes', kind: 'command' },
        { name: 'security-audit', description: 'Audit a change for security issues', kind: 'skill', source: 'user' },
      ],
    })
    mocks.getInspection.mockResolvedValue(inspection)
    mocks.getSessionUsage.mockResolvedValue({ active: true })
    mocks.getGitInfo.mockResolvedValue(null)
    mocks.listReferences.mockResolvedValue({ plugins: [], skills: [] })
    mocks.listAgents.mockResolvedValue({ activeAgents: [] })
    mocks.sendMemberMessage.mockResolvedValue({ ok: true })
    mocks.getWorkbench.mockImplementation(async () => snapshotWith({ ...baseMember, model: 'glm-5.1' }))
    mocks.updateMemberRuntime.mockResolvedValue({
      ok: true,
      member: { agentId: AGENT_ID, name: 'reviewer', model: 'glm-5.1', providerId: 'zhipu', providerName: 'Zhipu' },
    })
  })

  afterEach(() => {
    cleanup()
    for (const session of Object.values(useChatStore.getState().sessions)) {
      if (session.elapsedTimer) clearInterval(session.elapsedTimer)
    }
    useTeamStore.getState().clearTeam()
    useUIStore.setState(useUIStore.getInitialState(), true)
    restoreRangeGeometry()
  })

  it("offers the member CLI's own commands and skills, without the ones a member cannot run", async () => {
    const tabId = await renderMemberComposer()
    await waitFor(() => expect(mocks.getSlashCommands).toHaveBeenCalledWith(MEMBER_CLI_SESSION))
    expect(mocks.getSlashCommands).not.toHaveBeenCalledWith(tabId)

    setComposerText('/', 1)
    const menu = await screen.findByRole('listbox', { name: 'Slash commands' })
    expect(within(menu).getByRole('option', { name: '/compact' })).toBeInTheDocument()
    expect(within(menu).getByRole('option', { name: '/review' })).toBeInTheDocument()
    expect(await within(menu).findByRole('option', { name: /security-audit/ })).toBeInTheDocument()
    // `/clear` and `/model` are refused by the server; `/context` and `/btw`
    // run in this desktop against the chat on screen, not in the member.
    for (const name of ['/clear', '/model', '/goal', '/context', '/status', '/btw']) {
      expect(within(menu).queryByRole('option', { name })).not.toBeInTheDocument()
    }

    setComposerText('/cle', 4)
    expect(screen.queryByRole('option', { name: '/clear' })).not.toBeInTheDocument()
  })

  it('sends a chosen command to the member as is, through its message endpoint', async () => {
    const setSessionRuntime = vi.fn()
    useChatStore.setState({ setSessionRuntime })
    await renderMemberComposer()

    setComposerText('/comp', 5)
    expect(await screen.findByRole('option', { name: '/compact' })).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(getComposerElement(), { key: 'Enter' })
    await waitFor(() => expect(getComposerText()).toBe('/compact '))
    fireEvent.keyDown(getComposerElement(), { key: 'Enter' })

    await waitFor(() => expect(mocks.sendMemberMessage).toHaveBeenCalledWith(TEAM, AGENT_ID, '/compact'))
    expect(mocks.wsSend).not.toHaveBeenCalled()
    expect(setSessionRuntime).not.toHaveBeenCalled()
  })

  it('says why a command the server refuses for members is not sent, and keeps the draft', async () => {
    const tabId = await renderMemberComposer()

    setComposerText('/clear', 6)
    expect(screen.queryByRole('listbox', { name: 'Slash commands' })).not.toBeInTheDocument()
    fireEvent.keyDown(getComposerElement(), { key: 'Enter' })

    await waitFor(() => expect(useUIStore.getState().toasts.at(-1)?.message)
      .toBe("A teammate's conversation can't run /clear or /model. To make room in its context, use /compact; to switch its model, use the model picker in the composer."))
    expect(mocks.sendMemberMessage).not.toHaveBeenCalled()
    expect(getComposerText()).toBe('/clear')
    // Nothing waits in the conversation for a delivery that cannot happen.
    expect(useChatStore.getState().sessions[tabId]?.messages.some((message) => message.type === 'user_text')).toBe(false)
  })

  it('explains a refusal the server still sends back for a member message', async () => {
    mocks.sendMemberMessage.mockRejectedValueOnce(new ApiError(400, {
      error: 'MEMBER_COMMAND_UNSUPPORTED',
      message: '/Model is not supported for team members',
    }))
    const tabId = await renderMemberComposer()

    // A refusal the composer does not foresee still gets the localized explanation.
    setComposerText('/models', 7)
    fireEvent.keyDown(getComposerElement(), { key: 'Escape' })
    fireEvent.keyDown(getComposerElement(), { key: 'Enter' })

    await waitFor(() => expect(mocks.sendMemberMessage).toHaveBeenCalledWith(TEAM, AGENT_ID, '/models'))
    await waitFor(() => {
      const failure = useChatStore.getState().sessions[tabId]?.messages.find((message) => message.type === 'error')
      expect(failure).toMatchObject({
        code: 'TEAM_MEMBER_MESSAGE_FAILED',
        message: "A teammate's conversation can't run /clear or /model. To make room in its context, use /compact; to switch its model, use the model picker in the composer.",
      })
    })
  })

  it("reads the context usage from the member's own CLI session", async () => {
    const tabId = await renderMemberComposer()

    await waitFor(() => expect(mocks.getInspection).toHaveBeenCalledWith(
      MEMBER_CLI_SESSION,
      expect.objectContaining({ includeContext: true }),
    ))
    expect(mocks.getInspection).not.toHaveBeenCalledWith(tabId, expect.anything())
    expect(screen.getByTestId('context-usage-ring')).toBeInTheDocument()
    await waitFor(() => expect(useContextUsageStore.getState().bySession[MEMBER_CLI_SESSION]?.context?.percentage).toBe(95))
  })

  it('switches the member model through the team runtime, never the session runtime', async () => {
    const setSessionRuntime = vi.fn()
    useChatStore.setState({ setSessionRuntime })
    const tabId = await renderMemberComposer()

    fireEvent.click(screen.getByRole('button', { name: 'glm-5.3, Zhipu' }))
    const choices = await screen.findAllByRole('button', { name: /glm-5\.1/ })
    fireEvent.click(choices[0]!)

    await waitFor(() => expect(mocks.updateMemberRuntime).toHaveBeenCalledTimes(1))
    // The member had no effort of its own, so the composer-wide "low" stays off it.
    expect(mocks.updateMemberRuntime).toHaveBeenCalledWith(TEAM, AGENT_ID, { providerId: 'zhipu', modelId: 'glm-5.1' })
    expect(setSessionRuntime).not.toHaveBeenCalled()
    expect(mocks.wsSend).not.toHaveBeenCalled()
    expect(useSessionRuntimeStore.getState().selections[tabId]).toBeUndefined()
    expect(useSessionRuntimeStore.getState().selections[MEMBER_CLI_SESSION]).toBeUndefined()

    expect(await screen.findByRole('button', { name: 'glm-5.1, Zhipu' })).toBeInTheDocument()
    expect(useTeamStore.getState().getMemberBySessionId(tabId)).toMatchObject({ model: 'glm-5.1', providerId: 'zhipu' })
    await waitFor(() => expect(mocks.getWorkbench).toHaveBeenCalledWith(TEAM))
  })

  it('keeps the old model and says why when the switch is refused', async () => {
    mocks.updateMemberRuntime.mockRejectedValueOnce(new ApiError(409, {
      error: 'MEMBER_RUNTIME_BUSY',
      message: 'The member is in the middle of a turn',
    }))
    const tabId = await renderMemberComposer()

    fireEvent.click(screen.getByRole('button', { name: 'glm-5.3, Zhipu' }))
    fireEvent.click((await screen.findAllByRole('button', { name: /glm-5\.1/ }))[0]!)

    await waitFor(() => expect(useUIStore.getState().toasts.at(-1)?.message)
      .toBe("Couldn't switch the teammate's model: The member is in the middle of a turn"))
    expect(useTeamStore.getState().getMemberBySessionId(tabId)?.model).toBe('glm-5.3')
    expect(screen.getByRole('button', { name: 'glm-5.3, Zhipu' })).toBeInTheDocument()
  })

  it('tells the user how to recover a member whose context is full', async () => {
    await renderMemberComposer({ ...baseMember, status: 'error', lastError: 'Prompt is too long' })

    expect(screen.getByRole('textbox')).toHaveAttribute(
      'data-placeholder',
      'Its context is full. Type /compact to compact it, then send a message to let it continue',
    )
  })
})
