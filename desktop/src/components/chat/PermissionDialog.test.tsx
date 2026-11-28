import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { sendMock } = vi.hoisted(() => ({
  sendMock: vi.fn(),
}))

vi.mock('../../api/websocket', () => ({
  wsManager: {
    connect: vi.fn(),
    disconnect: vi.fn(),
    onConnectionState: vi.fn(() => () => {}),
    onMessage: vi.fn(() => () => {}),
    clearHandlers: vi.fn(),
    send: sendMock,
  },
}))

import { useChatStore, type PendingPermission } from '../../stores/chatStore'
import { useProviderStore } from '../../stores/providerStore'
import { useSessionRuntimeStore } from '../../stores/sessionRuntimeStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useTabStore } from '../../stores/tabStore'
import { PermissionDialog } from './PermissionDialog'
import { getPermissionTitle } from './permissionPresentation'

const SESSION = 'session-ag'

function seedPending(permission: PendingPermission | null) {
  useChatStore.setState({
    sessions: {
      [SESSION]: {
        messages: [],
        chatState: permission ? 'permission_pending' : 'idle',
        connectionState: 'connected',
        pendingPermission: permission,
        pendingPermissions: permission ? { [permission.requestId]: permission } : {},
      },
    },
  } as never)
}

describe('PermissionDialog Antigravity & Subagent extensions', () => {
  beforeEach(() => {
    sendMock.mockReset()
    useSettingsStore.setState({ locale: 'en' })
    useTabStore.setState({ activeTabId: SESSION, tabs: [{ sessionId: SESSION, title: 'AG', type: 'session', status: 'idle' }] })
    useSessionRuntimeStore.setState({ selections: {} })
    useProviderStore.setState(useProviderStore.getInitialState(), true)
  })

  afterEach(() => {
    cleanup()
  })

  it('renders rich Diff preview for Antigravity edit_file, shows subagent badge, and hides Allow for session when unsupported', () => {
    const permission: PendingPermission = {
      requestId: 'req-edit',
      toolName: 'edit_file',
      toolUseId: 'tool-edit',
      antigravityToolName: 'edit_file',
      subagentName: 'verifier',
      supportsAllowAlways: false,
      input: {
        Path: '/repo/src/index.ts',
        Target: 'const oldVal = 1',
        Replacement: 'const newVal = 2',
      },
    }
    seedPending(permission)

    const { container } = render(
      <PermissionDialog
        sessionId={SESSION}
        requestId={permission.requestId}
        toolName={permission.toolName}
        input={permission.input}
        antigravityToolName={permission.antigravityToolName}
        subagentName={permission.subagentName}
        supportsAllowAlways={permission.supportsAllowAlways}
      />,
    )

    expect(screen.getByTestId('permission-subagent-badge')).toHaveTextContent('From verifier')
    expect(screen.getByTestId('permission-subagent-badge')).toHaveClass('rounded-[var(--radius-sm)]')
    expect(screen.getByTestId('permission-subagent-badge')).not.toHaveClass('rounded-full')
    const awaitingBadge = screen.getByText('Awaiting approval').closest('span')
    expect(awaitingBadge).toHaveClass('rounded-[var(--radius-sm)]')
    expect(awaitingBadge).not.toHaveClass('rounded-full')
    expect(screen.getByText('/repo/src/index.ts').parentElement).toHaveClass('rounded-[var(--radius-card-inner)]')
    expect(container.textContent).toContain('/repo/src/index.ts')
    expect(container.textContent).toContain('+1')
    expect(container.textContent).toContain('−1')
    expect(screen.queryByRole('button', { name: /^Allow for session/ })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /^Allow/ }))
    expect(sendMock).toHaveBeenCalledWith(SESSION, {
      type: 'permission_response',
      requestId: 'req-edit',
      allowed: true,
    })
  })

  it('renders Bash command preview for run_command and sends rule: always when supportsAllowAlways is true', () => {
    const permission: PendingPermission = {
      requestId: 'req-cmd',
      toolName: 'run_command',
      toolUseId: 'tool-cmd',
      antigravityToolName: 'run_command',
      supportsAllowAlways: true,
      input: {
        CommandLine: 'bun test src/acp',
        toolSummary: 'Run ACP tests',
      },
    }
    seedPending(permission)

    render(
      <PermissionDialog
        sessionId={SESSION}
        requestId={permission.requestId}
        toolName={permission.toolName}
        input={permission.input}
        antigravityToolName={permission.antigravityToolName}
        supportsAllowAlways={permission.supportsAllowAlways}
      />,
    )

    const commandText = screen.getByText(/bun test src\/acp/)
    expect(commandText).toBeInTheDocument()
    expect(commandText.closest('div')).toHaveClass('rounded-[var(--radius-card-inner)]')
    fireEvent.click(screen.getByRole('button', { name: /^Allow for session/ }))
    expect(sendMock).toHaveBeenCalledWith(SESSION, {
      type: 'permission_response',
      requestId: 'req-cmd',
      allowed: true,
      rule: 'always',
    })
  })

  it('keeps the subagent badge visible on resolved permission rows', () => {
    seedPending(null)

    render(
      <PermissionDialog
        sessionId={SESSION}
        requestId="req-done"
        toolName="write_file"
        input={{ Path: '/repo/README.md', Content: 'hello' }}
        antigravityToolName="write_file"
        subagentName="docs-worker"
      />,
    )

    expect(screen.getByTestId('permission-subagent-badge')).toHaveTextContent('From docs-worker')
    expect(screen.getByText('Responded')).toBeInTheDocument()
  })

  it('locks ExitPlanMode model switcher to Antigravity and hides bypassPermissions on Antigravity sessions', async () => {
    useProviderStore.setState({
      providers: [],
      activeId: null,
      hasLoadedProviders: true,
      antigravity: {
        id: 'antigravity-acp',
        kind: 'acp',
        status: 'ready',
        models: [
          { id: 'gemini-3.8-pro', name: 'Gemini 3.8 Pro', supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'], defaultReasoningEffort: 'high' },
          { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', supportedReasoningEfforts: ['low', 'medium', 'high'], defaultReasoningEffort: 'medium' },
        ],
        currentModelId: 'gemini-3.8-pro',
      },
    })
    useSessionRuntimeStore.setState({
      selections: {
        [SESSION]: { providerId: 'antigravity-acp', modelId: 'gemini-3.8-pro', effortLevel: 'high' },
      },
    })
    seedPending({
      requestId: 'perm-plan',
      toolName: 'ExitPlanMode',
      toolUseId: 'tool-plan',
      input: { plan: '# AG Plan\n\n1. Ship it.' },
    })

    render(
      <PermissionDialog
        sessionId={SESSION}
        requestId="perm-plan"
        toolName="ExitPlanMode"
        input={{ plan: '# AG Plan\n\n1. Ship it.' }}
      />,
    )

    expect(screen.queryByRole('button', { name: 'Approve & bypass permissions' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Approve & auto-accept edits' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Execution model' }))
    await waitFor(() => {
      expect(screen.getByTestId('model-selector-dropdown')).toBeInTheDocument()
    })
    expect(screen.getByTestId('model-selector-dropdown')).toHaveTextContent('Gemini 3.8 Flash')
    expect(screen.getByTestId('model-selector-dropdown')).not.toHaveTextContent('Claude Official')
  })

  it('defaults actor to Antigravity for Antigravity tools and displays description cleanly', () => {
    const t = (key: string, params?: Record<string, string | number>) => {
      if (key === 'permission.allowEditFile') return `Allow ${params?.actor} to ${params?.toolName} ${params?.fileName}?`
      if (key === 'permission.allowBash') return `Allow ${params?.actor} to run this command?`
      return key
    }

    expect(getPermissionTitle('Edit', { file_path: '/repo/a.ts' }, t as never, undefined, 'replace_file_content'))
      .toBe('Allow Antigravity to Edit a.ts?')
    expect(getPermissionTitle('run_command', { CommandLine: 'ls' }, t as never))
      .toBe('Allow Antigravity to run this command?')
    expect(getPermissionTitle('Bash', { command: 'ls' }, t as never))
      .toBe('Allow Claude to run this command?')
    expect(getPermissionTitle('Bash', { command: 'ls' }, t as never, 'researcher'))
      .toBe('Allow researcher to run this command?')

    const permission: PendingPermission = {
      requestId: 'req-ag-desc',
      toolName: 'Bash',
      toolUseId: 'tool-ag-desc',
      displayName: 'Antigravity',
      description: 'Run unit tests in workspace',
      antigravityToolName: 'run_command',
      input: { CommandLine: 'bun test' },
    }
    seedPending(permission)

    const { rerender } = render(
      <PermissionDialog
        sessionId={SESSION}
        requestId={permission.requestId}
        toolName={permission.toolName}
        input={permission.input}
        displayName={permission.displayName}
        description={permission.description}
        antigravityToolName={permission.antigravityToolName}
      />,
    )

    expect(screen.getByText('Allow Antigravity to run this command?')).toBeInTheDocument()
    expect(screen.getByText('Run unit tests in workspace')).toBeInTheDocument()

    // Even if displayName is omitted on an Antigravity tool, actor still defaults to Antigravity
    act(() => {
      seedPending({ ...permission, displayName: undefined })
    })
    rerender(
      <PermissionDialog
        sessionId={SESSION}
        requestId={permission.requestId}
        toolName={permission.toolName}
        input={permission.input}
        description={permission.description}
        antigravityToolName={permission.antigravityToolName}
      />,
    )
    expect(screen.getByText('Allow Antigravity to run this command?')).toBeInTheDocument()
    expect(screen.getByText('Run unit tests in workspace')).toBeInTheDocument()
  })

  it('does not duplicate description when Bash input description matches header description', () => {
    const permission: PendingPermission = {
      requestId: 'req-ag-dedupe',
      toolName: 'Bash',
      toolUseId: 'tool-ag-dedupe',
      description: 'Check git status',
      antigravityToolName: 'run_command',
      input: {
        CommandLine: 'git status --short',
        command: 'git status --short',
        description: 'Check git status',
        toolSummary: 'Check git status',
      },
    }
    seedPending(permission)

    render(
      <PermissionDialog
        sessionId={SESSION}
        requestId={permission.requestId}
        toolName={permission.toolName}
        input={permission.input}
        description={permission.description}
        antigravityToolName={permission.antigravityToolName}
      />,
    )

    expect(screen.getAllByText('Check git status')).toHaveLength(1)
    expect(screen.getByText('git status --short')).toBeInTheDocument()
  })
})
