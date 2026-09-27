import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const { sendMock } = vi.hoisted(() => ({
  sendMock: vi.fn(),
}))

vi.mock('../../api/websocket', () => ({
  wsManager: {
    connect: vi.fn(),
    disconnect: vi.fn(),
    onConnectionState: vi.fn((_sessionId: string, handler: (state: string) => void) => {
      handler('connecting')
      return () => {}
    }),
    onMessage: vi.fn(() => () => {}),
    clearHandlers: vi.fn(),
    send: sendMock,
  },
}))

import { useChatStore } from '../../stores/chatStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useTabStore } from '../../stores/tabStore'
import { useProviderStore } from '../../stores/providerStore'
import { useSessionRuntimeStore } from '../../stores/sessionRuntimeStore'
import { useHahaOAuthStore } from '../../stores/hahaOAuthStore'
import { PermissionDialog } from './PermissionDialog'
import { ToolCallBlock } from './ToolCallBlock'

const PLAN = [
  '# Release checklist',
  '',
  '1. Update the desktop plan modal.',
  '2. Run `bun run check:desktop`.',
  '',
  '```bash',
  'bun test desktop/src/components/chat/PlanModePermissionDialog.test.tsx',
  '```',
].join('\n')

function seedPendingPlanPermission() {
  useChatStore.setState({
    sessions: {
      'session-1': {
        messages: [],
        chatState: 'permission_pending',
        connectionState: 'connected',
        streamingText: '',
        streamingToolInput: '',
        activeToolUseId: null,
        activeToolName: null,
        activeThinkingId: null,
        pendingPermission: {
          requestId: 'perm-plan',
          toolName: 'ExitPlanMode',
          toolUseId: 'toolu-plan',
          input: {
            plan: PLAN,
            planFilePath: '/tmp/claude-plan.md',
            allowedPrompts: [{ tool: 'Bash', prompt: 'run tests' }],
          },
          description: 'Exit plan mode?',
        },
        pendingComputerUsePermission: null,
        tokenUsage: { input_tokens: 0, output_tokens: 0 },
        streamingResponseChars: 0,
        elapsedSeconds: 0,
        statusVerb: '',
        slashCommands: [],
        agentTaskNotifications: {},
        backgroundAgentTasks: {},
        elapsedTimer: null,
        composerPrefill: null,
        composerInsertion: null,
        composerDraft: null,
      },
    },
  })
}

