import { beforeEach, describe, expect, it, vi } from 'vitest'
import { openDesktopNotificationTarget } from './desktopNotificationNavigation'
import { SCHEDULED_TAB_ID, useTabStore } from '../stores/tabStore'
import { useChatStore } from '../stores/chatStore'
import { useSessionStore } from '../stores/sessionStore'

const initialTabState = useTabStore.getInitialState()
const initialChatState = useChatStore.getInitialState()
const initialSessionState = useSessionStore.getInitialState()

describe('desktopNotificationNavigation', () => {
  beforeEach(() => {
    useTabStore.setState(initialTabState, true)
    useChatStore.setState(initialChatState, true)
    useSessionStore.setState(initialSessionState, true)
  })

  it('opens and connects the session referenced by a notification target', () => {
    const connectToSession = vi.fn()
    useChatStore.setState({ connectToSession })

    openDesktopNotificationTarget({
      type: 'session',
      sessionId: 'session-1',
      title: 'Build fix',
    })

    expect(useTabStore.getState().tabs).toEqual([
      { sessionId: 'session-1', title: 'Build fix', type: 'session', status: 'idle' },
    ])
    expect(useTabStore.getState().activeTabId).toBe('session-1')
    expect(connectToSession).toHaveBeenCalledWith('session-1')
  })

  it('uses the known session title when the notification omits one', () => {
    const connectToSession = vi.fn()
    useSessionStore.setState({
      sessions: [{
        id: 'session-2',
        title: 'Known Session',
        createdAt: '2026-05-06T00:00:00.000Z',
        modifiedAt: '2026-05-06T00:00:00.000Z',
        messageCount: 1,
        projectPath: '/workspace/project',
        workDir: '/workspace/project',
        workDirExists: true,
      }],
    })
    useChatStore.setState({ connectToSession })

    openDesktopNotificationTarget({ type: 'session', sessionId: 'session-2' })

    expect(useTabStore.getState().tabs[0]).toMatchObject({
      sessionId: 'session-2',
      title: 'Known Session',
      type: 'session',
    })
    expect(connectToSession).toHaveBeenCalledWith('session-2')
  })

  it('opens the scheduled tasks tab for scheduled notification targets', () => {
    const connectToSession = vi.fn()
    useChatStore.setState({ connectToSession })

    openDesktopNotificationTarget({ type: 'scheduled' })

    expect(useTabStore.getState().tabs).toEqual([
      { sessionId: SCHEDULED_TAB_ID, title: 'Scheduled Tasks', type: 'scheduled', status: 'idle' },
    ])
    expect(useTabStore.getState().activeTabId).toBe(SCHEDULED_TAB_ID)
    expect(connectToSession).not.toHaveBeenCalled()
  })
})
