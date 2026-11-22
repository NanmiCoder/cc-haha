import { act, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../api/websocket', () => ({
  wsManager: {
    connect: vi.fn(),
    disconnect: vi.fn(),
    onConnectionState: vi.fn(() => () => {}),
    onMessage: vi.fn(() => () => {}),
    clearHandlers: vi.fn(),
    send: vi.fn(),
  },
}))

import { useChatStore, type PendingPermission } from '../../stores/chatStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useTabStore } from '../../stores/tabStore'
import { MobileApprovalDock } from './MobileApprovalDock'
import { PermissionDialog } from './PermissionDialog'

const SESSION = 'session-1'
const respondToPermission = vi.fn()

const bash: PendingPermission = {
  requestId: 'perm-bash',
  toolName: 'Bash',
  toolUseId: 'toolu-bash',
  input: { command: 'bun run build', description: 'Build the app' },
}
const edit: PendingPermission = {
  requestId: 'perm-edit',
  toolName: 'Edit',
  toolUseId: 'toolu-edit',
  input: { file_path: '/repo/src/LoginForm.tsx', old_string: 'a', new_string: 'b' },
}
const question: PendingPermission = {
  requestId: 'perm-question',
  toolName: 'AskUserQuestion',
  toolUseId: 'toolu-question',
  input: {
    questions: [{
      question: 'Which channel should the release go to?',
      header: 'Channel',
      options: [{ label: 'Stable' }, { label: 'Beta' }],
    }],
  },
}
const plan: PendingPermission = {
  requestId: 'perm-plan',
  toolName: 'ExitPlanMode',
  toolUseId: 'toolu-plan',
  input: { plan: '# Plan\n\n1. Split the dialog.', allowedPrompts: [] },
  description: 'Exit plan mode?',
}

function seed(pending: PendingPermission[]) {
  useChatStore.setState({
    respondToPermission,
    sessions: {
      [SESSION]: {
        messages: [],
        chatState: 'permission_pending',
        connectionState: 'connected',
        pendingPermission: pending[0] ?? null,
        pendingPermissions: Object.fromEntries(pending.map((request) => [request.requestId, request])),
      },
    },
  } as never)
}

describe('MobileApprovalDock', () => {
  beforeEach(() => {
    respondToPermission.mockReset()
    useSettingsStore.setState({ locale: 'en' })
    useTabStore.setState({ activeTabId: SESSION, tabs: [] })
  })

  it('answers a tool request in one tap from where the composer was', () => {
    seed([bash])
    render(<MobileApprovalDock sessionId={SESSION} />)

    const dock = screen.getByTestId('mobile-approval-dock')
    expect(dock).toHaveAttribute('data-kind', 'tool')
    expect(dock).toHaveTextContent('bun run build')

    fireEvent.click(within(dock).getByRole('button', { name: 'Allow' }))
    expect(respondToPermission).toHaveBeenLastCalledWith(SESSION, 'perm-bash', true)

    fireEvent.click(within(dock).getByRole('button', { name: 'Deny' }))
    expect(respondToPermission).toHaveBeenLastCalledWith(SESSION, 'perm-bash', false)

    fireEvent.click(within(dock).getByRole('button', { name: 'Allow for session' }))
    expect(respondToPermission).toHaveBeenLastCalledWith(SESSION, 'perm-bash', true, { rule: 'always' })
  })

  it('denies with the reason the person types, which reaches the model', () => {
    seed([bash])
    render(<MobileApprovalDock sessionId={SESSION} />)

    fireEvent.click(screen.getByRole('button', { name: 'Deny and tell Claude why' }))
    const field = screen.getByLabelText('Reason for denying')
    fireEvent.change(field, { target: { value: 'Run the tests first' } })
    fireEvent.click(screen.getByRole('button', { name: 'Deny with this reason' }))

    expect(respondToPermission).toHaveBeenCalledWith(SESSION, 'perm-bash', false, { denyMessage: 'Run the tests first' })
  })

  it('works through queued requests in arrival order and says how many wait', () => {
    seed([bash, edit])
    const { rerender } = render(<MobileApprovalDock sessionId={SESSION} />)

    expect(screen.getByTestId('mobile-approval-dock')).toHaveTextContent('1 of 2')
    expect(screen.getByTestId('mobile-approval-dock')).toHaveTextContent('bun run build')

    act(() => seed([edit]))
    rerender(<MobileApprovalDock sessionId={SESSION} />)
    expect(screen.getByTestId('mobile-approval-dock')).toHaveTextContent('/repo/src/LoginForm.tsx')
    expect(screen.getByTestId('mobile-approval-dock')).not.toHaveTextContent('of 2')
  })

  it('opens the full card in a sheet to read an edit before allowing it', () => {
    seed([edit])
    render(<MobileApprovalDock sessionId={SESSION} />)

    fireEvent.click(screen.getByRole('button', { name: 'View details' }))
    const sheet = screen.getByTestId('mobile-approval-sheet')
    // The full card, with the same Allow the dock has.
    expect(within(sheet).getByRole('button', { name: /^Allow: / })).toBeInTheDocument()
  })

  it('opens a question in a sheet instead of squeezing it into the bar', () => {
    seed([question])
    render(<MobileApprovalDock sessionId={SESSION} />)

    const dock = screen.getByTestId('mobile-approval-dock')
    expect(dock).toHaveAttribute('data-kind', 'question')
    expect(dock).toHaveTextContent('Which channel should the release go to?')
    expect(within(dock).queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument()

    fireEvent.click(within(dock).getByRole('button', { name: 'Answer' }))
    expect(within(screen.getByTestId('mobile-approval-sheet')).getByText('Stable')).toBeInTheDocument()
  })

  it('sends a plan to a full-height sheet to review', () => {
    seed([plan])
    render(<MobileApprovalDock sessionId={SESSION} />)

    expect(screen.getByTestId('mobile-approval-dock')).toHaveAttribute('data-kind', 'plan')
    fireEvent.click(screen.getByRole('button', { name: 'Review the plan' }))
    expect(within(screen.getByTestId('mobile-approval-sheet')).getByText('Split the dialog.')).toBeInTheDocument()
  })

  it('goes away once nothing is waiting', () => {
    seed([])
    render(<MobileApprovalDock sessionId={SESSION} />)
    expect(screen.queryByTestId('mobile-approval-dock')).not.toBeInTheDocument()
  })
})

describe('PermissionDialog marker mode', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
    useTabStore.setState({ activeTabId: SESSION, tabs: [] })
  })

  it('leaves one marker line in the transcript while the dock holds the live card', () => {
    seed([bash])
    render(<PermissionDialog sessionId={SESSION} requestId="perm-bash" toolName="Bash" input={bash.input} markerWhenPending />)

    expect(screen.getByTestId('pending-decision-marker')).toHaveTextContent('Answer below')
    expect(screen.queryByRole('button', { name: /^Allow: / })).not.toBeInTheDocument()
  })

  it('goes back to the answered row once the request is resolved', () => {
    seed([])
    render(<PermissionDialog sessionId={SESSION} requestId="perm-bash" toolName="Bash" input={bash.input} markerWhenPending />)

    expect(screen.queryByTestId('pending-decision-marker')).not.toBeInTheDocument()
    expect(screen.getByText('Responded')).toBeInTheDocument()
  })
})
