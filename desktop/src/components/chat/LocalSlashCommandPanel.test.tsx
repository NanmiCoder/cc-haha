import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'

const { sessionsApiMock, skillsApiMock } = vi.hoisted(() => ({
  sessionsApiMock: {
    getInspection: vi.fn(),
  },
  skillsApiMock: {
    list: vi.fn(),
  },
}))

vi.mock('../../api/sessions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/sessions')>()
  return {
    ...actual,
    sessionsApi: {
      getInspection: sessionsApiMock.getInspection,
    },
  }
})

vi.mock('../../api/skills', () => ({
  skillsApi: {
    list: skillsApiMock.list,
  },
}))

import { LocalSlashCommandPanel } from './LocalSlashCommandPanel'
import { useSettingsStore } from '../../stores/settingsStore'
import { useTabStore, SETTINGS_TAB_ID } from '../../stores/tabStore'
import { useUIStore } from '../../stores/uiStore'
import { useSkillStore } from '../../stores/skillStore'
import type { SessionContextSnapshot, SessionInspectionResponse } from '../../api/sessions'

const baseContext: SessionContextSnapshot = {
  categories: [
    {
      name: 'memory',
      tokens: 120,
      color: '#14b8a6',
    },
  ],
  totalTokens: 120,
  maxTokens: 200000,
  rawMaxTokens: 200000,
  percentage: 0.06,
  gridRows: [],
  model: 'Claude Test',
  memoryFiles: [],
  mcpTools: [],
  agents: [],
  messageBreakdown: {
    toolCallTokens: 0,
    toolResultTokens: 0,
    attachmentTokens: 0,
    assistantMessageTokens: 0,
    userMessageTokens: 0,
    toolCallsByType: [],
    attachmentsByType: [],
  },
}

const baseInspection: SessionInspectionResponse = {
  active: true,
  status: {
    sessionId: 'session-1',
    workDir: '/workspace/demo',
    permissionMode: 'default',
    model: 'Claude Test',
    tools: [],
    mcpServers: [],
  },
}

function inspectionWithContext(context: SessionContextSnapshot): SessionInspectionResponse {
  return { ...baseInspection, context }
}

