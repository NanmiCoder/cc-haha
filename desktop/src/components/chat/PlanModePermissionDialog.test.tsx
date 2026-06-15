import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

const { sendMock } = vi.hoisted(() => ({
  sendMock: vi.fn(),
}))

vi.mock('../../api/websocket', () => ({
  wsManager: {
    connect: vi.fn(),
    disconnect: vi.fn(),
    onMessage: vi.fn(() => () => {}),
    clearHandlers: vi.fn(),
    send: sendMock,
  },
}))

import { useChatStore } from '../../stores/chatStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useTabStore } from '../../stores/tabStore'
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
})
