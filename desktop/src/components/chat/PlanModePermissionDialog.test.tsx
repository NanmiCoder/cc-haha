import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

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
    expect(container.textContent).toContain('/tmp/claude-plan.md')
    // Settled ExitPlanMode cards default collapsed until the reader expands them.
    fireEvent.click(container.querySelector('[data-chat-disclosure="true"]')!)
    expect(container.textContent).toContain('Release checklist')
    expect(container.textContent).toContain('Update the desktop plan modal.')
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
    fireEvent.click(container.querySelector('[data-chat-disclosure="true"]')!)
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
    expect(screen.getByTestId('plan-execution-model').textContent).not.toContain('applies on submit')
    expect(screen.getByText('Execution model')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Execution model' }))
    await waitFor(() => {
      expect(screen.getByTestId('model-selector-dropdown')).toBeTruthy()
    })
    // Anchored so the official catalog's "Sonnet 5.5" is not also matched.
    fireEvent.click(screen.getByRole('button', { name: /^Sonnet 5(?![.\d])/ }))

    await waitFor(() => {
      expect(screen.getByTestId('plan-execution-model').textContent).toContain('applies on submit')
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

  it.each([
    ['RUNTIME_CONFIG_INVALID', undefined],
    ['RUNTIME_CONFIG_INVALID', 'perm-plan'],
    ['SIDE_CHAT_RUNTIME_RESTART_UNAVAILABLE', 'perm-plan'],
  ])('keeps plan review retryable when its execution model is rejected (%s, %s)', async (code, permissionRequestId) => {
    const previousSelection = { providerId: 'deepseek', modelId: 'deepseek-v4-pro' }
    useSessionRuntimeStore.setState({ selections: { 'session-1': previousSelection } })
    render(
      <PermissionDialog sessionId="session-1" requestId="perm-plan" toolName="ExitPlanMode" input={{ plan: PLAN }} />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Execution model' }))
    await screen.findByTestId('model-selector-dropdown')
    fireEvent.click(screen.getByRole('button', { name: /^Sonnet 5(?![.\d])/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Approve plan' }))
    const store = useChatStore.getState()
    act(() => store.handleServerMessage('session-1', {
      type: 'error', code, message: 'The execution model is unavailable.', permissionRequestId,
    }))

    expect(screen.getByRole('alert').textContent).toContain('The execution model is unavailable.')
    expect(useChatStore.getState().sessions['session-1']?.chatState).toBe('permission_pending')
    expect(useSessionRuntimeStore.getState().selections['session-1']).toEqual(previousSelection)

    fireEvent.click(screen.getByRole('button', { name: 'Approve plan' }))
    expect(sendMock).toHaveBeenCalledTimes(2)
    expect((screen.getByRole('button', { name: 'Approve plan' }) as HTMLButtonElement).disabled).toBe(true)
    act(() => store.handleServerMessage('session-1', {
      type: 'permission_resolved', requestId: 'perm-plan', permissionType: 'tool', allowed: true,
    }))
    act(() => store.handleServerMessage('session-1', {
      type: 'error', code, message: 'Late execution model error', permissionRequestId: 'perm-plan',
    }))
    expect(useChatStore.getState().sessions['session-1']?.chatState).toBe('tool_executing')
    expect(screen.queryByRole('button', { name: 'Approve plan' })).toBeNull()
  })

  it('limits a running side-chat review to its existing provider', async () => {
    const sessionId = 'side-plan-qa'
    const session = useChatStore.getState().sessions['session-1']!
    useChatStore.setState({ sessions: { [sessionId]: session } })
    useSessionRuntimeStore.setState({ selections: { [sessionId]: { providerId: 'deepseek', modelId: 'deepseek-v4-pro' } } })
    render(
      <PermissionDialog sessionId={sessionId} requestId="perm-plan" toolName="ExitPlanMode" input={{ plan: PLAN }} />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Execution model' }))
    await screen.findByTestId('model-selector-dropdown')
    expect(screen.queryByRole('button', { name: /^Sonnet 5(?![.\d])/ })).toBeNull()
    expect(screen.getByTestId('model-selector-dropdown').textContent).toContain('deepseek-v4-pro')
  })

  it('sends runtimeOverride and denyMessage when switching model and clicking Keep planning', async () => {
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
          haiku: 'deepseek-v4-flash',
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

    fireEvent.click(screen.getByRole('button', { name: 'Execution model' }))
    await waitFor(() => {
      expect(screen.getByTestId('model-selector-dropdown')).toBeTruthy()
    })
    fireEvent.click(screen.getByRole('button', { name: /^Sonnet 5(?![.\d])/ }))

    await waitFor(() => {
      expect(screen.getByTestId('plan-execution-model').textContent).toContain('Sonnet 5')
    })

    fireEvent.change(screen.getByPlaceholderText('Tell Claude what to change'), {
      target: { value: 'Split phase 1 into smaller migrations.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Keep planning' }))

    expect(sendMock).toHaveBeenCalledWith('session-1', {
      type: 'permission_response',
      requestId: 'perm-plan',
      allowed: false,
      denyMessage: 'Split phase 1 into smaller migrations.',
      runtimeOverride: {
        providerId: null,
        modelId: 'claude-sonnet-5',
      },
    })
    expect(useSessionRuntimeStore.getState().selections['session-1']).toEqual({
      providerId: null,
      modelId: 'claude-sonnet-5',
    })
  })

  it('sends runtimeOverride without denyMessage when switching model and clicking Keep planning with empty feedback', async () => {
    useSessionRuntimeStore.setState({
      selections: {
        'session-1': { providerId: 'deepseek', modelId: 'deepseek-v4-pro' },
      },
    })
    useSettingsStore.setState({
      currentModel: { id: 'deepseek-v4-pro', name: 'deepseek-v4-pro', description: '', context: '' },
      activeProviderName: 'DeepSeek',
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
    fireEvent.click(screen.getByRole('button', { name: /^Sonnet 5(?![.\d])/ }))
    await waitFor(() => {
      expect(screen.getByTestId('plan-execution-model').textContent).toContain('applies on submit')
    })

    fireEvent.click(screen.getByRole('button', { name: 'Keep planning' }))

    expect(sendMock).toHaveBeenCalledWith('session-1', {
      type: 'permission_response',
      requestId: 'perm-plan',
      allowed: false,
      runtimeOverride: {
        providerId: null,
        modelId: 'claude-sonnet-5',
      },
    })
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
    fireEvent.click(screen.getByRole('button', { name: /^Sonnet 5(?![.\d])/ }))
    await waitFor(() => {
      expect(screen.getByTestId('plan-execution-model').textContent).toContain('applies on submit')
    })

    // Open again and pick the current model back.
    fireEvent.click(screen.getByRole('button', { name: 'Execution model' }))
    await waitFor(() => {
      expect(screen.getByTestId('model-selector-dropdown')).toBeTruthy()
    })
    fireEvent.click(screen.getByRole('button', { name: /Opus 4\.8/ }))

    await waitFor(() => {
      expect(screen.getByTestId('plan-execution-model').textContent).not.toContain('applies on submit')
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

  it('collapses long plans with a bottom fade and expands on toggle', () => {
    const longPlan = Array.from({ length: 20 }, (_, i) => `${i + 1}. Step ${i + 1} implementation detail`).join('\n')
    const { container } = render(
      <PermissionDialog
        sessionId="session-1"
        requestId="perm-plan"
        toolName="ExitPlanMode"
        input={{ plan: longPlan, planFilePath: '/tmp/claude-plan.md' }}
      />,
    )

    const toggle = container.querySelector<HTMLButtonElement>('[data-plan-expand-toggle="true"]')
    expect(toggle).toBeTruthy()
    expect(toggle?.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(toggle!)
    expect(toggle?.getAttribute('aria-expanded')).toBe('true')
  })

  it.each([
    { label: 'Cmd+Enter', init: { key: 'Enter', metaKey: true } },
    { label: 'Ctrl+Enter', init: { key: 'Enter', ctrlKey: true } },
  ])('submits revision feedback instead of approving when pressing $label inside the feedback textarea', ({ init }) => {
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

    const textarea = screen.getByPlaceholderText('Tell Claude what to change')
    fireEvent.change(textarea, {
      target: { value: 'Keep the schema migration in a separate PR.' },
    })
    fireEvent.keyDown(textarea, init)

    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(sendMock).toHaveBeenCalledWith('session-1', {
      type: 'permission_response',
      requestId: 'perm-plan',
      allowed: false,
      denyMessage: 'Keep the schema migration in a separate PR.',
    })
  })

  it.each([
    { label: 'empty feedback', value: '' },
    { label: 'whitespace-only feedback', value: '   \n\t  ' },
  ])('does not approve when pressing Cmd+Enter inside the feedback textarea with $label', ({ value }) => {
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

    const textarea = screen.getByPlaceholderText('Tell Claude what to change')
    if (value) {
      fireEvent.change(textarea, { target: { value } })
    }
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true })
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true })

    expect(sendMock).not.toHaveBeenCalled()
  })

  it('approves with requested permissions when pressing Cmd+Enter on the card outside the feedback textarea', () => {
    const { container } = render(
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

    fireEvent.keyDown(container.firstElementChild!, { key: 'Enter', metaKey: true })

    expect(sendMock).toHaveBeenCalledTimes(1)
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

  it('shows platform-aware shortcut keycap labels on permission and plan cards', () => {
    const platformSpy = vi.spyOn(navigator, 'platform', 'get')
    const userAgentSpy = vi.spyOn(navigator, 'userAgent', 'get')

    try {
      platformSpy.mockReturnValue('Win32')
      userAgentSpy.mockReturnValue('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')

      const { rerender } = render(
        <PermissionDialog
          sessionId="session-1"
          requestId="perm-plan"
          toolName="ExitPlanMode"
          input={{ plan: PLAN }}
        />,
      )
      expect(screen.getByRole('button', { name: 'Approve plan' }).textContent).toContain('Ctrl+↵')

      act(() => {
        useChatStore.setState((state) => ({
          sessions: {
            ...state.sessions,
            'session-1': {
              ...state.sessions['session-1']!,
              pendingPermission: {
                requestId: 'perm-bash',
                toolName: 'Bash',
                toolUseId: 'toolu-bash',
                input: { command: 'echo hi' },
              },
            },
          },
        }))
      })

      rerender(
        <PermissionDialog
          sessionId="session-1"
          requestId="perm-bash"
          toolName="Bash"
          input={{ command: 'echo hi' }}
        />,
      )
      expect(screen.getByRole('button', { name: /^Allow:/ }).textContent).toContain('Ctrl+↵')

      platformSpy.mockReturnValue('MacIntel')
      userAgentSpy.mockReturnValue('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)')

      rerender(
        <PermissionDialog
          sessionId="session-1"
          requestId="perm-bash"
          toolName="Bash"
          input={{ command: 'echo hi' }}
        />,
      )
      expect(screen.getByRole('button', { name: /^Allow:/ }).textContent).toContain('⌘↵')
    } finally {
      platformSpy.mockRestore()
      userAgentSpy.mockRestore()
    }
  })
})
