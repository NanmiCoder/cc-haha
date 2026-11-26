import { beforeEach, describe, expect, it, vi } from 'vitest'

const { sendMock } = vi.hoisted(() => ({
  sendMock: vi.fn(),
}))

vi.mock('../api/websocket', () => ({
  wsManager: {
    connect: vi.fn(),
    disconnect: vi.fn(),
    onConnectionState: vi.fn(() => () => {}),
    onMessage: vi.fn(() => () => {}),
    clearHandlers: vi.fn(),
    send: sendMock,
  },
}))

import { ANTIGRAVITY_ACP_DEFAULT_MODEL_ID, ANTIGRAVITY_ACP_PROVIDER_ID } from '../constants/antigravityAcp'
import { createDefaultSessionState, useChatStore } from './chatStore'
import { useProviderStore } from './providerStore'
import { useSessionRuntimeStore } from './sessionRuntimeStore'
import { useSessionStore } from './sessionStore'
import { useSettingsStore } from './settingsStore'
import { useTabStore } from './tabStore'

const SESSION_ID = 'session-ag-preserve'

describe('chatStore Antigravity runtime preservation & permission classification', () => {
  beforeEach(() => {
    sendMock.mockReset()
    useSessionRuntimeStore.setState({ selections: {} })
    useProviderStore.setState({
      ...useProviderStore.getInitialState(),
      activeId: 'custom-claude',
      hasLoadedProviders: true,
      providers: [
        {
          id: 'custom-claude',
          presetId: 'custom',
          name: 'Custom Claude',
          apiKey: 'sk-test',
          baseUrl: 'https://api.example.com',
          apiFormat: 'anthropic',
          models: {
            main: 'claude-sonnet-4-6',
            haiku: 'claude-haiku-4-5',
            sonnet: 'claude-sonnet-4-6',
            opus: 'claude-opus-4-6',
          },
        },
      ],
      antigravity: {
        id: ANTIGRAVITY_ACP_PROVIDER_ID,
        kind: 'acp',
        status: 'ready',
        models: [
          { id: 'gemini-3.8-pro', name: 'Gemini 3.8 Pro', supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'], defaultReasoningEffort: 'high' },
        ],
        currentModelId: 'gemini-3.8-pro',
        currentEffortLevel: 'high',
      },
    }, true)
    useSettingsStore.setState({
      activeProviderName: 'Custom Claude',
      currentModel: {
        id: 'claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6',
        description: 'Balanced Claude model',
        context: '200K',
      },
      effortLevel: 'medium',
    })
    useTabStore.setState({
      tabs: [{ sessionId: SESSION_ID, title: 'AG Session', type: 'session', status: 'idle' }],
      activeTabId: SESSION_ID,
    })
    useChatStore.setState({
      sessions: {
        [SESSION_ID]: {
          ...createDefaultSessionState(),
          connectionState: 'connected',
          chatState: 'idle',
        },
      },
    })
  })

  it('hydrates Antigravity runtime from session metadata instead of clobbering with configuredDefault when selection is missing', () => {
    useSessionStore.setState({
      sessions: [
        {
          id: SESSION_ID,
          title: 'AG Session',
          createdAt: '2026-11-26T00:00:00.000Z',
          modifiedAt: '2026-11-26T00:00:00.000Z',
          messageCount: 1,
          projectPath: '/repo',
          projectRoot: '/repo',
          workDir: '/repo',
          workDirExists: true,
          runtimeProviderId: ANTIGRAVITY_ACP_PROVIDER_ID,
          runtimeModelId: 'gemini-3.8-flash',
          effortLevel: 'low',
        },
      ],
    })

    const sent = useChatStore.getState().sendMessage(SESSION_ID, 'Continue working')

    expect(sent).toBe(true)
    expect(useSessionRuntimeStore.getState().selections[SESSION_ID]).toEqual({
      providerId: ANTIGRAVITY_ACP_PROVIDER_ID,
      modelId: 'gemini-3.8-flash',
      effortLevel: 'low',
    })
    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(sendMock).toHaveBeenCalledWith(
      SESSION_ID,
      expect.objectContaining({ type: 'user_message', content: 'Continue working' }),
    )
    expect(sendMock).not.toHaveBeenCalledWith(
      SESSION_ID,
      expect.objectContaining({ type: 'set_runtime_config' }),
    )
  })

  it('falls back to Antigravity status/default model without overwriting with non-Antigravity provider when session lacks runtimeModelId', () => {
    useProviderStore.setState({
      antigravity: {
        id: ANTIGRAVITY_ACP_PROVIDER_ID,
        kind: 'acp',
        status: 'unchecked',
        models: [],
      },
    })
    useSessionStore.setState({
      sessions: [
        {
          id: SESSION_ID,
          title: 'AG Reloaded Session',
          createdAt: '2026-11-26T00:00:00.000Z',
          modifiedAt: '2026-11-26T00:00:00.000Z',
          messageCount: 0,
          projectPath: '/repo',
          projectRoot: '/repo',
          workDir: '/repo',
          workDirExists: true,
          runtimeProviderId: ANTIGRAVITY_ACP_PROVIDER_ID,
        },
      ],
    })

    const sent = useChatStore.getState().sendMessage(SESSION_ID, 'Hello Antigravity')

    expect(sent).toBe(true)
    expect(useSessionRuntimeStore.getState().selections[SESSION_ID]).toEqual({
      providerId: ANTIGRAVITY_ACP_PROVIDER_ID,
      modelId: ANTIGRAVITY_ACP_DEFAULT_MODEL_ID,
    })
    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(sendMock).not.toHaveBeenCalledWith(
      SESSION_ID,
      expect.objectContaining({ type: 'set_runtime_config' }),
    )
  })

  it('does not treat main-session Antigravity permission with displayName="Antigravity" as a delegated worker permission', () => {
    useChatStore.getState().handleServerMessage(SESSION_ID, {
      type: 'permission_request',
      requestId: 'req-main-ag',
      toolName: 'Bash',
      toolUseId: 'tool-main-ag',
      input: { CommandLine: 'bun test' },
      displayName: 'Antigravity',
      antigravityToolName: 'run_command',
      description: 'Run tests',
    })

    expect(useChatStore.getState().sessions[SESSION_ID]?.restoreIdleAfterPermissions).toBe(false)

    useChatStore.getState().handleServerMessage(SESSION_ID, {
      type: 'permission_request',
      requestId: 'req-sub-ag',
      toolName: 'Edit',
      toolUseId: 'tool-sub-ag',
      input: { TargetFile: '/repo/a.ts' },
      displayName: 'Antigravity',
      antigravityToolName: 'replace_file_content',
      subagentName: 'verifier',
    })
    // Main request is still pending, so not exclusively delegated
    expect(useChatStore.getState().sessions[SESSION_ID]?.restoreIdleAfterPermissions).toBe(false)
  })

  it('does not misclassify Antigravity main-session permissions lacking antigravityToolName and omits effort for 0-effort models', () => {
    useChatStore.getState().handleServerMessage(SESSION_ID, {
      type: 'permission_request',
      requestId: 'req-main-no-toolname',
      toolName: 'Antigravity',
      toolUseId: 'tool-main-no-toolname',
      input: {},
      displayName: 'Antigravity',
      description: 'Fallback tool',
    })
    expect(useChatStore.getState().sessions[SESSION_ID]?.restoreIdleAfterPermissions).toBe(false)

    useProviderStore.setState({
      antigravity: {
        id: ANTIGRAVITY_ACP_PROVIDER_ID,
        kind: 'acp',
        status: 'ready',
        models: [
          { id: 'orchestrator-neon', name: 'Orchestrator (Neon)', supportedReasoningEfforts: [] },
        ],
        currentModelId: 'orchestrator-neon',
        currentEffortLevel: 'high',
      },
    })
    useSessionStore.setState({
      sessions: [
        {
          id: SESSION_ID,
          title: 'Zero Effort AG',
          createdAt: '2026-11-26T00:00:00.000Z',
          modifiedAt: '2026-11-26T00:00:00.000Z',
          messageCount: 1,
          projectPath: '/repo',
          projectRoot: '/repo',
          workDir: '/repo',
          workDirExists: true,
          runtimeProviderId: ANTIGRAVITY_ACP_PROVIDER_ID,
          runtimeModelId: 'orchestrator-neon',
        },
      ],
    })
    useChatStore.getState().sendMessage(SESSION_ID, 'Check effort')
    expect(useSessionRuntimeStore.getState().selections[SESSION_ID]).toEqual({
      providerId: ANTIGRAVITY_ACP_PROVIDER_ID,
      modelId: 'orchestrator-neon',
    })
  })
})
