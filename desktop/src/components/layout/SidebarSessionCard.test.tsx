import { fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { describe, expect, it, vi } from 'vitest'
import { SidebarSessionCard } from './SidebarSessionCard'
import type { SessionListItem } from '@/types/session'
import type { TranslationKey } from '@/i18n'

vi.mock('@/components/tasks/SessionScheduleMark', () => ({
  SessionScheduleMark: () => null,
}))

const t = (key: TranslationKey, params?: Record<string, string | number>) => {
  const dict: Partial<Record<TranslationKey, string>> = {
    'tabs.untitled': 'Untitled',
    'sidebar.worktree': 'worktree',
    'sidebar.missingDir': 'Directory missing',
    'sidebar.sessionRunning': 'Session running',
    'sidebar.sessionNeedsAttention': 'Waiting for your approval',
    'sidebar.sessionStatus.attention': 'Needs you',
    'session.lastUpdated': 'last updated {time}',
    'tasks.moreActions': 'More actions',
  }
  const raw = dict[key] ?? key
  if (!params) return raw
  return Object.entries(params).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    raw,
  )
}

function makeSession(overrides: Partial<SessionListItem> = {}): SessionListItem {
  return {
    id: 'session-1',
    title: 'Fix sidebar layout',
    createdAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    modifiedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    messageCount: 3,
    projectPath: '/workspace/alpha',
    projectRoot: '/workspace/alpha',
    workDir: '/workspace/alpha',
    workDirExists: true,
    ...overrides,
  }
}

describe('SidebarSessionCard', () => {
  it('renders a compact project thread card without a metadata row when empty', () => {
    const onClick = vi.fn()
    const onOpenMenu = vi.fn()
    render(
      <div className="group/session-row relative mb-px">
        <SidebarSessionCard
          session={makeSession()}
          variant="project"
          isActive
          isSelected={false}
          isRunning={false}
          needsAttention={false}
          isBatchMode={false}
          onClick={onClick}
          onContextMenu={vi.fn()}
          onOpenMenu={onOpenMenu}
          t={t}
        />
      </div>,
    )

    const row = screen.getByRole('button', { name: /Fix sidebar layout/ })
    expect(row).toHaveClass('pl-8', 'sidebar-session-row--active')
    expect(within(row).queryByText('worktree')).not.toBeInTheDocument()
    expect(within(row).queryByText('Directory missing')).not.toBeInTheDocument()

    // Hover action swap trigger uses Safari 15-safe focus-within and opens menu without firing row click.
    const more = screen.getByRole('button', { name: 'More actions' })
    expect(more.parentElement).toHaveClass('group-hover/session-row:opacity-100', 'group-focus-within/session-row:opacity-100')
    expect(more.parentElement?.className).not.toContain('has-[')
    fireEvent.click(more)
    expect(onOpenMenu).toHaveBeenCalledTimes(1)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('expands the adaptive metadata row for worktree and missing-directory sessions in task view', () => {
    render(
      <div className="group/session-row relative mb-px">
        <SidebarSessionCard
          session={makeSession({
            workDir: '/workspace/alpha/.claude/worktrees/ui-texture',
            workDirExists: false,
            workspaceState: 'missing',
          })}
          variant="task"
          workspaceLabel="alpha"
          isActive={false}
          isSelected={false}
          isRunning
          needsAttention={false}
          isBatchMode={false}
          onClick={vi.fn()}
          onContextMenu={vi.fn()}
          t={t}
        />
      </div>,
    )

    const row = screen.getByRole('button', { name: /^Fix sidebar layout/ })
    expect(within(row).getByText('alpha')).toBeInTheDocument()
    expect(within(row).getByText('ui-texture')).toBeInTheDocument()
    expect(within(row).getByText('worktree')).toHaveClass('sr-only')
    expect(within(row).getByText('Directory missing')).toBeInTheDocument()
    expect(within(row).getByLabelText('Session running')).toBeInTheDocument()
  })

  it('keeps the attention badge visible without mounting a competing hover swap button', () => {
    render(
      <div className="group/session-row relative mb-px">
        <SidebarSessionCard
          session={makeSession()}
          variant="project"
          isActive={false}
          isSelected={false}
          isRunning
          needsAttention
          isBatchMode={false}
          onClick={vi.fn()}
          onContextMenu={vi.fn()}
          onOpenMenu={vi.fn()}
          t={t}
        />
      </div>,
    )

    expect(screen.getByLabelText('Waiting for your approval')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'More actions' })).not.toBeInTheDocument()
  })

  it('shows a subtle Antigravity badge only on antigravity-acp sessions', () => {
    const { rerender } = render(
      <div className="group/session-row relative mb-px">
        <SidebarSessionCard
          session={makeSession({ runtimeProviderId: null })}
          variant="project"
          isActive={false}
          isSelected={false}
          isRunning={false}
          needsAttention={false}
          isBatchMode={false}
          onClick={vi.fn()}
          onContextMenu={vi.fn()}
          t={t}
        />
      </div>,
    )
    expect(screen.queryByTestId('sidebar-antigravity-badge')).not.toBeInTheDocument()

    rerender(
      <div className="group/session-row relative mb-px">
        <SidebarSessionCard
          session={makeSession({ runtimeProviderId: 'antigravity-acp' })}
          variant="project"
          isActive={false}
          isSelected={false}
          isRunning={false}
          needsAttention={false}
          isBatchMode={false}
          onClick={vi.fn()}
          onContextMenu={vi.fn()}
          t={t}
        />
      </div>,
    )
    expect(screen.getByTestId('sidebar-antigravity-badge')).toBeInTheDocument()
  })
})
