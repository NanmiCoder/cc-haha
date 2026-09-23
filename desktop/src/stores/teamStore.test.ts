import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  memberSessionId,
  mergeMemberTranscriptDelta,
  mergeMemberTranscriptMessages,
  useTeamStore,
} from './teamStore'
import { registerAgentRunSession, useChatStore } from './chatStore'
import { useTabStore } from './tabStore'
import type { UIMessage } from '../types/chat'
import type { TeamWorkbenchSnapshot } from '../types/team'

const {
  getMemberTranscriptMock,
  getWorkbenchForSessionMock,
  getWorkbenchMock,
  getTeamMock,
  sendMemberMessageMock,
} = vi.hoisted(() => ({
  getMemberTranscriptMock: vi.fn(),
  getWorkbenchForSessionMock: vi.fn(),
  getWorkbenchMock: vi.fn(),
  getTeamMock: vi.fn(),
  sendMemberMessageMock: vi.fn(),
}))

vi.mock('../api/teams', () => ({
  teamsApi: {
    getMemberTranscript: getMemberTranscriptMock,
    getWorkbenchForSession: getWorkbenchForSessionMock,
    getWorkbench: getWorkbenchMock,
    list: vi.fn(),
    get: getTeamMock,
    sendMemberMessage: sendMemberMessageMock,
    delete: vi.fn(),
  },
}))

function userMessage(id: string, content: string, timestamp: number, pending = false): UIMessage {
  return {
    id,
    type: 'user_text',
    content,
    timestamp,
    ...(pending ? { pending: true } : {}),
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, reject, resolve }
}

function workbench(version: string, taskStatus: 'pending' | 'in_progress' | 'completed'): TeamWorkbenchSnapshot {
  return {
    version,
    generatedAt: `2026-08-08T00:00:0${version.slice(-1)}.000Z`,
    team: {
      name: 'team-workbench',
      leadAgentId: 'lead@team-workbench',
      leadSessionId: 'lead-session',
      members: [
        { agentId: 'lead@team-workbench', name: 'lead', role: 'lead', status: 'running' },
        { agentId: 'worker@team-workbench', name: 'worker', role: 'worker', status: 'running' },
      ],
    },
    tasks: [{
      id: '1',
      subject: 'Build workbench',
      description: 'Exercise the state reducer',
      status: taskStatus,
      owner: 'worker',
      blocks: [],
      blockedBy: [],
      taskListId: 'team-workbench',
    }],
    messages: [],
  }
}