describe('LocalSlashCommandPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sessionsApiMock.getInspection.mockReset()
    useSettingsStore.setState({ locale: 'en' })
    useTabStore.setState(useTabStore.getInitialState(), true)
    useUIStore.setState({
      pendingMemoryPath: null,
      pendingSettingsTab: null,
    })
    useSkillStore.setState({
      skills: [],
      selectedSkill: null,
      selectedSkillReturnTab: 'skills',
      isLoading: false,
      isDetailLoading: false,
      error: null,
      fetchSkills: vi.fn(),
      fetchSkillDetail: vi.fn().mockResolvedValue(undefined),
      clearSelection: vi.fn(),
    })
  })

  it('loads status independently of historical usage and context', async () => {
    const usageError = 'Transcript inspection contains records above the semantic read limit'
    sessionsApiMock.getInspection
      .mockResolvedValueOnce({
        ...baseInspection,
        status: { ...baseInspection.status, contextWindow: 1_000_000 },
      })
      .mockResolvedValueOnce({ ...baseInspection, active: false, errors: { usage: usageError } })
      .mockResolvedValueOnce({ ...baseInspection, active: false, contextEstimate: baseContext })

    render(<LocalSlashCommandPanel command="status" sessionId="session-1" onClose={vi.fn()} />)

    expect(await screen.findByText('Claude Test')).toBeInTheDocument()
    expect(sessionsApiMock.getInspection).toHaveBeenCalledExactlyOnceWith('session-1', {
      statusOnly: true,
      signal: expect.any(AbortSignal),
    })
    expect(screen.getByText('Context window: 1,000,000')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: 'Usage' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(usageError)
    expect(sessionsApiMock.getInspection).toHaveBeenNthCalledWith(2, 'session-1', {
      includeContext: false,
      signal: expect.any(AbortSignal),
    })

    fireEvent.click(screen.getByRole('tab', { name: 'Context' }))
    expect(await screen.findByText('Memory files')).toBeInTheDocument()
    expect(sessionsApiMock.getInspection).toHaveBeenNthCalledWith(3, 'session-1', {
      includeContext: true,
      contextOnly: true,
      timeout: 45_000,
      signal: expect.any(AbortSignal),
    })

    fireEvent.click(screen.getByRole('tab', { name: 'Status' }))
    expect(screen.getByText('Context window: 1,000,000')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(sessionsApiMock.getInspection).toHaveBeenCalledTimes(3)
  })

  it('discards in-flight inspection results when switching tabs or sessions', async () => {
    let resolveOldUsage!: (value: SessionInspectionResponse) => void
    let resolveOldContext!: (value: SessionInspectionResponse) => void
    sessionsApiMock.getInspection
      .mockReturnValueOnce(new Promise<SessionInspectionResponse>(resolve => { resolveOldUsage = resolve }))
      .mockReturnValueOnce(new Promise<SessionInspectionResponse>(resolve => { resolveOldContext = resolve }))
      .mockResolvedValueOnce({
        ...baseInspection,
        status: { ...baseInspection.status, sessionId: 'session-2' },
        errors: { usage: 'Current usage message' },
      })

    const onClose = vi.fn()
    const { rerender } = render(<LocalSlashCommandPanel command="cost" sessionId="session-1" onClose={onClose} />)
    expect(sessionsApiMock.getInspection).toHaveBeenCalledExactlyOnceWith('session-1', {
      includeContext: false,
      signal: expect.any(AbortSignal),
    })
    const usageSignal = sessionsApiMock.getInspection.mock.calls[0]?.[1].signal

    fireEvent.click(screen.getByRole('tab', { name: 'Context' }))
    expect(usageSignal.aborted).toBe(true)
    expect(sessionsApiMock.getInspection).toHaveBeenCalledTimes(2)
    const contextSignal = sessionsApiMock.getInspection.mock.calls[1]?.[1].signal

    rerender(<LocalSlashCommandPanel command="cost" sessionId="session-2" onClose={onClose} />)
    expect(contextSignal.aborted).toBe(true)
    expect(await screen.findByRole('alert')).toHaveTextContent('Current usage message')
    expect(sessionsApiMock.getInspection).toHaveBeenNthCalledWith(3, 'session-2', {
      includeContext: false,
      signal: expect.any(AbortSignal),
    })

    await act(async () => {
      resolveOldUsage({ ...baseInspection, errors: { usage: 'Stale usage message' } })
      resolveOldContext(inspectionWithContext(baseContext))
    })
    expect(screen.getByRole('alert')).toHaveTextContent('Current usage message')
    expect(screen.queryByText('Memory files')).not.toBeInTheDocument()
  })

  it('shows loaded memory files and opens the selected project memory in settings', async () => {
    sessionsApiMock.getInspection.mockResolvedValue(inspectionWithContext({
      ...baseContext,
      memoryFiles: [
        {
          path: '/Users/test/.claude/projects/demo/memory/MEMORY.md',
          type: 'project',
          tokens: 4321,
        },
        {
          path: '/Users/test/.claude/projects/demo/memory/feedback/reuse.md',
          type: 'feedback',
          tokens: 98,
        },
      ],
    }))

    render(
      <LocalSlashCommandPanel
        command="context"
        sessionId="session-1"
        onClose={vi.fn()}
      />,
    )

    expect(await screen.findByText('Memory files')).toBeInTheDocument()
    expect(sessionsApiMock.getInspection).toHaveBeenCalledExactlyOnceWith('session-1', {
      includeContext: true,
      contextOnly: true,
      timeout: 45_000,
      signal: expect.any(AbortSignal),
    })
    expect(screen.getByText('MEMORY.md')).toBeInTheDocument()
    expect(screen.getByText('/Users/test/.claude/projects/demo/memory/MEMORY.md')).toBeInTheDocument()
    expect(screen.getByText('feedback')).toBeInTheDocument()
    expect(screen.getByText('4,321 tokens')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Open Memory' }))

    await waitFor(() => {
      expect(useUIStore.getState().pendingSettingsTab).toBe('memory')
      expect(useUIStore.getState().pendingMemoryPath).toBe('/Users/test/.claude/projects/demo/memory/MEMORY.md')
      expect(useTabStore.getState().activeTabId).toBe(SETTINGS_TAB_ID)
    })
  })

  it('keeps the memory settings entry available when no memory files are loaded', async () => {
    sessionsApiMock.getInspection.mockResolvedValue(inspectionWithContext({
      ...baseContext,
      memoryFiles: [],
    }))

    render(
      <LocalSlashCommandPanel
        command="context"
        sessionId="session-1"
        onClose={vi.fn()}
      />,
    )

    expect(await screen.findByText('No memory files are loaded in this session.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Open Memory' }))

    await waitFor(() => {
      expect(useUIStore.getState().pendingSettingsTab).toBe('memory')
      expect(useUIStore.getState().pendingMemoryPath).toBeNull()
      expect(useTabStore.getState().activeTabId).toBe(SETTINGS_TAB_ID)
    })
  })

  it('opens skill details in the unified Skill Center', async () => {
    const onClose = vi.fn()
    const fetchSkillDetail = vi.fn().mockResolvedValue(undefined)
    useSkillStore.setState({ fetchSkillDetail })
    skillsApiMock.list.mockResolvedValue({
      skills: [{
        name: 'ppt-generator',
        displayName: 'PPT Generator',
        description: 'Create slide decks.',
        source: 'user',
        userInvocable: true,
        contentLength: 100,
        hasDirectory: true,
      }],
    })

    render(
      <LocalSlashCommandPanel
        command="skills"
        cwd="/workspace/demo"
        onClose={onClose}
      />,
    )

    fireEvent.click(await screen.findByText('/ppt-generator'))

    await waitFor(() => {
      expect(fetchSkillDetail).toHaveBeenCalledWith('user', 'ppt-generator', '/workspace/demo', 'skills')
      expect(useTabStore.getState().activeTabId).toBe(SETTINGS_TAB_ID)
    })
    expect(useUIStore.getState().pendingSettingsTab).toBe('skills')
    expect(onClose).toHaveBeenCalled()
  })
})
