import '@testing-library/jest-dom'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TrajectoryStopButton } from './TrajectoryStopButton'
import { createDefaultSessionState, useChatStore } from '../../stores/chatStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useTabStore } from '../../stores/tabStore'
import type { BackgroundAgentTask } from '../../types/chat'

const ID = 'trajectory-stop'
const originalStop = useChatStore.getState().stopGeneration

function seed(patch: Partial<ReturnType<typeof createDefaultSessionState>>) {
  useChatStore.setState({ sessions: { [ID]: { ...createDefaultSessionState(), ...patch } } })
}

function runningTask(taskType: string): Record<string, BackgroundAgentTask> {
  return { task: { taskId: 'task', taskType, status: 'running', startedAt: 1, updatedAt: 1 } }
}

describe('TrajectoryStopButton', () => {
  const stopGeneration = vi.fn()

  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
    useTabStore.setState({ activeTabId: ID, tabs: [{ sessionId: ID, title: 'Main', type: 'session', status: 'idle' }] })
    useChatStore.setState({ stopGeneration })
  })

  afterEach(() => {
    stopGeneration.mockReset()
    useChatStore.setState({ sessions: {}, stopGeneration: originalStop })
    useTabStore.setState({ tabs: [], activeTabId: null })
  })

  it('appears while the turn runs, stops that session, and leaves when the turn ends', () => {
    seed({ chatState: 'idle' })
    render(<TrajectoryStopButton sessionId={ID} />)
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument()

    act(() => seed({ chatState: 'tool_executing' }))
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(stopGeneration).toHaveBeenCalledTimes(1)
    expect(stopGeneration).toHaveBeenCalledWith(ID)

    act(() => seed({ chatState: 'idle' }))
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument()
  })

  it('offers Stop for running background agents but not for a shell task', () => {
    seed({ chatState: 'idle', backgroundAgentTasks: runningTask('local_bash') })
    render(<TrajectoryStopButton sessionId={ID} />)
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument()

    act(() => seed({ chatState: 'idle', backgroundAgentTasks: runningTask('local_agent') }))
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument()
  })

  it('never offers Stop in a subagent tab, which its lead owns', () => {
    useTabStore.setState({ activeTabId: ID, tabs: [{ sessionId: ID, title: 'Sub', type: 'subagent', status: 'idle' }] })
    seed({ chatState: 'streaming' })
    render(<TrajectoryStopButton sessionId={ID} />)
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument()
  })
})