describe('teamStore incremental transcript polling', () => {
  beforeEach(() => {
    getMemberTranscriptMock.mockReset()
    getWorkbenchForSessionMock.mockReset()
    getWorkbenchMock.mockReset()
    getTeamMock.mockReset()
    sendMemberMessageMock.mockReset()
    sendMemberMessageMock.mockResolvedValue({ ok: true })
    useTeamStore.getState().clearTeam()
    useChatStore.setState({ sessions: {} })
  })

  afterEach(() => {
    useTeamStore.getState().stopMemberPolling()
    useTeamStore.getState().clearTeam()
    useTabStore.getState().closeTab('team-member:idle-worker@team-idle')
    vi.useRealTimers()
  })

  it('appends unseen messages once and removes a matching pending echo', () => {
    const pending = userMessage('pending-1', 'please review', 1_000, true)
    const existing = [userMessage('durable-1', 'old', 500), pending]
    const delta = [
      userMessage('server-1', 'please review', 1_100),
      userMessage('server-1', 'please review', 1_100),
    ]

    const merged = mergeMemberTranscriptDelta(existing, delta)

    expect(merged.map(message => message.id)).toEqual(['durable-1', 'server-1'])
  })

  it('consumes one durable echo for only one repeated pending message', () => {
    const existing = [
      userMessage('pending-1', 'repeat this', 1_000, true),
      userMessage('pending-2', 'repeat this', 1_001, true),
    ]

    const merged = mergeMemberTranscriptDelta(
      existing,
      [userMessage('server-1', 'repeat this', 1_100)],
    )

    expect(merged.map(message => message.id)).toEqual(['server-1', 'pending-2'])
  })

  it('deduplicates a full transcript by identity without dropping a genuine repeat', () => {
    const transcript = [
      userMessage('server-1', 'same content', 1_000),
      userMessage('server-1', 'same content', 1_000),
      userMessage('server-2', 'same content', 1_100),
    ]

    const merged = mergeMemberTranscriptMessages([], transcript)

    expect(merged.map(message => message.id)).toEqual(['server-1', 'server-2'])
  })

  it('starts the first transcript read on member selection and shares it with the mounted page', async () => {
    let resolveTranscript!: (value: { messages: [] }) => void
    getMemberTranscriptMock.mockReturnValue(new Promise((resolve) => {
      resolveTranscript = resolve
    }))
    const member = {
      agentId: 'worker@prefetch-team',
      name: 'worker',
      role: 'reviewer',
      status: 'running' as const,
    }
    const team = {
      name: 'prefetch-team',
      leadSessionId: 'prefetch-lead',
      members: [member],
    }

    useTeamStore.getState().openMemberSession(member, team)
    const pageLoad = useTeamStore.getState().ensureMemberSession('team-member:worker@prefetch-team')

    expect(getMemberTranscriptMock).toHaveBeenCalledTimes(1)
    resolveTranscript({ messages: [] })
    await pageLoad
  })

  it('resolves a member transcript from its lead session when another team is active', async () => {
    const member = {
      agentId: 'worker@team-a',
      name: 'worker-a',
      role: 'reviewer',
      status: 'running' as const,
    }
    const teamA = {
      name: 'team-a',
      leadSessionId: 'lead-a',
      members: [member],
    }
    getMemberTranscriptMock.mockResolvedValue({
      messages: [{
        id: 'team-a-message',
        type: 'assistant',
        content: [{ type: 'text', text: 'Team A transcript' }],
        timestamp: '2026-08-08T00:00:00.000Z',
      }],
    })
    useTeamStore.setState({
      activeTeam: {
        name: 'team-b',
        leadSessionId: 'lead-b',
        members: [{ agentId: 'worker@team-b', role: 'reviewer', status: 'running' }],
      },
      workbenchesBySession: {
        'lead-a': {
          teamName: 'team-a',
          loading: false,
          error: null,
          snapshots: [{
            version: 'team-a-v1',
            generatedAt: '2026-08-08T00:00:00.000Z',
            team: teamA,
            tasks: [],
            messages: [],
          }],
        },
      },
    })
    useTabStore.setState({
      tabs: [{
        sessionId: 'team-member:worker@team-a',
        title: 'worker-a',
        type: 'team-member',
        status: 'idle',
        sourceSessionId: 'lead-a',
        teamLeadSessionId: 'lead-a',
        teamMemberAgentId: member.agentId,
      }],
      activeTabId: 'team-member:worker@team-a',
    })

    await useTeamStore.getState().refreshMemberSession('team-member:worker@team-a')

    expect(getMemberTranscriptMock).toHaveBeenCalledWith(
      'team-a',
      'worker@team-a',
      { leadSessionId: 'lead-a' },
    )
    expect(useTeamStore.getState().getTeamByMemberSessionId('team-member:worker@team-a')?.name).toBe('team-a')
    expect(
      useChatStore.getState().sessions['team-member:worker@team-a']?.messages
        .some((message) => message.type === 'assistant_text' && message.content === 'Team A transcript'),
    ).toBe(true)
  })

  it('keeps polling the viewed member when a different team is deleted', async () => {
    vi.useFakeTimers()
    getMemberTranscriptMock.mockResolvedValue({ messages: [] })
    const viewedMember = {
      agentId: 'worker@team-b',
      name: 'worker-b',
      role: 'reviewer',
      status: 'running' as const,
    }
    const teamB = {
      name: 'team-b',
      leadSessionId: 'lead-b',
      members: [viewedMember],
    }
    useTeamStore.setState({
      activeTeam: teamB,
      memberTeamBySession: {
        'team-member:worker@team-a': {
          name: 'team-a',
          leadSessionId: 'lead-a',
          members: [{ agentId: 'worker@team-a', role: 'reviewer', status: 'running' }],
        },
      },
    })

    useTeamStore.getState().openMemberSession(viewedMember, teamB)
    await useTeamStore.getState().ensureMemberSession('team-member:worker@team-b')
    useTeamStore.getState().startMemberPolling('team-member:worker@team-b')
    const callsBeforeDelete = getMemberTranscriptMock.mock.calls.length

    useTeamStore.getState().handleTeamDeleted('team-a', 'lead-a')
    await vi.advanceTimersByTimeAsync(1_500)

    expect(getMemberTranscriptMock.mock.calls.length).toBe(callsBeforeDelete + 1)
    expect(getMemberTranscriptMock).toHaveBeenLastCalledWith(
      'team-b',
      'worker@team-b',
      expect.objectContaining({ leadSessionId: 'lead-b' }),
    )
  })

  it('coalesces concurrent member refreshes and permits the next refresh after completion', async () => {
    const slowTranscript = deferred<any>()
    getMemberTranscriptMock
      .mockReturnValueOnce(slowTranscript.promise)
      .mockResolvedValueOnce({
        messages: [{
          id: 'next-message',
          type: 'user',
          content: 'next',
          timestamp: '2026-01-01T00:00:02.000Z',
        }],
        signature: 'next-signature',
        cursor: 'next-cursor',
        afterOrdinal: 1,
      })
    useTeamStore.setState({
      activeTeam: {
        name: 'team-1',
        members: [{
          agentId: 'agent-1',
          role: 'worker',
          status: 'running',
        }],
      },
    })
    const sessionId = 'team-member:agent-1'

    const firstPoll = useTeamStore.getState().refreshMemberSession(sessionId)
    const joinedPoll = useTeamStore.getState().refreshMemberSession(sessionId)

    expect(joinedPoll).toBe(firstPoll)
    expect(getMemberTranscriptMock).toHaveBeenCalledTimes(1)

    slowTranscript.resolve({
      messages: [{
        id: 'slow-message',
        type: 'user',
        content: 'slow response',
        timestamp: '2026-01-01T00:00:01.000Z',
      }],
      signature: 'slow-signature',
      cursor: 'slow-cursor',
      afterOrdinal: 0,
    })
    await Promise.all([firstPoll, joinedPoll])

    expect(
      useChatStore.getState().sessions[sessionId]?.messages.map(message => message.id),
    ).toEqual(['slow-message'])

    await useTeamStore.getState().refreshMemberSession(sessionId)

    expect(getMemberTranscriptMock).toHaveBeenCalledTimes(2)
    expect(getMemberTranscriptMock.mock.calls[1]?.[2]).toMatchObject({
      signature: 'slow-signature',
      cursor: 'slow-cursor',
      afterOrdinal: 0,
    })
    expect(
      useChatStore.getState().sessions[sessionId]?.messages.map(message => message.id),
    ).toEqual(['slow-message', 'next-message'])
  })

  it('does not let a deleted team transcript overwrite a same-name recreation', async () => {
    const oldTranscript = deferred<any>()
    getMemberTranscriptMock
      .mockReturnValueOnce(oldTranscript.promise)
      .mockResolvedValueOnce({
        messages: [{
          id: 'new-incarnation-message',
          type: 'user',
          content: 'new incarnation',
          timestamp: '2026-08-10T00:00:03.000Z',
        }],
        signature: 'new-signature',
        cursor: 'new-cursor',
        afterOrdinal: 0,
      })
    getTeamMock.mockReturnValue(new Promise(() => {}))
    getWorkbenchMock.mockReturnValue(new Promise(() => {}))
    const oldIncarnationId = 'old-incarnation'
    const newIncarnationId = 'new-incarnation'
    const oldTeam = {
      name: 'reused-team',
      leadSessionId: 'lead-reused',
      incarnationId: oldIncarnationId,
      createdAt: '2026-08-10T00:00:00.000Z',
      members: [{
        agentId: 'worker@reused-team',
        role: 'worker',
        status: 'running' as const,
      }],
    }
    const oldSessionId = memberSessionId('worker@reused-team', oldIncarnationId)
    useTeamStore.setState({ activeTeam: oldTeam })

    const staleRequest = useTeamStore.getState().refreshMemberSession(oldSessionId)
    useTeamStore.getState().handleTeamDeleted(
      'reused-team',
      'lead-reused',
      { incarnationId: oldIncarnationId, createdAt: Date.parse(oldTeam.createdAt) },
    )
    useTeamStore.getState().handleTeamCreated(
      'reused-team',
      'lead-reused',
      { incarnationId: newIncarnationId, createdAt: Date.parse('2026-08-10T00:00:02.000Z') },
    )
    const recreatedTeam = {
      ...oldTeam,
      incarnationId: newIncarnationId,
      createdAt: '2026-08-10T00:00:02.000Z',
    }
    const newSessionId = memberSessionId('worker@reused-team', newIncarnationId)
    useTeamStore.setState({
      activeTeam: recreatedTeam,
      memberTeamBySession: { [newSessionId]: recreatedTeam },
    })
    await useTeamStore.getState().refreshMemberSession(newSessionId)
    expect(getMemberTranscriptMock.mock.calls[1]?.[2]).toMatchObject({
      leadSessionId: 'lead-reused',
      incarnationId: newIncarnationId,
    })
    oldTranscript.resolve({
      messages: [{
        id: 'old-incarnation-message',
        type: 'user',
        content: 'old incarnation',
        timestamp: '2026-08-10T00:00:01.000Z',
      }],
      signature: 'old-signature',
      cursor: 'old-cursor',
      afterOrdinal: 0,
    })
    await staleRequest

    expect(
      useChatStore.getState().sessions[newSessionId]?.messages.map((message) => message.id),
    ).toEqual(['new-incarnation-message'])
    expect(useChatStore.getState().sessions[oldSessionId]).toBeUndefined()
  })

  it('starts a recreated member empty when its first transcript request rejects', async () => {
    getMemberTranscriptMock
      .mockResolvedValueOnce({
        messages: [{
          id: 'old-durable',
          type: 'assistant',
          content: 'old durable content',
          timestamp: '2026-08-10T00:00:01.000Z',
        }],
      })
      .mockRejectedValueOnce(new Error('new transcript not durable yet'))
    getTeamMock.mockReturnValue(new Promise(() => {}))
    getWorkbenchMock.mockReturnValue(new Promise(() => {}))
    const member = {
      agentId: 'worker@aba-team',
      role: 'worker',
      status: 'running' as const,
    }
    const oldTeam = {
      name: 'aba-team',
      leadSessionId: 'shared-lead',
      incarnationId: 'incarnation-old',
      createdAt: '2026-08-10T00:00:00.000Z',
      members: [member],
    }
    const oldSessionId = memberSessionId(member.agentId, oldTeam.incarnationId)
    useTeamStore.setState({
      activeTeam: oldTeam,
      memberTeamBySession: { [oldSessionId]: oldTeam },
    })
    await useTeamStore.getState().refreshMemberSession(oldSessionId)
    useChatStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [oldSessionId]: {
          ...state.sessions[oldSessionId]!,
          messages: [
            ...state.sessions[oldSessionId]!.messages,
            userMessage('old-pending', 'old pending content', Date.now(), true),
          ],
          backgroundAgentTasks: {
            oldTask: {
              taskId: 'oldTask',
              status: 'running',
              startedAt: 1,
              updatedAt: 2,
            },
          },
        },
      },
    }))

    useTeamStore.getState().handleTeamDeleted(
      oldTeam.name,
      oldTeam.leadSessionId,
      { incarnationId: oldTeam.incarnationId },
    )
    useTeamStore.getState().handleTeamCreated(
      oldTeam.name,
      oldTeam.leadSessionId,
      { incarnationId: 'incarnation-new', createdAt: Date.now() },
    )
    const newTeam = {
      ...oldTeam,
      incarnationId: 'incarnation-new',
      createdAt: '2026-08-10T00:00:03.000Z',
    }
    const newSessionId = memberSessionId(member.agentId, newTeam.incarnationId)
    useTeamStore.setState({
      activeTeam: newTeam,
      memberTeamBySession: { [newSessionId]: newTeam },
    })

    await useTeamStore.getState().refreshMemberSession(newSessionId)

    expect(useChatStore.getState().sessions[oldSessionId]).toBeUndefined()
    expect(useChatStore.getState().sessions[newSessionId]).toMatchObject({
      messages: [],
      backgroundAgentTasks: {},
      agentTaskNotifications: {},
    })
  })

  it('replaces a cursor-backed transcript when a legacy sidecar omits cursor metadata', async () => {
    const fullSnapshot = {
      messages: [
        {
          id: 'deleted-message',
          type: 'user',
          content: 'removed by the legacy full snapshot',
          timestamp: '2026-01-01T00:00:01.000Z',
        },
        {
          id: 'kept-message',
          type: 'user',
          content: 'still present',
          timestamp: '2026-01-01T00:00:02.000Z',
        },
      ],
      signature: 'cursor-signature',
      cursor: 'cursor-token',
      afterOrdinal: 1,
    }
    const legacySnapshot = {
      messages: [{
        id: 'kept-message',
        type: 'user',
        content: 'still present',
        timestamp: '2026-01-01T00:00:02.000Z',
      }],
    }
    getMemberTranscriptMock
      .mockResolvedValueOnce(fullSnapshot)
      .mockResolvedValueOnce(legacySnapshot)
      .mockResolvedValueOnce(legacySnapshot)
    useTeamStore.setState({
      activeTeam: {
        name: 'team-legacy',
        members: [{
          agentId: 'agent-legacy',
          role: 'worker',
          status: 'running',
        }],
      },
    })
    const sessionId = 'team-member:agent-legacy'

    await useTeamStore.getState().refreshMemberSession(sessionId)
    await useTeamStore.getState().refreshMemberSession(sessionId)

    expect(getMemberTranscriptMock.mock.calls[1]?.[2]).toMatchObject({
      signature: 'cursor-signature',
      cursor: 'cursor-token',
      afterOrdinal: 1,
    })
    expect(
      useChatStore.getState().sessions[sessionId]?.messages.map(message => message.id),
    ).toEqual(['kept-message'])

    await useTeamStore.getState().refreshMemberSession(sessionId)
    expect(getMemberTranscriptMock.mock.calls[2]?.[2]).toEqual({})
  })

  it('keeps polling an idle member tab so a resumed reply appears in the same conversation', async () => {
    vi.useFakeTimers()
    getMemberTranscriptMock
      .mockResolvedValueOnce({
        messages: [{
          id: 'before-resume',
          type: 'assistant',
          content: [{ type: 'text', text: 'Initial review complete.' }],
          timestamp: '2026-01-01T00:00:01.000Z',
        }],
        signature: 'signature-1',
        cursor: 'cursor-1',
        afterOrdinal: 0,
      })
      .mockResolvedValueOnce({
        messages: [{
          id: 'after-resume',
          type: 'assistant',
          content: [{ type: 'text', text: 'Follow-up review complete.' }],
          timestamp: '2026-01-01T00:00:02.000Z',
        }],
        signature: 'signature-2',
        cursor: 'cursor-2',
        afterOrdinal: 1,
      })
    const member = {
      agentId: 'idle-worker@team-idle',
      name: 'idle-worker',
      role: 'security-reviewer',
      status: 'idle' as const,
    }
    getTeamMock.mockResolvedValue({
      name: 'team-idle',
      leadAgentId: 'lead@team-idle',
      members: [member],
    })

    await useTeamStore.getState().fetchTeamDetail('team-idle')
    useTeamStore.getState().openMemberSession(member)
    await useTeamStore.getState().ensureMemberSession('team-member:idle-worker@team-idle')
    const firstAssistantId = useChatStore.getState()
      .sessions['team-member:idle-worker@team-idle']?.messages
      .find((message) => message.type === 'assistant_text')?.id
    useTeamStore.getState().startMemberPolling('team-member:idle-worker@team-idle')
    expect(getMemberTranscriptMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1_500)

    expect(getMemberTranscriptMock).toHaveBeenCalledTimes(2)
    expect(
      useChatStore.getState().sessions['team-member:idle-worker@team-idle']?.messages
        .filter(message => message.type === 'assistant_text')
        .map(message => message.content),
    ).toEqual(['Initial review complete.', 'Follow-up review complete.'])
    expect(
      useChatStore.getState().sessions['team-member:idle-worker@team-idle']?.messages
        .find((message) => (
          message.type === 'assistant_text' &&
          message.transcriptMessageId === 'before-resume'
        ))?.id,
    ).toBe(firstAssistantId)
  })

  it('opens an archived member once with lead identity and does not start live polling', async () => {
    vi.useFakeTimers()
    getMemberTranscriptMock.mockResolvedValue({
      messages: [{
        id: 'archived-tool-call',
        type: 'assistant',
        content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'bun test' } }],
        timestamp: '2026-08-08T00:00:00.000Z',
      }],
      signature: 'archive-signature',
      cursor: 'archive-cursor',
      afterOrdinal: 0,
    })
    const member = {
      agentId: 'reviewer@archived-team',
      name: 'reviewer',
      role: 'security-reviewer',
      status: 'completed' as const,
    }
    useTeamStore.setState({
      activeTeam: {
        name: 'archived-team',
        leadAgentId: 'team-lead@archived-team',
        leadSessionId: 'archived-lead-session',
        members: [member],
      },
    })

    useTeamStore.getState().openMemberSession(member)
    await useTeamStore.getState().ensureMemberSession('team-member:reviewer@archived-team')

    expect(getMemberTranscriptMock).toHaveBeenCalledWith(
      'archived-team',
      'reviewer@archived-team',
      { leadSessionId: 'archived-lead-session' },
    )
    await vi.advanceTimersByTimeAsync(2_000)
    expect(getMemberTranscriptMock).toHaveBeenCalledTimes(1)
    useTabStore.getState().closeTab('team-member:reviewer@archived-team')
  })

  it('keeps concurrent direct turns active until every durable reply arrives', async () => {
    const firstDelivery = deferred<{ ok: true }>()
    const secondDelivery = deferred<{ ok: true }>()
    const timestamp = new Date().toISOString()
    sendMemberMessageMock
      .mockReturnValueOnce(firstDelivery.promise)
      .mockReturnValueOnce(secondDelivery.promise)
    getWorkbenchMock.mockResolvedValue(workbench('v1', 'completed'))
    getMemberTranscriptMock
      .mockResolvedValueOnce({
        messages: [],
        signature: 'signature-0',
        cursor: 'cursor-0',
        afterOrdinal: 0,
      })
      .mockResolvedValueOnce({
        messages: [
          { id: 'first-echo', type: 'user', content: 'Repeat follow-up', timestamp },
          {
            id: 'first-reply',
            type: 'assistant',
            content: [{ type: 'text', text: 'First reply' }],
            timestamp,
          },
        ],
        signature: 'signature-1',
        cursor: 'cursor-1',
        afterOrdinal: 2,
      })
      .mockResolvedValueOnce({
        messages: [{ id: 'second-echo', type: 'user', content: 'Repeat follow-up', timestamp }],
        signature: 'signature-2',
        cursor: 'cursor-2',
        afterOrdinal: 3,
      })
      .mockResolvedValueOnce({
        messages: [{
          id: 'second-reply',
          type: 'assistant',
          content: [{ type: 'text', text: 'Second reply' }],
          timestamp,
        }],
        signature: 'signature-3',
        cursor: 'cursor-3',
        afterOrdinal: 4,
      })

    await useTeamStore.getState().fetchWorkbench('team-workbench')
    const sessionId = 'team-member:worker@team-workbench'
    await useTeamStore.getState().refreshMemberSession(sessionId)

    useChatStore.getState().sendMessage(sessionId, 'Repeat follow-up')
    useChatStore.getState().sendMessage(sessionId, 'Repeat follow-up')
    expect(useChatStore.getState().sessions[sessionId]?.chatState).toBe('thinking')

    firstDelivery.resolve({ ok: true })
    await vi.waitFor(() => {
      expect(
        useChatStore.getState().sessions[sessionId]?.messages
          .some((message) => message.type === 'assistant_text' && message.content === 'First reply'),
      ).toBe(true)
    })
    expect(useChatStore.getState().sessions[sessionId]?.chatState).toBe('thinking')
    expect(
      useChatStore.getState().sessions[sessionId]?.messages
        .filter((message) => message.type === 'user_text' && message.content === 'Repeat follow-up'),
    ).toHaveLength(2)
    expect(
      useChatStore.getState().sessions[sessionId]?.messages
        .filter((message) => message.type === 'user_text' && message.pending === true),
    ).toHaveLength(1)

    secondDelivery.resolve({ ok: true })
    await vi.waitFor(() => {
      expect(
        useChatStore.getState().sessions[sessionId]?.messages
          .some((message) => message.id === 'second-echo'),
      ).toBe(true)
    })
    useTeamStore.getState().stopMemberPolling()
    expect(useChatStore.getState().sessions[sessionId]?.chatState).toBe('thinking')

    await useTeamStore.getState().refreshMemberSession(sessionId)
    expect(useChatStore.getState().sessions[sessionId]?.chatState).toBe('idle')
    expect(
      useChatStore.getState().sessions[sessionId]?.messages
        .filter((message) => message.type === 'assistant_text')
        .map((message) => message.content),
    ).toEqual(['First reply', 'Second reply'])
  })

  it('does not restart a deleted member session after an in-flight delivery resolves', async () => {
    vi.useFakeTimers()
    const delivery = deferred<{ ok: true }>()
    sendMemberMessageMock.mockReturnValue(delivery.promise)
    getWorkbenchMock.mockResolvedValue(workbench('v1', 'in_progress'))
    getMemberTranscriptMock.mockResolvedValue({ messages: [] })

    await useTeamStore.getState().fetchWorkbench('team-workbench')
    const sessionId = 'team-member:worker@team-workbench'
    await useTeamStore.getState().refreshMemberSession(sessionId)
    const send = useTeamStore.getState().sendMessageToMember(sessionId, 'Final check')

    useTeamStore.getState().handleTeamDeleted('team-workbench')
    delivery.resolve({ ok: true })
    await send
    await vi.advanceTimersByTimeAsync(1_500)

    expect(getMemberTranscriptMock).toHaveBeenCalledTimes(1)
    expect(useChatStore.getState().sessions[sessionId]).toBeUndefined()
  })

  it('projects an incremental member transcript into that member background activity', async () => {
    getMemberTranscriptMock
      .mockResolvedValueOnce({
        messages: [
          {
            id: 'member-shell-use',
            type: 'assistant',
            content: [{
              type: 'tool_use',
              id: 'member-shell-tool',
              name: 'Bash',
              input: {
                command: 'bun run test',
                description: 'Run member tests',
                run_in_background: true,
              },
            }],
            timestamp: '2026-08-08T00:00:00.000Z',
          },
          {
            id: 'member-shell-result',
            type: 'tool_result',
            content: [{
              type: 'tool_result',
              tool_use_id: 'member-shell-tool',
              content: 'Command running in background with ID: member-shell-task. Output is being written to: /tmp/member-shell-task.output',
            }],
            timestamp: '2026-08-08T00:00:01.000Z',
          },
        ],
        signature: 'member-signature-1',
        cursor: 'member-cursor-1',
        afterOrdinal: 1,
      })
      .mockResolvedValueOnce({
        messages: [],
        taskNotifications: [{
          taskId: 'member-shell-task',
          toolUseId: 'member-shell-tool',
          status: 'completed',
          summary: 'Member tests passed',
          timestamp: '2026-08-08T00:00:02.000Z',
        }],
        signature: 'member-signature-2',
        cursor: 'member-cursor-2',
        afterOrdinal: 2,
      })
    useTeamStore.setState({
      activeTeam: {
        name: 'member-activity-team',
        members: [{
          agentId: 'worker@member-activity-team',
          role: 'worker',
          status: 'running',
        }],
      },
    })
    const sessionId = 'team-member:worker@member-activity-team'

    await useTeamStore.getState().refreshMemberSession(sessionId)
    expect(
      useChatStore.getState().sessions[sessionId]?.backgroundAgentTasks?.['member-shell-task'],
    ).toMatchObject({
      status: 'running',
      description: 'Run member tests',
      taskType: 'local_bash',
    })

    await useTeamStore.getState().refreshMemberSession(sessionId)

    const session = useChatStore.getState().sessions[sessionId]
    expect(session?.agentTaskNotifications['member-shell-tool']).toMatchObject({
      taskId: 'member-shell-task',
      status: 'completed',
    })
    expect(session?.backgroundAgentTasks?.['member-shell-task']).toMatchObject({
      taskId: 'member-shell-task',
      toolUseId: 'member-shell-tool',
      status: 'completed',
      description: 'Run member tests',
      taskType: 'local_bash',
      summary: 'Member tests passed',
      startedAt: Date.parse('2026-08-08T00:00:00.000Z'),
      updatedAt: Date.parse('2026-08-08T00:00:02.000Z'),
    })
  })

  it('does not let a stale transcript poll roll back live owner progress', async () => {
    const stalePoll = deferred<any>()
    getMemberTranscriptMock
      .mockResolvedValueOnce({
        messages: [],
        signature: 'initial-signature',
        cursor: 'initial-cursor',
        afterOrdinal: -1,
      })
      .mockReturnValueOnce(stalePoll.promise)
    const member = {
      agentId: 'worker@freshness-team',
      name: 'worker',
      role: 'worker',
      status: 'running' as const,
    }
    const team = {
      name: 'freshness-team',
      leadSessionId: 'freshness-lead',
      incarnationId: 'freshness-incarnation',
      createdAt: '2026-08-10T00:00:00.000Z',
      members: [member],
    }
    const sessionId = memberSessionId(member.agentId, team.incarnationId)
    useTeamStore.setState({
      activeTeam: team,
      memberTeamBySession: { [sessionId]: team },
    })
    await useTeamStore.getState().refreshMemberSession(sessionId)
    const unregister = registerAgentRunSession(
      team.leadSessionId,
      sessionId,
      [member.agentId],
    )

    try {
      const pendingPoll = useTeamStore.getState().refreshMemberSession(sessionId)
      useChatStore.getState().handleServerMessage(team.leadSessionId, {
        type: 'system_notification',
        subtype: 'task_started',
        data: {
          task_id: 'live-task',
          tool_use_id: 'live-tool',
          owner_agent_id: member.agentId,
          task_type: 'local_agent',
          description: 'Live nested task',
        },
      })
      expect(
        useChatStore.getState().sessions[sessionId]?.backgroundAgentTasks?.['live-task'],
      ).toMatchObject({ status: 'running' })

      stalePoll.resolve({
        messages: [],
        taskNotifications: [{
          taskId: 'live-task',
          toolUseId: 'live-tool',
          status: 'completed',
          summary: 'stale completion',
          timestamp: '2026-08-09T00:00:00.000Z',
        }],
        signature: 'stale-signature',
        cursor: 'stale-cursor',
        afterOrdinal: 0,
      })
      await pendingPoll

      expect(
        useChatStore.getState().sessions[sessionId]?.backgroundAgentTasks?.['live-task'],
      ).toMatchObject({
        status: 'running',
        description: 'Live nested task',
      })
      expect(
        useChatStore.getState().sessions[sessionId]?.agentTaskNotifications['live-tool'],
      ).toBeUndefined()
    } finally {
      unregister()
    }
  })

  it('keeps a settled live member turn when an older terminal poll resolves', async () => {
    const staleTerminalPoll = deferred<any>()
    getMemberTranscriptMock
      .mockResolvedValueOnce({ messages: [] })
      .mockReturnValueOnce(staleTerminalPoll.promise)
      .mockResolvedValueOnce({
        messages: [{
          id: 'durable-live-answer',
          type: 'assistant',
          content: [{ type: 'text', text: 'Durable teammate answer' }],
          timestamp: '2026-08-10T00:00:02.000Z',
        }],
      })
    const member = {
      agentId: 'worker@terminal-race-team',
      name: 'worker',
      role: 'worker',
      status: 'running' as const,
    }
    const team = {
      name: 'terminal-race-team',
      leadSessionId: 'terminal-race-lead',
      incarnationId: 'terminal-race-incarnation',
      createdAt: '2026-08-10T00:00:00.000Z',
      members: [member],
    }
    const sessionId = memberSessionId(member.agentId, team.incarnationId)
    useTeamStore.setState({
      activeTeam: team,
      memberTeamBySession: { [sessionId]: team },
    })
    await useTeamStore.getState().refreshMemberSession(sessionId)
    const unregister = registerAgentRunSession(
      team.leadSessionId,
      sessionId,
      [member.agentId],
    )

    try {
      const pendingPoll = useTeamStore.getState().refreshMemberSession(sessionId)
      const send = (event: Extract<import('../types/chat').ServerMessage, { type: 'agent_run_event' }>['event']) => {
        useChatStore.getState().handleServerMessage(team.leadSessionId, {
          type: 'agent_run_event',
          runAgentId: 'terminal-race-worker-run',
          streamId: 'terminal-race-stream',
          targetAgentId: member.agentId,
          event,
        })
      }
      send({ type: 'content_start', blockType: 'text' })
      send({ type: 'content_delta', text: 'Live teammate answer' })
      send({ type: 'status', state: 'idle' })

      const completedTeam = {
        ...team,
        members: [{ ...member, status: 'completed' as const }],
      }
      useTeamStore.setState({
        activeTeam: completedTeam,
        memberTeamBySession: { [sessionId]: completedTeam },
      })
      staleTerminalPoll.resolve({ messages: [] })
      await pendingPoll

      expect(useChatStore.getState().sessions[sessionId]?.messages).toEqual([
        expect.objectContaining({ content: 'Live teammate answer' }),
      ])
      expect(useChatStore.getState().sessions[sessionId]?.agentStreamRevision).toBe(2)

      await useTeamStore.getState().refreshMemberSession(sessionId)
      expect(useChatStore.getState().sessions[sessionId]?.messages).toEqual([
        expect.objectContaining({ content: 'Durable teammate answer' }),
      ])
      expect(useChatStore.getState().sessions[sessionId]?.agentStreamRevision).toBe(0)
    } finally {
      unregister()
    }
  })

  it('backfills durable member history ahead of an active live stream and converges without duplicates', async () => {
    const initialTranscript = deferred<any>()
    const now = new Date().toISOString()
    getMemberTranscriptMock
      .mockReturnValueOnce(initialTranscript.promise)
      .mockResolvedValueOnce({
        messages: [
          {
            id: 'durable-tool-result',
            type: 'tool_result',
            content: [{
              type: 'tool_result',
              tool_use_id: 'durable-fragment/Read:0',
              original_tool_use_id: 'Read:0',
              content: 'file body',
            }],
            timestamp: now,
          },
          {
            id: 'durable-final-answer',
            type: 'assistant',
            content: [{ type: 'text', text: 'Done.' }],
            timestamp: now,
          },
        ],
        signature: 'terminal-signature',
        cursor: 'terminal-cursor',
        afterOrdinal: 3,
      })
    const member = {
      agentId: 'worker@live-transcript-team',
      name: 'worker',
      role: 'worker',
      status: 'running' as const,
      activity: 'active' as const,
    }
    const team = {
      name: 'live-transcript-team',
      leadSessionId: 'live-transcript-lead',
      incarnationId: 'live-transcript-incarnation',
      createdAt: '2026-08-10T00:00:00.000Z',
      members: [member],
    }
    const sessionId = memberSessionId(member.agentId, team.incarnationId)
    useTeamStore.setState({
      activeTeam: team,
      memberTeamBySession: { [sessionId]: team },
    })
    const pendingInitialRead = useTeamStore.getState().refreshMemberSession(sessionId)
    const unregister = registerAgentRunSession(
      team.leadSessionId,
      sessionId,
      [member.agentId],
      { streamEventIdPrefix: 'runAgentId' },
    )

    const send = (event: Extract<import('../types/chat').ServerMessage, { type: 'agent_run_event' }>['event']) => {
      useChatStore.getState().handleServerMessage(team.leadSessionId, {
        type: 'agent_run_event',
        runAgentId: 'live-fragment',
        streamId: 'live-transcript-stream',
        targetAgentId: member.agentId,
        event,
      })
    }

    try {
      send({ type: 'thinking', text: 'Working through the request', complete: true })
      send({ type: 'content_start', blockType: 'text' })
      send({ type: 'content_delta', text: 'Live preface' })
      send({
        type: 'content_start',
        blockType: 'tool_use',
        toolName: 'Read',
        toolUseId: 'Read:0',
      })
      useChatStore.setState((state) => ({
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...state.sessions[sessionId]!,
            streamingText: 'Live preface — unpersisted live tail',
            streamingToolInput: '{"file_path":',
          },
        },
      }))

      initialTranscript.resolve({
        messages: [
          {
            id: 'captain-initial-prompt',
            type: 'user',
            content: '<teammate-message teammate_id="team-lead" color="blue">Implement the API</teammate-message>',
            timestamp: now,
          },
          {
            id: 'durable-active-turn',
            type: 'assistant',
            content: [
              { type: 'thinking', thinking: 'Working through the request' },
              { type: 'text', text: 'Live preface' },
              {
                type: 'tool_use',
                id: 'durable-fragment/Read:0',
                original_tool_use_id: 'Read:0',
                name: 'Read',
                input: { file_path: '/tmp/input.ts' },
              },
            ],
            timestamp: now,
          },
        ],
        signature: 'active-signature',
        cursor: 'active-cursor',
        afterOrdinal: 1,
      })
      await pendingInitialRead

      const activeSession = useChatStore.getState().sessions[sessionId]!
      expect(activeSession.messages.map(message => message.type)).toEqual([
        'user_text',
        'thinking',
        'assistant_text',
        'tool_use',
      ])
      expect(activeSession.messages[0]).toMatchObject({
        content: 'Implement the API',
        teammateFrom: 'team-lead',
      })
      expect(activeSession.messages.filter(message => message.type === 'tool_use')).toEqual([
        expect.objectContaining({
          toolUseId: 'live-fragment/Read:0',
          isPending: true,
        }),
      ])
      expect(activeSession.messages.filter(message => message.type === 'thinking')).toHaveLength(1)
      expect(activeSession.messages.filter(message => message.type === 'assistant_text')).toHaveLength(1)
      expect(activeSession.chatState).toBe('tool_executing')
      expect(activeSession.agentStreamRevision).toBe(1)
      expect(activeSession.activeToolUseId).toBe('live-fragment/Read:0')
      expect(activeSession.streamingText).toBe(' — unpersisted live tail')
      expect(activeSession.streamingToolInput).toBe('{"file_path":')

      send({
        type: 'tool_use_complete',
        toolName: 'Read',
        toolUseId: 'Read:0',
        input: { file_path: '/tmp/input.ts' },
      })
      send({
        type: 'tool_result',
        toolUseId: 'Read:0',
        content: 'file body',
        isError: false,
      })
      send({ type: 'status', state: 'idle' })
      const completedTeam = {
        ...team,
        members: [{ ...member, status: 'completed' as const, activity: 'exited' as const }],
      }
      useTeamStore.setState({
        activeTeam: completedTeam,
        memberTeamBySession: { [sessionId]: completedTeam },
      })

      await useTeamStore.getState().refreshMemberSession(sessionId)

      const settledSession = useChatStore.getState().sessions[sessionId]!
      expect(settledSession.messages[0]).toMatchObject({
        type: 'user_text',
        content: 'Implement the API',
      })
      expect(settledSession.messages.filter(message => message.type === 'tool_use')).toHaveLength(1)
      expect(settledSession.messages.filter(message => message.type === 'tool_result')).toHaveLength(1)
      expect(settledSession.messages.filter(message => (
        message.type === 'assistant_text' && message.content === 'Live preface'
      ))).toHaveLength(1)
      expect(settledSession.messages.filter(message => (
        message.type === 'assistant_text' && message.content === 'Done.'
      ))).toHaveLength(1)
      expect(settledSession.chatState).toBe('idle')
      expect(settledSession.agentStreamRevision).toBe(0)
    } finally {
      unregister()
    }
  })

  it('joins physical-owner live activity with its fragment-scoped transcript identity', async () => {
    getMemberTranscriptMock
      .mockResolvedValueOnce({
        messages: [],
        ownerAgentIds: ['physical-fragment'],
        signature: 'initial-signature',
        cursor: 'initial-cursor',
        afterOrdinal: -1,
      })
      .mockResolvedValueOnce({
        messages: [],
        ownerAgentIds: ['physical-fragment'],
        taskNotifications: [{
          taskId: 'physical-fragment/reused-task',
          toolUseId: 'physical-fragment/reused-tool',
          status: 'completed',
          summary: 'durable completion',
          timestamp: '2026-08-10T00:00:02.000Z',
        }],
        signature: 'completed-signature',
        cursor: 'completed-cursor',
        afterOrdinal: 0,
      })
    const member = {
      agentId: 'worker@scoped-team',
      name: 'worker',
      role: 'worker',
      status: 'running' as const,
    }
    const team = {
      name: 'scoped-team',
      leadSessionId: 'scoped-lead',
      incarnationId: 'scoped-incarnation',
      createdAt: '2026-08-10T00:00:00.000Z',
      members: [member],
    }
    const sessionId = memberSessionId(member.agentId, team.incarnationId)
    useTeamStore.setState({
      activeTeam: team,
      memberTeamBySession: { [sessionId]: team },
    })
    await useTeamStore.getState().refreshMemberSession(sessionId)
    const unregister = registerAgentRunSession(
      team.leadSessionId,
      sessionId,
      ['physical-fragment'],
      { eventIdPrefix: 'physical-fragment' },
    )

    try {
      useChatStore.getState().handleServerMessage(team.leadSessionId, {
        type: 'system_notification',
        subtype: 'task_started',
        data: {
          task_id: 'reused-task',
          tool_use_id: 'reused-tool',
          owner_agent_id: 'physical-fragment',
          task_type: 'local_agent',
          description: 'Live physical task',
        },
      })
      expect(Object.keys(
        useChatStore.getState().sessions[sessionId]?.backgroundAgentTasks ?? {},
      )).toEqual(['physical-fragment/reused-task'])

      await useTeamStore.getState().refreshMemberSession(sessionId)

      const session = useChatStore.getState().sessions[sessionId]
      expect(Object.keys(session?.backgroundAgentTasks ?? {})).toEqual([
        'physical-fragment/reused-task',
      ])
      expect(session?.backgroundAgentTasks?.['physical-fragment/reused-task']).toMatchObject({
        taskId: 'physical-fragment/reused-task',
        toolUseId: 'physical-fragment/reused-tool',
        status: 'completed',
        summary: 'durable completion',
      })
      expect(Object.keys(session?.agentTaskNotifications ?? {})).toEqual([
        'physical-fragment/reused-tool',
      ])
    } finally {
      unregister()
    }
  })

  it('routes team updates to the matching member session instead of the active team', async () => {
    getMemberTranscriptMock.mockResolvedValue({ messages: [] })
    const memberSession = 'team-member:worker@team-a'
    const teamA = {
      name: 'team-a',
      leadSessionId: 'lead-a',
      members: [{
        agentId: 'worker@team-a',
        name: 'worker-a',
        role: 'worker',
        status: 'running' as const,
      }],
    }
    const teamB = {
      name: 'team-b',
      leadSessionId: 'lead-b',
      members: [{
        agentId: 'worker@team-b',
        name: 'worker-b',
        role: 'worker',
        status: 'running' as const,
      }],
    }
    useTeamStore.setState({
      activeTeam: teamB,
      memberTeamBySession: { [memberSession]: teamA },
      workbenchesBySession: {
        'lead-a': {
          teamName: 'team-a',
          loading: false,
          error: null,
          snapshots: [{
            version: 'team-a-v1',
            generatedAt: '2026-08-10T00:00:00.000Z',
            team: teamA,
            tasks: [],
            messages: [],
          }],
        },
      },
    })
    useTabStore.setState({
      tabs: [{
        sessionId: memberSession,
        title: 'worker-a',
        type: 'team-member',
        status: 'idle',
        sourceSessionId: 'lead-a',
        teamLeadSessionId: 'lead-a',
        teamMemberAgentId: 'worker@team-a',
      }],
      activeTabId: memberSession,
    })

    useTeamStore.getState().handleTeamUpdate('team-a', [{
      agentId: 'worker@team-a',
      role: 'worker',
      status: 'completed',
    }])
    await vi.waitFor(() => {
      expect(useTeamStore.getState().getMemberBySessionId(memberSession)?.status)
        .toBe('completed')
    })
    expect(useTeamStore.getState().activeTeam?.name).toBe('team-b')
    const callsAfterTeamAUpdate = getMemberTranscriptMock.mock.calls.length

    useTeamStore.getState().handleTeamUpdate('team-b', [{
      agentId: 'worker@team-b',
      role: 'worker',
      status: 'completed',
    }])
    await Promise.resolve()

    expect(getMemberTranscriptMock).toHaveBeenCalledTimes(callsAfterTeamAUpdate)
    expect(useTeamStore.getState().getMemberBySessionId(memberSession)?.status)
      .toBe('completed')
    useTabStore.getState().closeTab(memberSession)
  })
})