describe('plan mode permission UI', () => {
  beforeEach(() => {
    sendMock.mockReset()
    useSettingsStore.setState({ locale: 'en' })
    useTabStore.setState({
      activeTabId: 'session-1',
      tabs: [{ sessionId: 'session-1', title: 'Test', type: 'session' as const, status: 'idle' }],
    })
    seedPendingPlanPermission()
    useProviderStore.setState({
      providers: [{
        id: 'deepseek',
        presetId: 'custom',
        name: 'DeepSeek',
        apiKey: '***',
        baseUrl: 'https://api.deepseek.com',
        apiFormat: 'anthropic',
        models: {
          main: 'deepseek-v4-pro',
          haiku: '',
          sonnet: '',
          opus: '',
        },
      }],
      activeId: 'deepseek',
      hasLoadedProviders: true,
      isLoading: false,
      fetchProviders: async () => {},
    })
    useSessionRuntimeStore.setState({ selections: {} })
    useHahaOAuthStore.setState({
      status: {
        loggedIn: true,
        expiresAt: null,
        scopes: [],
        subscriptionType: 'pro',
      },
      fetchStatus: async () => {},
    })
    useSettingsStore.setState({
      currentModel: {
        id: 'claude-opus-4-8',
        name: 'Opus 4.8',
        description: '',
        context: '',
      },
      activeProviderName: null,
      availableModels: [
        { id: 'claude-opus-4-8', name: 'Opus 4.8', description: '', context: '' },
        { id: 'claude-sonnet-5', name: 'Sonnet 5', description: '', context: '' },
        { id: 'claude-haiku-4-5', name: 'Haiku 4.5', description: '', context: '' },
      ],
    })
  })

  it('renders ExitPlanMode as a plan preview instead of raw tool input', () => {
    const { container } = render(
      <PermissionDialog
        sessionId="session-1"
        requestId="perm-plan"
        toolName="ExitPlanMode"
        input={{
          plan: PLAN,
          planFilePath: '/tmp/claude-plan.md',
          allowedPrompts: [{ tool: 'Bash', prompt: 'run tests' }],
        }}
        description="Exit plan mode?"
      />,
    )

    expect(container.textContent).toContain('Ready to code?')
    expect(container.textContent).toContain('Release checklist')
    expect(container.textContent).toContain('Update the desktop plan modal.')
    expect(container.textContent).toContain('/tmp/claude-plan.md')
    expect(container.textContent).toContain('Requested permissions')
    expect(container.textContent).toContain('Bash')
    expect(container.textContent).toContain('run tests')
    expect(screen.getByRole('button', { name: 'Approve plan' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Keep planning' })).toBeTruthy()
    expect(container.textContent).not.toContain('"allowedPrompts"')
  })

  it('sends typed feedback when the user keeps planning', () => {
    render(
      <PermissionDialog
        sessionId="session-1"
        requestId="perm-plan"
        toolName="ExitPlanMode"
        input={{ plan: PLAN, planFilePath: '/tmp/claude-plan.md' }}
      />,
    )

    fireEvent.change(screen.getByPlaceholderText('Tell Claude what to change'), {
      target: { value: 'Add a rollback step before implementation.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Keep planning' }))

    expect(sendMock).toHaveBeenCalledWith('session-1', {
      type: 'permission_response',
      requestId: 'perm-plan',
      allowed: false,
      denyMessage: 'Add a rollback step before implementation.',
    })
  })

  it('includes requested prompt permissions when approving the plan', () => {
    render(
      <PermissionDialog
        sessionId="session-1"
        requestId="perm-plan"
        toolName="ExitPlanMode"
        input={{
          plan: PLAN,
          allowedPrompts: [{ tool: 'Bash', prompt: 'run tests' }],
        }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Approve plan' }))

    expect(sendMock).toHaveBeenCalledWith('session-1', {
      type: 'permission_response',
      requestId: 'perm-plan',
      allowed: true,
      permissionUpdates: [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'prompt: run tests' }],
          behavior: 'allow',
          destination: 'session',
        },
      ],
    })
  })

  it('approves with an explicit bypass permission update', () => {
    render(
      <PermissionDialog
        sessionId="session-1"
        requestId="perm-plan"
        toolName="ExitPlanMode"
        input={{ plan: PLAN, planFilePath: '/tmp/claude-plan.md' }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Approve & bypass permissions' }))

    // The CLI resumes implementation with the session mode pinned here; without
    // it a session that launched in plan mode falls back to `default` and
    // prompts for every tool call.
    expect(sendMock).toHaveBeenCalledWith('session-1', {
      type: 'permission_response',
      requestId: 'perm-plan',
      allowed: true,
      permissionUpdates: [
        { type: 'setMode', mode: 'bypassPermissions', destination: 'session' },
      ],
    })
  })

  it('approves with auto-accept edits and keeps the requested prompt rules', () => {
    render(
      <PermissionDialog
        sessionId="session-1"
        requestId="perm-plan"
        toolName="ExitPlanMode"
        input={{
          plan: PLAN,
          allowedPrompts: [{ tool: 'Bash', prompt: 'run tests' }],
        }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Approve & auto-accept edits' }))

    // Order matters: the mode rides first, the prompt rules follow it.
    expect(sendMock).toHaveBeenCalledWith('session-1', {
      type: 'permission_response',
      requestId: 'perm-plan',
      allowed: true,
      permissionUpdates: [
        { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'prompt: run tests' }],
          behavior: 'allow',
          destination: 'session',
        },
      ],
    })
  })

  it('renders approved ExitPlanMode results as a markdown plan card', () => {
    const { container } = render(
      <ToolCallBlock
        toolName="ExitPlanMode"
        input={{ plan: PLAN, planFilePath: '/tmp/claude-plan.md' }}
        result={{
          isError: false,
          content: [
            'User has approved your plan. You can now start coding.',
            '',
            'Your plan has been saved to: /tmp/claude-plan.md',
            '',
            '## Approved Plan:',
            PLAN,
          ].join('\n'),
        }}
      />,
    )

    expect(container.textContent).toContain('Plan approved')
    expect(container.textContent).toContain('Release checklist')
    expect(container.textContent).toContain('Update the desktop plan modal.')
    expect(container.textContent).toContain('/tmp/claude-plan.md')
    expect(container.textContent).not.toContain('Tool Output')
  })

  it('does not render an empty plan preview for interrupted ExitPlanMode results', () => {
    const { container } = render(
      <ToolCallBlock
        toolName="ExitPlanMode"
        input={{}}
        result={{
          isError: true,
          content: 'Tool permission request failed: AbortError',
        }}
      />,
    )

    expect(container.textContent).toContain('Plan rejected')
    expect(container.textContent).toContain('Tool permission request failed: AbortError')
    expect(container.textContent).not.toContain("Claude's plan")
    expect(container.textContent).not.toContain('No plan content available.')
  })

  it('renders EnterPlanMode as a compact status instead of raw model instructions', () => {
    const { container } = render(
      <ToolCallBlock
        toolName="EnterPlanMode"
        input={{}}
        result={{
          isError: false,
          content: [
            'Entered plan mode. You should now focus on exploring the codebase and designing an implementation approach.',
            '',
            'In plan mode, you should:',
            '1. Thoroughly explore the codebase',
            '2. Ask clarifying questions if needed',
            '',
            'Remember: DO NOT write or edit files until the user approves your plan.',
          ].join('\n'),
        }}
      />,
    )

    expect(container.textContent).toContain('Plan mode')
    expect(container.textContent).not.toContain('Tool Output')
    expect(container.textContent).not.toContain('Thoroughly explore the codebase')
    expect(container.textContent).not.toContain('Remember: DO NOT write or edit files')
  })

  it('sends runtimeOverride with the staged execution model on approve', async () => {
    useProviderStore.setState({
      providers: [{
        id: 'deepseek',
        presetId: 'custom',
        name: 'DeepSeek',
        apiKey: '***',
        baseUrl: 'https://api.deepseek.com',
        apiFormat: 'anthropic',
        models: {
          main: 'deepseek-v4-pro',
          haiku: '',
          sonnet: '',
          opus: '',
        },
      }],
      activeId: 'deepseek',
      hasLoadedProviders: true,
      isLoading: false,
    })
    useSettingsStore.setState({
      currentModel: { id: 'deepseek-v4-pro', name: 'deepseek-v4-pro', description: '', context: '' },
      activeProviderName: 'DeepSeek',
    })
    useSessionRuntimeStore.setState({
      selections: {
        'session-1': { providerId: 'deepseek', modelId: 'deepseek-v4-pro' },
      },
    })

    render(
      <PermissionDialog
        sessionId="session-1"
        requestId="perm-plan"
        toolName="ExitPlanMode"
        input={{ plan: PLAN, planFilePath: '/tmp/claude-plan.md' }}
      />,
    )

    // The chip shows the planning model by default and no staged badge.
    expect(screen.getByTestId('plan-execution-model').textContent).toContain('deepseek-v4-pro')
    expect(screen.getByTestId('plan-execution-model').textContent).not.toContain('applies on approve')
    expect(screen.getByText('Execution model')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Execution model' }))
    await waitFor(() => {
      expect(screen.getByTestId('model-selector-dropdown')).toBeTruthy()
    })
    fireEvent.click(screen.getByRole('button', { name: /Sonnet 5/ }))

    await waitFor(() => {
      expect(screen.getByTestId('plan-execution-model').textContent).toContain('applies on approve')
    })
    expect(screen.getByTestId('plan-execution-model').textContent).toContain('Sonnet 5')

    fireEvent.click(screen.getByRole('button', { name: 'Approve plan' }))

    expect(sendMock).toHaveBeenCalledWith('session-1', {
      type: 'permission_response',
      requestId: 'perm-plan',
      allowed: true,
      runtimeOverride: {
        providerId: null,
        modelId: 'claude-sonnet-5',
      },
    })
    // Local echo: the composer pill now reflects the staged execution model.
    expect(useSessionRuntimeStore.getState().selections['session-1']).toEqual({
      providerId: null,
      modelId: 'claude-sonnet-5',
    })
    useChatStore.getState().handleServerMessage('session-1', {
      type: 'runtime_config_applied', providerId: null, modelId: 'claude-sonnet-5',
    })
    useSessionRuntimeStore.getState().syncFromSessions([{
      id: 'session-1', runtimeProviderId: 'deepseek', runtimeModelId: 'deepseek-v4-flash',
    } as never])
    expect(useSessionRuntimeStore.getState().selections['session-1']?.modelId).toBe('deepseek-v4-flash')
  })

  it('keeps the approval plain when the user re-selects the current model', async () => {
    useSessionRuntimeStore.setState({
      selections: {
        'session-1': { providerId: null, modelId: 'claude-opus-4-8' },
      },
    })
    useSettingsStore.setState({
      currentModel: { id: 'claude-opus-4-8', name: 'Opus 4.8', description: '', context: '' },
      activeProviderName: null,
    })

    render(
      <PermissionDialog
        sessionId="session-1"
        requestId="perm-plan"
        toolName="ExitPlanMode"
        input={{ plan: PLAN, planFilePath: '/tmp/claude-plan.md' }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Execution model' }))
    await waitFor(() => {
      expect(screen.getByTestId('model-selector-dropdown')).toBeTruthy()
    })
    fireEvent.click(screen.getByRole('button', { name: /Sonnet 5/ }))
    await waitFor(() => {
      expect(screen.getByTestId('plan-execution-model').textContent).toContain('applies on approve')
    })

    // Open again and pick the current model back.
    fireEvent.click(screen.getByRole('button', { name: 'Execution model' }))
    await waitFor(() => {
      expect(screen.getByTestId('model-selector-dropdown')).toBeTruthy()
    })
    fireEvent.click(screen.getByRole('button', { name: /Opus 4\.8/ }))

    await waitFor(() => {
      expect(screen.getByTestId('plan-execution-model').textContent).not.toContain('applies on approve')
    })
    expect(screen.getByTestId('plan-execution-model').textContent).toContain('Opus 4.8')

    fireEvent.click(screen.getByRole('button', { name: 'Approve plan' }))

    expect(sendMock).toHaveBeenCalledWith('session-1', {
      type: 'permission_response',
      requestId: 'perm-plan',
      allowed: true,
    })
    expect(sendMock).not.toHaveBeenCalledWith('session-1', expect.objectContaining({
      runtimeOverride: expect.anything(),
    }))
  })
})
