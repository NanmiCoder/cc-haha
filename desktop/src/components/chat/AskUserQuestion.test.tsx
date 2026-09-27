import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'

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

vi.mock('../../api/sessions', () => ({
  sessionsApi: {
    getMessages: vi.fn(async () => ({ messages: [] })),
    getSlashCommands: vi.fn(async () => ({ commands: [] })),
  },
}))

import { AskUserQuestion } from './AskUserQuestion'
import { useChatStore, type PerSessionState } from '../../stores/chatStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useTabStore } from '../../stores/tabStore'

const ACTIVE_TAB = 'active-tab'

function patchSession(patch: Partial<PerSessionState>) {
  useChatStore.setState((state) => ({
    sessions: {
      ...state.sessions,
      [ACTIVE_TAB]: { ...state.sessions[ACTIVE_TAB]!, ...patch },
    },
  }))
}

describe('AskUserQuestion', () => {
  beforeEach(() => {
    sendMock.mockReset()
    useSettingsStore.setState({ locale: 'en' })
    useTabStore.setState({
      activeTabId: ACTIVE_TAB,
      tabs: [{ sessionId: ACTIVE_TAB, title: 'Test', type: 'session', status: 'idle' }],
    })
    useChatStore.setState({
      // Drafts live outside `sessions`; without this they survive into the next
      // test and a handed-off one would render every later card as terminal.
      askUserQuestionDrafts: {},
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

  it('labels a completed timeout answer as automatic', () => {
    render(<AskUserQuestion
      toolUseId="tool-1"
      input={{ question: 'Ship it?', options: [{ label: 'Yes' }, { label: 'No' }] }}
      result={{ answers: { 'Ship it?': 'Yes' }, selectionSource: 'automatic' }}
    />)

    expect(screen.getByText('Answered automatically')).toBeTruthy()
  })

  // Regression: the "no questions" early return used to sit above two useMemo calls,
  // so a mounted instance whose question count crossed zero threw "Rendered fewer/more
  // hooks than expected" and took the surrounding message list down with it. `input` is
  // not stable for the lifetime of the instance — chatStore rebuilds tool_use messages
  // from the transcript under a stable id — so both directions are reachable.
  //
  // These assert on rendering rather than on hook counts, which is what a reader can
  // check: if the early return moves back above a hook, React throws during rerender.
  describe('hook order across a changing question count', () => {
    const ONE_QUESTION = { question: 'Ship it?', options: [{ label: 'Yes' }, { label: 'No' }] }

    it('survives input gaining questions after rendering with none', () => {
      const { rerender } = render(<AskUserQuestion toolUseId="tool-1" input={{}} />)

      rerender(<AskUserQuestion toolUseId="tool-1" input={ONE_QUESTION} />)

      expect(screen.getByText('Ship it?')).toBeTruthy()
    })

    it('survives input losing its questions while mounted', () => {
      const { container, rerender } = render(
        <AskUserQuestion toolUseId="tool-1" input={ONE_QUESTION} />,
      )
      expect(screen.getByText('Ship it?')).toBeTruthy()

      rerender(<AskUserQuestion toolUseId="tool-1" input={{}} />)

      expect(container.textContent).toBe('')
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

  it('reports the first user interaction once so the server cancels automatic answering', () => {
    render(<AskUserQuestion
      toolUseId="tool-1"
      input={{ question: 'Ship it?', options: [{ label: 'Yes' }, { label: 'No' }] }}
    />)

    fireEvent.click(screen.getByRole('button', { name: /^Yes$/ }))
    fireEvent.click(screen.getByRole('button', { name: /^No$/ }))

    expect(sendMock.mock.calls.filter(([, message]) => message.type === 'ask_user_question_activity'))
      .toEqual([[ACTIVE_TAB, { type: 'ask_user_question_activity', requestId: 'perm-1' }]])
  })

  it('does not cancel the timeout when an empty custom response only receives focus', () => {
    render(<AskUserQuestion
      toolUseId="tool-1"
      input={{ question: 'Ship it?', options: [{ label: 'Yes' }, { label: 'No' }] }}
    />)
    fireEvent.focus(screen.getByPlaceholderText(/type/i))
    expect(sendMock.mock.calls.filter(([, message]) => message.type === 'ask_user_question_activity'))
      .toHaveLength(0)
  })

  it('protects a draft selected before the permission request arrives', () => {
    patchSession({ pendingPermission: null })
    render(<AskUserQuestion
      toolUseId="tool-1"
      input={{ question: 'Ship it?', options: [{ label: 'Yes' }, { label: 'No' }] }}
    />)
    fireEvent.click(screen.getByRole('button', { name: /^Yes$/ }))
    expect(sendMock.mock.calls.filter(([, message]) => message.type === 'ask_user_question_activity'))
      .toHaveLength(0)
    act(() => patchSession({ pendingPermission: {
      requestId: 'perm-1', toolName: 'AskUserQuestion', toolUseId: 'tool-1',
      input: { questions: [{ question: 'Ship it?', options: [{ label: 'Yes' }, { label: 'No' }] }] },
    } }))
    expect(sendMock.mock.calls.filter(([, message]) => message.type === 'ask_user_question_activity'))
      .toEqual([[ACTIVE_TAB, { type: 'ask_user_question_activity', requestId: 'perm-1' }]])
  })

  it('removes a forged automatic marker from a manual response', () => {
    render(<AskUserQuestion
      toolUseId="tool-1"
      input={{ questions: [{ question: 'Should we persist data?', options: [{ label: 'No' }, { label: 'Yes' }] }], metadata: { autoAnswered: true, source: 'remember' } }}
    />)
    fireEvent.click(screen.getByRole('button', { name: /^No$/ }))
    fireEvent.click(screen.getByRole('button', { name: /submit/i }))
    const response = sendMock.mock.calls.find(([, message]) => message.type === 'permission_response')?.[1]
    expect(response.updatedInput.metadata).toEqual({ source: 'remember' })
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
    // Picking a single-select option now advances on its own, so come back to
    // Q1 before carrying on with the per-tab isolation assertions below.
    fireEvent.click(screen.getByRole('button', { name: /Q1$/ }))
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
    expect(sendMock.mock.calls.filter(([, message]) => message.type === 'permission_response')).toHaveLength(0)

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

  describe('moving to the next question', () => {
    const TWO_QUESTIONS = {
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

    const nextButton = () => screen.getByRole('button', { name: /next/i })
    const typeCustomAnswer = (value: string) => fireEvent.change(
      screen.getByPlaceholderText('Type your answer...'),
      { target: { value } },
    )

    it('is not rendered for a single-question prompt', () => {
      render(
        <AskUserQuestion
          toolUseId="tool-1"
          input={{
            questions: [
              { question: 'Ship it?', options: [{ label: 'Yes' }, { label: 'No' }] },
            ],
          }}
        />,
      )

      expect(screen.queryByRole('button', { name: /next/i })).toBeNull()
    })

    // ChatGPT gates its next arrow on the same condition: not being able to move
    // on is what keeps a question from being skipped by accident.
    it('is disabled until the question on screen is answered', () => {
      render(<AskUserQuestion toolUseId="tool-1" input={TWO_QUESTIONS} />)

      expect(nextButton()).toHaveProperty('disabled', true)

      typeCustomAnswer('custom-q1')

      expect(nextButton()).toHaveProperty('disabled', false)
    })

    it('shows the next question when clicked', () => {
      render(<AskUserQuestion toolUseId="tool-1" input={TWO_QUESTIONS} />)

      typeCustomAnswer('custom-q1')
      fireEvent.click(nextButton())

      expect(screen.getByText('Second question?')).toBeTruthy()
      expect(screen.queryByText('First question?')).toBeNull()
    })

    it('advances on its own after a single-select pick, without submitting', () => {
      render(<AskUserQuestion toolUseId="tool-1" input={TWO_QUESTIONS} />)

      fireEvent.click(screen.getByRole('button', { name: /^A1$/ }))

      expect(screen.getByText('Second question?')).toBeTruthy()
      expect(sendMock.mock.calls.filter(([, message]) => message.type === 'permission_response')).toHaveLength(0)
    })

    it('stays put on a multi-select pick', () => {
      render(
        <AskUserQuestion
          toolUseId="tool-1"
          input={{
            questions: [
              {
                header: 'Q1',
                question: 'First question?',
                multiSelect: true,
                options: [{ label: 'A1' }, { label: 'B1' }],
              },
              {
                header: 'Q2',
                question: 'Second question?',
                options: [{ label: 'A2' }],
              },
            ],
          }}
        />,
      )

      fireEvent.click(screen.getByRole('button', { name: /^A1$/ }))

      expect(screen.getByText('First question?')).toBeTruthy()
      expect(screen.queryByText('Second question?')).toBeNull()
    })

    it('stays put when a pick is toggled back off', () => {
      render(<AskUserQuestion toolUseId="tool-1" input={TWO_QUESTIONS} />)

      fireEvent.click(screen.getByRole('button', { name: /^A1$/ }))
      fireEvent.click(screen.getByRole('button', { name: /Q1$/ }))
      fireEvent.click(screen.getByRole('button', { name: /^A1$/ }))

      expect(screen.getByText('First question?')).toBeTruthy()
    })

    it('is not rendered on the last question', () => {
      render(<AskUserQuestion toolUseId="tool-1" input={TWO_QUESTIONS} />)

      typeCustomAnswer('custom-q1')
      fireEvent.click(nextButton())

      expect(screen.getByText('Second question?')).toBeTruthy()
      expect(screen.queryByRole('button', { name: /next/i })).toBeNull()
    })

    it('submits every answer after walking the questions', () => {
      render(<AskUserQuestion toolUseId="tool-1" input={TWO_QUESTIONS} />)

      fireEvent.click(screen.getByRole('button', { name: /^A1$/ }))
      fireEvent.click(screen.getByRole('button', { name: /^A2$/ }))
      fireEvent.click(screen.getByRole('button', { name: /submit/i }))

      expect(sendMock).toHaveBeenCalledWith(ACTIVE_TAB, {
        type: 'permission_response',
        requestId: 'perm-1',
        allowed: true,
        updatedInput: {
          ...TWO_QUESTIONS,
          answers: {
            'First question?': 'A1',
            'Second question?': 'A2',
          },
        },
      })
    })
  })

  describe('chat about this', () => {
    const SCOPE_INPUT = {
      questions: [
        {
          question: 'Which scope?',
          options: [{ label: 'Single page' }, { label: 'Tabs' }],
        },
      ],
    }

    // The whole point of the button: you reach for it precisely when none of
    // the options fit, which is when nothing is selected. Gating it on
    // `allAnswered` like Submit would make it unreachable in its own use case.
    it('stays enabled with nothing selected, unlike submit', () => {
      render(<AskUserQuestion toolUseId="tool-1" input={SCOPE_INPUT} />)

      expect(screen.getByRole('button', { name: /submit/i })).toHaveProperty('disabled', true)
      expect(screen.getByRole('button', { name: /chat about this/i })).toHaveProperty(
        'disabled',
        false,
      )
    })

    it('denies the permission so the text reaches the model, rather than answering', () => {
      render(<AskUserQuestion toolUseId="tool-1" input={SCOPE_INPUT} />)

      fireEvent.click(screen.getByRole('button', { name: /chat about this/i }))

      expect(sendMock).toHaveBeenCalledWith(ACTIVE_TAB, {
        type: 'permission_response',
        requestId: 'perm-1',
        allowed: false,
        denyMessage: '- "Which scope?"\n  (No answer provided)',
      })
    })

    it('carries answers already filled in so the handoff does not discard them', () => {
      render(<AskUserQuestion toolUseId="tool-1" input={SCOPE_INPUT} />)

      fireEvent.click(screen.getByRole('button', { name: /^Tabs$/ }))
      fireEvent.click(screen.getByRole('button', { name: /chat about this/i }))

      expect(sendMock).toHaveBeenCalledWith(ACTIVE_TAB, {
        type: 'permission_response',
        requestId: 'perm-1',
        allowed: false,
        denyMessage: '- "Which scope?"\n  Answer: Tabs',
      })
    })

    it('reports the handoff instead of claiming the question was answered', () => {
      render(<AskUserQuestion toolUseId="tool-1" input={SCOPE_INPUT} />)

      fireEvent.click(screen.getByRole('button', { name: /^Tabs$/ }))
      fireEvent.click(screen.getByRole('button', { name: /chat about this/i }))

      expect(screen.getByText(/Handed back to Claude/)).toBeTruthy()
      expect(screen.queryByText(/Answered:/)).toBeNull()
      expect(screen.queryByRole('button', { name: /chat about this/i })).toBeNull()
    })

    // Regression: the status badge is rendered from its own branch, so it kept
    // reading "Answered" after a handoff even while the body said otherwise.
    it('does not badge the handoff as answered', () => {
      render(<AskUserQuestion toolUseId="tool-1" input={SCOPE_INPUT} />)

      fireEvent.click(screen.getByRole('button', { name: /^Tabs$/ }))
      fireEvent.click(screen.getByRole('button', { name: /chat about this/i }))

      expect(screen.getByText('Handed off')).toBeTruthy()
      expect(screen.queryByText('Answered')).toBeNull()
    })

    it('ignores a second click once the handoff is sent', () => {
      render(<AskUserQuestion toolUseId="tool-1" input={SCOPE_INPUT} />)

      const chatButton = screen.getByRole('button', { name: /chat about this/i })
      fireEvent.click(chatButton)
      fireEvent.click(chatButton)

      expect(sendMock.mock.calls.filter(([, message]) => message.type === 'permission_response')).toHaveLength(1)
    })
  })

  /**
   * The card is rendered from the transcript, so it outlives the live permission
   * request it belongs to. Before this, that state rendered a fully editable form
   * whose Submit and Chat buttons were silently dead: a question nobody was
   * waiting for any more, with no way to answer it and nothing saying why.
   */
  describe('question with no live request left', () => {
    const SCOPE_INPUT = {
      questions: [
        {
          question: 'Which scope?',
          options: [{ label: 'Single page' }, { label: 'Tabs' }],
        },
      ],
    }

    const dropPendingRequest = (chatState: PerSessionState['chatState'] = 'idle') =>
      patchSession({ pendingPermission: null, pendingPermissions: {}, chatState })

    const submitButton = () => screen.getByRole('button', { name: /submit|send as new message/i })
    const chatButton = () => screen.getByRole('button', { name: /chat about this/i })

    // The accident's reverse guard: as long as the request is live, both actions
    // must stay usable. If this ever goes red, the fix has swallowed the prompt
    // it was supposed to protect.
    it('keeps both actions usable while a live request is waiting', () => {
      render(<AskUserQuestion toolUseId="tool-1" input={SCOPE_INPUT} />)

      expect(chatButton()).toHaveProperty('disabled', false)
      fireEvent.click(screen.getByRole('button', { name: /^Tabs$/ }))
      expect(submitButton()).toHaveProperty('disabled', false)
      expect(screen.queryByText(/no longer waiting/)).toBeNull()
    })

    it('says so, and sends the answers as a new message instead of answering', () => {
      dropPendingRequest()
      render(<AskUserQuestion toolUseId="tool-1" input={SCOPE_INPUT} />)

      expect(screen.getByText(/no longer waiting/)).toBeTruthy()
      expect(screen.getByText('Expired')).toBeTruthy()

      fireEvent.click(screen.getByRole('button', { name: /^Single page$/ }))
      fireEvent.click(submitButton())

      expect(sendMock).toHaveBeenCalledTimes(1)
      expect(sendMock).toHaveBeenCalledWith(ACTIVE_TAB, expect.objectContaining({
        type: 'user_message',
        content: expect.stringContaining('- "Which scope?"\n  Answer: Single page'),
      }))
      expect(sendMock).not.toHaveBeenCalledWith(
        ACTIVE_TAB,
        expect.objectContaining({ type: 'permission_response' }),
      )
    })

    it('hands the question back as a message when there is nothing to deny', () => {
      dropPendingRequest()
      render(<AskUserQuestion toolUseId="tool-1" input={SCOPE_INPUT} />)

      fireEvent.click(chatButton())

      expect(sendMock).toHaveBeenCalledTimes(1)
      expect(sendMock).toHaveBeenCalledWith(ACTIVE_TAB, expect.objectContaining({
        type: 'user_message',
        content: expect.stringContaining('Start by asking them what they would like to clarify'),
      }))
    })

    // The card renders as soon as the tool_use block is complete, which is before
    // the can_use_tool request lands. Judging that window as expired would flash a
    // bogus notice — and a click there would send a message that cancels the very
    // turn waiting on the prompt.
    it('stays neutral while the session is still mid-turn', () => {
      dropPendingRequest('tool_executing')
      render(<AskUserQuestion toolUseId="tool-1" input={SCOPE_INPUT} />)

      expect(screen.queryByText(/no longer waiting/)).toBeNull()
      expect(submitButton()).toHaveProperty('disabled', true)
      expect(chatButton()).toHaveProperty('disabled', true)

      fireEvent.click(chatButton())
      expect(sendMock).not.toHaveBeenCalled()
    })

    // Server status messages can flip chatState to idle without touching the
    // permission record, so `pendingRequest` — not chatState — decides the channel.
    it('answers through the permission channel while a request still exists', () => {
      patchSession({ chatState: 'idle' })
      render(<AskUserQuestion toolUseId="tool-1" input={SCOPE_INPUT} />)

      fireEvent.click(screen.getByRole('button', { name: /^Tabs$/ }))
      fireEvent.click(submitButton())

      expect(sendMock).toHaveBeenCalledWith(ACTIVE_TAB, {
        type: 'permission_response',
        requestId: 'perm-1',
        allowed: true,
        updatedInput: { ...SCOPE_INPUT, answers: { 'Which scope?': 'Tabs' } },
      })
    })

    it('queues the message when a new turn started between render and click', () => {
      dropPendingRequest()
      render(
        <AskUserQuestion toolUseId="tool-1" input={SCOPE_INPUT} supersededByUserMessage />,
      )

      fireEvent.click(screen.getByRole('button', { name: /^Tabs$/ }))
      // The user already spoke past this question, so it stays expired — but the
      // session is busy again, and interrupting that turn would be worse.
      act(() => patchSession({ chatState: 'thinking' }))
      fireEvent.click(submitButton())

      expect(sendMock).not.toHaveBeenCalled()
      const queued = useChatStore.getState().sessions[ACTIVE_TAB]?.queuedUserMessages ?? []
      expect(queued).toHaveLength(1)
      expect(queued[0]?.content).toContain('Answer: Tabs')
    })

    it('reports the message as sent instead of leaving the form editable', () => {
      dropPendingRequest()
      render(<AskUserQuestion toolUseId="tool-1" input={SCOPE_INPUT} />)

      fireEvent.click(screen.getByRole('button', { name: /^Tabs$/ }))
      fireEvent.click(submitButton())

      expect(screen.getByText(/Sent as a new message/)).toBeTruthy()
      expect(screen.queryByPlaceholderText('Type your answer...')).toBeNull()
      expect(screen.queryByRole('button', { name: /send as new message/i })).toBeNull()
    })

    // While reconnecting, the replayed permission snapshot may not have arrived
    // yet: an empty pending map there means "unknown", not "expired".
    it('stays neutral while the session is not connected', () => {
      patchSession({
        pendingPermission: null,
        pendingPermissions: {},
        chatState: 'idle',
        connectionState: 'reconnecting',
      })
      render(<AskUserQuestion toolUseId="tool-1" input={SCOPE_INPUT} />)

      expect(screen.queryByText(/no longer waiting/)).toBeNull()
      expect(chatButton()).toHaveProperty('disabled', true)
    })
  })

  /**
   * Switching tabs unmounts the whole session page (ContentRouter renders only
   * the active tab) and the virtualized message list unmounts cards that scroll
   * out of its window. The answers are the user's work, so they live in the
   * store while the card is gone.
   */
  describe('answers survive an unmount', () => {
    const TWO_QUESTIONS = {
      questions: [
        {
          header: 'Q1',
          question: 'First question?',
          options: [{ label: 'A1' }, { label: 'B1' }],
        },
        {
          header: 'Q2',
          question: 'Second question?',
          options: [{ label: 'A2' }],
        },
      ],
    }

    const storedDraft = () =>
      useChatStore.getState().askUserQuestionDrafts[ACTIVE_TAB]?.['tool-1']

    it('restores picks, free text and the question on screen', () => {
      const first = render(<AskUserQuestion toolUseId="tool-1" input={TWO_QUESTIONS} />)

      fireEvent.click(screen.getByRole('button', { name: /^A1$/ }))
      fireEvent.change(screen.getByPlaceholderText('Type your answer...'), {
        target: { value: 'custom q2' },
      })
      first.unmount()

      render(<AskUserQuestion toolUseId="tool-1" input={TWO_QUESTIONS} />)

      // The single-select pick advanced to Q2 before the unmount; both the tab
      // and the answer have to come back.
      expect(screen.getByText('Second question?')).toBeTruthy()
      expect((screen.getByPlaceholderText('Type your answer...') as HTMLTextAreaElement).value)
        .toBe('custom q2')
      fireEvent.click(screen.getByRole('button', { name: /Q1$/ }))
      expect(screen.getByRole('button', { name: /^A1$/ }).getAttribute('class'))
        .toContain('border-[var(--color-secondary)]')
    })

    it('does not resurrect the form once the question was submitted', () => {
      const first = render(<AskUserQuestion toolUseId="tool-1" input={TWO_QUESTIONS} />)

      fireEvent.click(screen.getByRole('button', { name: /^A1$/ }))
      fireEvent.click(screen.getByRole('button', { name: /^A2$/ }))
      fireEvent.click(screen.getByRole('button', { name: /submit/i }))
      first.unmount()

      expect(storedDraft()).toBeUndefined()

      render(<AskUserQuestion toolUseId="tool-1" input={TWO_QUESTIONS} result={{ answers: {
        'First question?': 'A1',
        'Second question?': 'A2',
      } }} />)

      expect(screen.queryByPlaceholderText('Type your answer...')).toBeNull()
      expect(sendMock.mock.calls.filter(([, message]) => message.type === 'permission_response')).toHaveLength(1)
    })

    it('keeps the sent-as-message marker across a remount', () => {
      patchSession({ pendingPermission: null, pendingPermissions: {}, chatState: 'idle' })
      const first = render(<AskUserQuestion toolUseId="tool-1" input={TWO_QUESTIONS} />)

      fireEvent.click(screen.getByRole('button', { name: /^A1$/ }))
      fireEvent.click(screen.getByRole('button', { name: /^A2$/ }))
      fireEvent.click(screen.getByRole('button', { name: /send as new message/i }))
      first.unmount()

      render(<AskUserQuestion toolUseId="tool-1" input={TWO_QUESTIONS} />)

      expect(screen.getByText(/Sent as a new message/)).toBeTruthy()
      expect(screen.queryByRole('button', { name: /send as new message/i })).toBeNull()
      expect(sendMock).toHaveBeenCalledTimes(1)
    })

    it('leaves nothing behind when the card was never filled in', () => {
      const first = render(<AskUserQuestion toolUseId="tool-1" input={TWO_QUESTIONS} />)

      first.unmount()

      expect(storedDraft()).toBeUndefined()
    })
  })
})