describe('teamStore workbench timeline', () => {
  beforeEach(() => {
    vi.useRealTimers()
    getWorkbenchForSessionMock.mockReset()
    getWorkbenchMock.mockReset()
    getTeamMock.mockReset()
    useTeamStore.getState().clearTeam()
  })

  afterEach(() => {
    useTeamStore.getState().clearTeam()
  })

  it('keeps each member model through the roster read instead of dropping it', async () => {
    const snapshot = workbench('v1', 'in_progress')
    getWorkbenchForSessionMock.mockResolvedValue({
      sessionId: 'lead-session',
      teamName: 'team-workbench',
      snapshots: [{
        ...snapshot,
        team: {
          ...snapshot.team,
          members: [
            { ...snapshot.team.members[0]!, model: 'claude-opus-4-8' },
            // A mapped provider id is not a known family — it must still survive
            // verbatim rather than being normalised away.
            { ...snapshot.team.members[1]!, model: 'qwen3.7-plus[1m]' },
          ],
        },
      }],
      source: 'live',
    })

    await useTeamStore.getState().fetchTeamForSession('lead-session', { force: true })

    const members = useTeamStore.getState()
      .workbenchesBySession['lead-session']?.snapshots.at(-1)?.team.members ?? []
    expect(members.map(member => member.model)).toEqual(['claude-opus-4-8', 'qwen3.7-plus[1m]'])
  })

  it('reports no model rather than inventing one when the roster omits it', async () => {
    const snapshot = workbench('v1', 'in_progress')
    getWorkbenchForSessionMock.mockResolvedValue({
      sessionId: 'lead-session',
      teamName: 'team-workbench',
      snapshots: [snapshot],
      source: 'live',
    })

    await useTeamStore.getState().fetchTeamForSession('lead-session', { force: true })

    const members = useTeamStore.getState()
      .workbenchesBySession['lead-session']?.snapshots.at(-1)?.team.members ?? []
    expect(members.map(member => member.model)).toEqual([undefined, undefined])
  })

  it('keeps unknown watcher identities out of each roster and refreshes authoritative data', () => {
    getTeamMock.mockReturnValue(new Promise(() => {}))
    getWorkbenchMock.mockReturnValue(new Promise(() => {}))
    const snapshot = workbench('v1', 'in_progress')
    const memberSession = memberSessionId('lead@team-workbench')
    useTeamStore.setState({
      activeTeam: snapshot.team,
      memberTeamBySession: {
        [memberSession]: {
          ...snapshot.team,
          members: [snapshot.team.members[0]!],
        },
      },
      workbenchesBySession: {
        'lead-session': {
          teamName: 'team-workbench',
          snapshots: [snapshot],
          loading: false,
          error: null,
        },
      },
    })

    useTeamStore.getState().handleTeamUpdate('team-workbench', [
      {
        agentId: 'worker@team-workbench',
        role: 'worker',
        status: 'completed',
        activity: 'exited',
      },
      { agentId: 'Read@team-workbench', role: 'Read', status: 'running' },
      { agentId: 'TaskCreate@team-workbench', role: 'TaskCreate', status: 'running' },
    ])

    const state = useTeamStore.getState()
    expect(state.activeTeam?.members).toEqual([
      expect.objectContaining({ agentId: 'lead@team-workbench' }),
      expect.objectContaining({
        agentId: 'worker@team-workbench',
        status: 'completed',
        activity: 'exited',
      }),
    ])
    expect(state.memberTeamBySession[memberSession]?.members.map((member) => member.agentId))
      .toEqual(['lead@team-workbench'])
    expect(
      state.workbenchesBySession['lead-session']?.snapshots.at(-1)?.team.members.map(
        (member) => member.agentId,
      ),
    ).toEqual(['lead@team-workbench', 'worker@team-workbench'])
    expect(
      state.workbenchesBySession['lead-session']?.snapshots.at(-1)?.team.members[1],
    ).toMatchObject({ status: 'completed', activity: 'exited' })
    expect(getTeamMock).toHaveBeenCalledWith('team-workbench')
    expect(getWorkbenchMock).toHaveBeenCalledWith('team-workbench')
  })

  it('keeps collecting live snapshots while the user remains on a historical state', async () => {
    getWorkbenchMock
      .mockResolvedValueOnce(workbench('v1', 'pending'))
      .mockResolvedValueOnce(workbench('v2', 'in_progress'))
      .mockResolvedValueOnce(workbench('v3', 'completed'))

    await useTeamStore.getState().fetchWorkbench('team-workbench')
    await useTeamStore.getState().fetchWorkbench('team-workbench')
    useTeamStore.getState().setWorkbenchHistoryIndex('lead-session', 0)
    useTeamStore.getState().handleTeamWorkbenchUpdated('team-workbench')
    await vi.waitFor(() => {
      expect(useTeamStore.getState().workbenchesBySession['lead-session']?.snapshots).toHaveLength(3)
    })

    const state = useTeamStore.getState()
    expect(state.workbenchHistoryIndexBySession['lead-session']).toBe(0)
    expect(state.workbenchesBySession['lead-session']?.snapshots.map((entry) => entry.version)).toEqual([
      'v1',
      'v2',
      'v3',
    ])
  })

  it('ignores a stale workbench error after the same team name is recreated', async () => {
    const staleWorkbench = deferred<TeamWorkbenchSnapshot>()
    const recreated = {
      ...workbench('recreated-v1', 'in_progress'),
      team: {
        ...workbench('recreated-v1', 'in_progress').team,
        createdAt: '2026-08-10T00:00:02.000Z',
      },
    }
    getWorkbenchMock
      .mockReturnValueOnce(staleWorkbench.promise)
      .mockResolvedValueOnce(recreated)
    getTeamMock.mockResolvedValue(recreated.team)

    const staleRequest = useTeamStore.getState().fetchWorkbench('team-workbench')
    useTeamStore.getState().handleTeamDeleted('team-workbench', 'lead-session')
    useTeamStore.getState().handleTeamCreated('team-workbench', 'lead-session')
    await vi.waitFor(() => {
      expect(
        useTeamStore.getState().workbenchesBySession['lead-session']?.snapshots.at(-1)?.version,
      ).toBe('recreated-v1')
    })
    staleWorkbench.reject(new Error('stale workbench failed'))
    await staleRequest

    expect(useTeamStore.getState().workbenchesBySession['lead-session']).toMatchObject({
      error: null,
      loading: false,
      snapshots: [expect.objectContaining({ version: 'recreated-v1' })],
    })
  })

  it('deduplicates unchanged snapshots and appends a durable disbanded tombstone', async () => {
    getWorkbenchMock
      .mockResolvedValueOnce(workbench('v1', 'completed'))
      .mockResolvedValueOnce(workbench('v1', 'completed'))

    await useTeamStore.getState().fetchWorkbench('team-workbench')
    await useTeamStore.getState().fetchWorkbench('team-workbench')
    expect(useTeamStore.getState().workbenchesBySession['lead-session']?.snapshots).toHaveLength(1)

    useTeamStore.getState().handleTeamDeleted('team-workbench')
    const snapshots = useTeamStore.getState().workbenchesBySession['lead-session']?.snapshots ?? []
    expect(snapshots).toHaveLength(2)
    expect(snapshots[1]).toMatchObject({
      version: 'v1:deleted',
      team: {
        members: [
          expect.objectContaining({ status: 'completed' }),
          expect.objectContaining({ status: 'completed' }),
        ],
      },
    })
    expect(snapshots[1]?.deletedAt).toBeTruthy()
  })

  it('discovers a newer same-name incarnation past a cached tombstone', async () => {
    getWorkbenchMock.mockResolvedValueOnce(workbench('old-v1', 'completed'))
    await useTeamStore.getState().fetchWorkbench('team-workbench')
    useTeamStore.getState().handleTeamDeleted('team-workbench', 'lead-session')
    expect(
      useTeamStore.getState().workbenchesBySession['lead-session']?.snapshots.at(-1)?.deletedAt,
    ).toBeTruthy()

    const discovery = deferred<{
      sessionId: string
      teamName: string
      source: 'live'
      snapshots: TeamWorkbenchSnapshot[]
    }>()
    getWorkbenchForSessionMock.mockReturnValue(discovery.promise)
    const pendingDiscovery = useTeamStore.getState().fetchTeamForSession('lead-session')

    expect(getWorkbenchForSessionMock).toHaveBeenCalledWith('lead-session')

    const recreated = {
      ...workbench('new-v1', 'in_progress'),
      team: {
        ...workbench('new-v1', 'in_progress').team,
        createdAt: new Date(Date.now() + 1_000).toISOString(),
      },
    }
    discovery.resolve({
      sessionId: 'lead-session',
      teamName: 'team-workbench',
      source: 'live',
      snapshots: [recreated],
    })
    await pendingDiscovery

    const state = useTeamStore.getState()
    expect(state.workbenchesBySession['lead-session']?.snapshots).toEqual([recreated])
    expect(state.teamNameBySession['lead-session']).toBe('team-workbench')
    expect(state.activeTeam?.createdAt).toBe(recreated.team.createdAt)
  })

  it('restores an archived workbench by lead session without changing tabs', async () => {
    const archived = {
      ...workbench('v9', 'completed'),
      deletedAt: '2026-08-08T00:10:00.000Z',
    }
    getWorkbenchForSessionMock.mockResolvedValue({
      sessionId: 'lead-session',
      teamName: 'team-workbench',
      source: 'archive',
      snapshots: [archived],
    })

    await useTeamStore.getState().fetchTeamForSession('lead-session')

    const state = useTeamStore.getState()
    expect(getWorkbenchForSessionMock).toHaveBeenCalledWith('lead-session')
    expect(state.workbenchesBySession['lead-session']).toMatchObject({
      teamName: 'team-workbench',
      snapshots: [expect.objectContaining({ version: 'v9', deletedAt: archived.deletedAt })],
    })
    expect(state.activeTeam?.name).toBe('team-workbench')
    expect(useTabStore.getState().tabs.some((tab) => tab.type === 'team')).toBe(false)
  })

  it('forces durable discovery after a reconnect even with a cached live workbench', async () => {
    const oldSnapshot = {
      ...workbench('old-live', 'in_progress'),
      team: {
        ...workbench('old-live', 'in_progress').team,
        incarnationId: 'old-live-incarnation',
        createdAt: '2026-08-10T00:00:00.000Z',
      },
    }
    const newSnapshot = {
      ...workbench('new-live', 'in_progress'),
      team: {
        ...workbench('new-live', 'in_progress').team,
        incarnationId: 'new-live-incarnation',
        createdAt: '2026-08-10T00:01:00.000Z',
      },
    }
    getWorkbenchForSessionMock
      .mockResolvedValueOnce({
        sessionId: 'lead-session',
        teamName: 'team-workbench',
        incarnationId: 'old-live-incarnation',
        source: 'live',
        snapshots: [oldSnapshot],
      })
      .mockResolvedValueOnce({
        sessionId: 'lead-session',
        teamName: 'team-workbench',
        incarnationId: 'new-live-incarnation',
        source: 'live',
        snapshots: [newSnapshot],
      })

    await useTeamStore.getState().fetchTeamForSession('lead-session')
    const oldMemberSessionId = memberSessionId(
      'worker@team-workbench',
      'old-live-incarnation',
    )
    getMemberTranscriptMock.mockResolvedValueOnce({
      messages: [{
        id: 'old-live-member-message',
        type: 'assistant',
        content: 'old live member',
        timestamp: '2026-08-10T00:00:10.000Z',
      }],
    })
    const oldMember = oldSnapshot.team.members.find(
      (member) => member.agentId === 'worker@team-workbench',
    )!
    useTeamStore.getState().openMemberSession(oldMember, oldSnapshot.team, oldSnapshot)
    await useTeamStore.getState().ensureMemberSession(oldMemberSessionId)
    expect(useChatStore.getState().sessions[oldMemberSessionId]).toBeDefined()
    expect(useTabStore.getState().tabs).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: oldMemberSessionId, type: 'team-member' }),
    ]))
    await useTeamStore.getState().fetchTeamForSession('lead-session')
    expect(getWorkbenchForSessionMock).toHaveBeenCalledTimes(1)

    await useTeamStore.getState().fetchTeamForSession('lead-session', { force: true })

    expect(getWorkbenchForSessionMock).toHaveBeenCalledTimes(2)
    expect(
      useTeamStore.getState().workbenchesBySession['lead-session']?.snapshots.at(-1)?.team.incarnationId,
    ).toBe('new-live-incarnation')
    expect(useChatStore.getState().sessions[oldMemberSessionId]).toBeUndefined()
    expect(useTeamStore.getState().memberTeamBySession[oldMemberSessionId]).toBeUndefined()
    expect(useTeamStore.getState().memberSnapshotBySession[oldMemberSessionId]).toBeUndefined()
    expect(useTabStore.getState().tabs.some((tab) => tab.sessionId === oldMemberSessionId)).toBe(false)
  })

  it('opens same-name Team activity rows in their exact archived incarnations', async () => {
    const teamName = 'reused-activity-team'
    const leadSessionId = 'reused-activity-lead'
    const member = {
      agentId: `reviewer@${teamName}`,
      name: 'reviewer',
      role: 'reviewer',
      status: 'completed' as const,
    }
    const makeTimeline = (incarnationId: string, createdAt: string, taskSubject: string) => ({
      sessionId: leadSessionId,
      teamName,
      incarnationId,
      source: 'archive' as const,
      snapshots: [{
        version: incarnationId,
        generatedAt: createdAt,
        team: {
          name: teamName,
          leadSessionId,
          leadAgentId: `team-lead@${teamName}`,
          incarnationId,
          createdAt,
          members: [member],
        },
        tasks: [{
          id: '1',
          subject: taskSubject,
          description: taskSubject,
          owner: member.agentId,
          status: 'completed' as const,
          blocks: [],
          blockedBy: [],
          taskListId: teamName,
        }],
        messages: [],
      }],
    })
    getWorkbenchForSessionMock
      .mockResolvedValueOnce(makeTimeline(
        'activity-incarnation-a',
        '2026-08-10T00:00:00.000Z',
        'Incarnation A task',
      ))
      .mockResolvedValueOnce(makeTimeline(
        'activity-incarnation-b',
        '2026-08-10T01:00:00.000Z',
        'Incarnation B task',
      ))
    getMemberTranscriptMock.mockResolvedValue({
      messages: [],
      taskNotifications: [],
      ownerAgentIds: [],
    })

    expect(await useTeamStore.getState().openMemberFromActivity(
      leadSessionId,
      teamName,
      'reviewer',
      Date.parse('2026-08-10T00:10:00.000Z'),
    )).toBe(true)
    expect(await useTeamStore.getState().openMemberFromActivity(
      leadSessionId,
      teamName,
      'reviewer',
      Date.parse('2026-08-10T01:10:00.000Z'),
    )).toBe(true)

    expect(getWorkbenchForSessionMock.mock.calls).toEqual([
      [leadSessionId, {
        teamName,
        at: Date.parse('2026-08-10T00:10:00.000Z'),
      }],
      [leadSessionId, {
        teamName,
        at: Date.parse('2026-08-10T01:10:00.000Z'),
      }],
    ])
    const oldSessionId = memberSessionId(member.agentId, 'activity-incarnation-a')
    const newSessionId = memberSessionId(member.agentId, 'activity-incarnation-b')
    expect(useTabStore.getState().tabs).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: oldSessionId, teamIncarnationId: 'activity-incarnation-a' }),
      expect.objectContaining({ sessionId: newSessionId, teamIncarnationId: 'activity-incarnation-b' }),
    ]))
    expect(
      useTeamStore.getState().memberSnapshotBySession[oldSessionId]?.tasks[0]?.subject,
    ).toBe('Incarnation A task')
    expect(
      useTeamStore.getState().memberSnapshotBySession[newSessionId]?.tasks[0]?.subject,
    ).toBe('Incarnation B task')
  })

  it('keeps exact deletion isolated across lead sessions with the same team name', async () => {
    const teamA = {
      name: 'shared-name',
      leadSessionId: 'lead-a',
      incarnationId: 'incarnation-a',
      createdAt: '2026-08-10T00:00:00.000Z',
      members: [{ agentId: 'worker@shared-name', role: 'worker', status: 'running' as const }],
    }
    const teamB = {
      ...teamA,
      leadSessionId: 'lead-b',
      incarnationId: 'incarnation-b',
      createdAt: '2026-08-10T00:01:00.000Z',
    }
    const snapshotFor = (version: string, team: typeof teamA): TeamWorkbenchSnapshot => ({
      version,
      generatedAt: '2026-08-10T00:02:00.000Z',
      team,
      tasks: [],
      messages: [],
    })
    useTeamStore.setState({
      activeTeam: teamB,
      teams: [
        { name: 'shared-name', memberCount: 1, incarnationId: teamB.incarnationId },
      ],
      workbenchesBySession: {
        'lead-a': {
          teamName: 'shared-name',
          snapshots: [snapshotFor('a', teamA)],
          loading: false,
          error: null,
        },
        'lead-b': {
          teamName: 'shared-name',
          snapshots: [snapshotFor('b', teamB)],
          loading: false,
          error: null,
        },
      },
    })

    useTeamStore.getState().handleTeamDeleted(
      'shared-name',
      'lead-a',
      { incarnationId: 'incarnation-a' },
    )

    expect(
      useTeamStore.getState().workbenchesBySession['lead-a']?.snapshots.at(-1)?.deletedAt,
    ).toBeTruthy()
    expect(
      useTeamStore.getState().workbenchesBySession['lead-b']?.snapshots.at(-1)?.deletedAt,
    ).toBeUndefined()
    expect(useTeamStore.getState().activeTeam?.incarnationId).toBe('incarnation-b')
  })

  it('does not resurrect an active team when discovery resolves after deletion', async () => {
    const discovery = deferred<{
      sessionId: string
      teamName: string
      source: 'live'
      snapshots: TeamWorkbenchSnapshot[]
    }>()
    getWorkbenchForSessionMock.mockReturnValue(discovery.promise)

    const pendingDiscovery = useTeamStore.getState().fetchTeamForSession('lead-session')
    useTeamStore.getState().handleTeamDeleted('team-workbench', 'lead-session')
    discovery.resolve({
      sessionId: 'lead-session',
      teamName: 'team-workbench',
      source: 'live',
      snapshots: [workbench('late-v1', 'in_progress')],
    })
    await pendingDiscovery

    const state = useTeamStore.getState()
    expect(state.teamNameBySession['lead-session']).toBeUndefined()
    expect(state.activeTeamStartedAtBySession['lead-session']).toBeUndefined()
    expect(state.workbenchesBySession['lead-session']).toBeUndefined()
    expect(state.activeTeam).toBeNull()
  })

  it('restores a deleted team archive discovered after its live lifecycle ended', async () => {
    useTeamStore.getState().handleTeamDeleted('team-workbench', 'lead-session')
    const archived = {
      ...workbench('archive-v1', 'completed'),
      deletedAt: '2026-08-10T00:10:00.000Z',
    }
    getWorkbenchForSessionMock.mockResolvedValue({
      sessionId: 'lead-session',
      teamName: 'team-workbench',
      source: 'archive',
      snapshots: [archived],
    })

    await useTeamStore.getState().fetchTeamForSession('lead-session')

    const state = useTeamStore.getState()
    expect(state.workbenchesBySession['lead-session']?.snapshots).toEqual([archived])
    expect(state.teamNameBySession['lead-session']).toBeUndefined()
    expect(state.activeTeamStartedAtBySession['lead-session']).toBeUndefined()
  })

  it('accepts a newer same-name incarnation when its create event was missed', async () => {
    useTeamStore.getState().handleTeamDeleted('team-workbench', 'lead-session')
    const recreated = {
      ...workbench('new-v1', 'in_progress'),
      team: {
        ...workbench('new-v1', 'in_progress').team,
        createdAt: new Date(Date.now() + 1_000).toISOString(),
      },
    }
    getWorkbenchForSessionMock.mockResolvedValue({
      sessionId: 'lead-session',
      teamName: 'team-workbench',
      source: 'live',
      snapshots: [recreated],
    })

    await useTeamStore.getState().fetchTeamForSession('lead-session')

    const state = useTeamStore.getState()
    expect(state.workbenchesBySession['lead-session']?.snapshots).toEqual([recreated])
    expect(state.teamNameBySession['lead-session']).toBe('team-workbench')
  })

  it('does not mistake the lead session for the synthetic team-lead conversation', () => {
    useTeamStore.setState({
      activeTeam: {
        name: 'team-workbench',
        leadAgentId: 'lead@team-workbench',
        leadSessionId: 'lead-session',
        members: [{
          agentId: 'lead@team-workbench',
          name: 'lead',
          role: 'lead',
          status: 'completed',
          sessionId: 'lead-session',
        }],
      },
    })

    expect(useTeamStore.getState().getMemberBySessionId('lead-session')).toBeNull()
    expect(
      useTeamStore.getState().getMemberBySessionId('team-member:lead@team-workbench'),
    ).toMatchObject({ agentId: 'lead@team-workbench' })
  })
})
