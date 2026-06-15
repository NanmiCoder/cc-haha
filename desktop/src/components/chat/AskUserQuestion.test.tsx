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

vi.mock('../../api/sessions', () => ({
  sessionsApi: {
    getMessages: vi.fn(async () => ({ messages: [] })),
    getSlashCommands: vi.fn(async () => ({ commands: [] })),
  },
}))

import { AskUserQuestion } from './AskUserQuestion'
import { useChatStore } from '../../stores/chatStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useTabStore } from '../../stores/tabStore'

const ACTIVE_TAB = 'active-tab'

describe('AskUserQuestion', () => {
  beforeEach(() => {
    sendMock.mockReset()
    useSettingsStore.setState({ locale: 'en' })
    useTabStore.setState({
      activeTabId: ACTIVE_TAB,
      tabs: [{ sessionId: ACTIVE_TAB, title: 'Test', type: 'session', status: 'idle' }],
    })
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: {
          messages: [],
          chatState: 'permission_pending',
          connectionState: 'connected',
          streamingText: '',
          streamingToolInput: '',
          activeToolUseId: null,
          activeToolName: null,
          activeThinkingId: null,
          pendingPermission: {
            requestId: 'perm-1',
            toolName: 'AskUserQuestion',
            toolUseId: 'tool-1',
            input: {
              questions: [
                {
                  question: 'Should we persist data?',
                  options: [{ label: 'No' }, { label: 'Yes' }],
                },
              ],
            },
          },
          pendingComputerUsePermission: null,
          tokenUsage: { input_tokens: 0, output_tokens: 0 },
          streamingResponseChars: 0,
          elapsedSeconds: 0,
          statusVerb: '',
          slashCommands: [],
          agentTaskNotifications: {},
          elapsedTimer: null,
        },
      },
    })
  })

  it('submits answers through permission_response updatedInput instead of sending a chat message', () => {
    render(
      <AskUserQuestion
        toolUseId="tool-1"
        input={{
          questions: [
            {
              question: 'Should we persist data?',
              options: [{ label: 'No' }, { label: 'Yes' }],
            },
          ],
        }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /^No$/ }))
    fireEvent.click(screen.getByRole('button', { name: /submit/i }))

    expect(sendMock).toHaveBeenCalledWith(ACTIVE_TAB, {
      type: 'permission_response',
      requestId: 'perm-1',
      allowed: true,
      updatedInput: {
        questions: [
          {
            question: 'Should we persist data?',
            options: [{ label: 'No' }, { label: 'Yes' }],
          },
        ],
        answers: {
          'Should we persist data?': 'No',
        },
      },
    })
  })

  it('allows multiple selections when a question is marked multiSelect', () => {
    render(
      <AskUserQuestion
        toolUseId="tool-1"
        input={{
          questions: [
            {
              question: 'Which tasks should run?',
              multiSelect: true,
              options: [
                { label: 'Lint' },
                { label: 'Tests' },
                { label: 'Build' },
              ],
            },
          ],
        }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /^Lint$/ }))
    fireEvent.click(screen.getByRole('button', { name: /^Tests$/ }))
    fireEvent.click(screen.getByRole('button', { name: /submit/i }))

    expect(sendMock).toHaveBeenCalledWith(ACTIVE_TAB, {
      type: 'permission_response',
      requestId: 'perm-1',
      allowed: true,
      updatedInput: {
        questions: [
          {
            question: 'Which tasks should run?',
            multiSelect: true,
            options: [
              { label: 'Lint' },
              { label: 'Tests' },
              { label: 'Build' },
            ],
          },
        ],
        answers: {
          'Which tasks should run?': 'Lint, Tests',
        },
      },
    })
  })

  it('preserves multiSelect for single-question input shape', () => {
    render(
      <AskUserQuestion
        toolUseId="tool-1"
        input={{
          question: 'Which tasks should run?',
          multiSelect: true,
          options: [
            { label: 'Lint' },
            { label: 'Tests' },
            { label: 'Build' },
          ],
        }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /^Lint$/ }))
    fireEvent.click(screen.getByRole('button', { name: /^Tests$/ }))
    fireEvent.click(screen.getByRole('button', { name: /submit/i }))

    expect(sendMock).toHaveBeenCalledWith(ACTIVE_TAB, {
      type: 'permission_response',
      requestId: 'perm-1',
      allowed: true,
      updatedInput: {
        question: 'Which tasks should run?',
        multiSelect: true,
        options: [
          { label: 'Lint' },
          { label: 'Tests' },
          { label: 'Build' },
        ],
        answers: {
          'Which tasks should run?': 'Lint, Tests',
        },
      },
    })
  })

  it('responds to the provided session instead of the active tab', () => {
    useTabStore.setState({
      activeTabId: 'other-tab',
      tabs: [
        { sessionId: 'other-tab', title: 'Other', type: 'session', status: 'idle' },
        { sessionId: 'target-tab', title: 'Target', type: 'session', status: 'idle' },
      ],
    })
    useChatStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        'target-tab': {
          ...state.sessions[ACTIVE_TAB]!,
          pendingPermission: {
            requestId: 'perm-target',
            toolName: 'AskUserQuestion',
            toolUseId: 'tool-target',
            input: {
              questions: [
                {
                  question: 'Run tests?',
                  options: [{ label: 'No' }, { label: 'Yes' }],
                },
              ],
            },
          },
        },
      },
    }))

    render(
      <AskUserQuestion
        sessionId="target-tab"
        toolUseId="tool-target"
        input={{
          questions: [
            {
              question: 'Run tests?',
              options: [{ label: 'No' }, { label: 'Yes' }],
            },
          ],
        }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /^Yes$/ }))
    fireEvent.click(screen.getByRole('button', { name: /submit/i }))

    expect(sendMock).toHaveBeenCalledWith('target-tab', {
      type: 'permission_response',
      requestId: 'perm-target',
      allowed: true,
      updatedInput: {
        questions: [
          {
            question: 'Run tests?',
            options: [{ label: 'No' }, { label: 'Yes' }],
          },
        ],
        answers: {
          'Run tests?': 'Yes',
        },
      },
    })
  })

  it('keeps custom responses scoped to each question tab', () => {
    const input = {
      questions: [
        {
          header: 'Q1',
          question: 'First question?',
          options: [{ label: 'A1' }, { label: 'B1' }],
        },
        {
          header: 'Q2',
          question: 'Second question?',
          options: [{ label: 'A2' }, { label: 'B2' }],
        },
      ],
    }

    render(
      <AskUserQuestion
        toolUseId="tool-1"
        input={input}
      />,
    )

    fireEvent.change(screen.getByPlaceholderText('Type your answer...'), {
      target: { value: 'transient-q1' },
    })
    fireEvent.change(screen.getByPlaceholderText('Type your answer...'), {
      target: { value: '' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^A1$/ }))
    fireEvent.change(screen.getByPlaceholderText('Type your answer...'), {
      target: { value: 'custom-q1' },
    })
    fireEvent.click(screen.getByRole('button', { name: /Q2$/ }))

    expect((screen.getByPlaceholderText('Type your answer...') as HTMLTextAreaElement).value).toBe('')

    fireEvent.click(screen.getByRole('button', { name: /^A2$/ }))
    fireEvent.click(screen.getByRole('button', { name: /Q1$/ }))

    expect((screen.getByPlaceholderText('Type your answer...') as HTMLTextAreaElement).value).toBe('custom-q1')

    fireEvent.click(screen.getByRole('button', { name: /submit/i }))

    expect(sendMock).toHaveBeenCalledWith(ACTIVE_TAB, {
      type: 'permission_response',
      requestId: 'perm-1',
      allowed: true,
      updatedInput: {
        ...input,
        answers: {
          'First question?': 'custom-q1',
          'Second question?': 'A2',
        },
      },
    })
  })

  it('uses a multiline custom response box and submits it with Ctrl+Enter', () => {
    render(
      <AskUserQuestion
        toolUseId="tool-1"
        input={{
          questions: [
            {
              question: 'What context should we restore?',
              options: [{ label: 'Skip' }],
            },
          ],
        }}
      />,
    )

    const textarea = screen.getByPlaceholderText('Type your answer...')
    expect(textarea.tagName).toBe('TEXTAREA')
    expect(textarea.getAttribute('rows')).toBe('3')

    fireEvent.change(textarea, {
      target: { value: 'First restored context line\nSecond restored context line' },
    })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(sendMock).not.toHaveBeenCalled()

    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true })

    expect(sendMock).toHaveBeenCalledWith(ACTIVE_TAB, {
      type: 'permission_response',
      requestId: 'perm-1',
      allowed: true,
      updatedInput: {
        questions: [
          {
            question: 'What context should we restore?',
            options: [{ label: 'Skip' }],
          },
        ],
        answers: {
          'What context should we restore?': 'First restored context line\nSecond restored context line',
        },
      },
    })
  })

  it('renders aborted permission results as terminal instead of asking again', () => {
    useChatStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [ACTIVE_TAB]: {
          ...state.sessions[ACTIVE_TAB]!,
          pendingPermission: null,
          chatState: 'idle',
        },
      },
    }))

    render(
      <AskUserQuestion
        toolUseId="tool-1"
        input={{
          questions: [
            {
              question: 'Which scope?',
              options: [{ label: 'Single page' }, { label: 'Tabs' }],
            },
          ],
        }}
        result="Tool permission request failed: AbortError"
      />,
    )

    expect(screen.queryByPlaceholderText('Type your answer...')).toBeNull()
    expect(screen.queryByRole('button', { name: /submit/i })).toBeNull()
    expect(screen.getByText(/Tool permission request failed: AbortError/)).toBeTruthy()
  })
})
