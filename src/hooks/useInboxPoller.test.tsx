import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { PassThrough } from 'node:stream'
import React from 'react'
import { render } from 'ink'
import type { AppState } from '../state/AppState.js'
import type { TeammateMessage } from '../utils/teammateMailbox.js'

const mailboxModule = await import('../utils/teammateMailbox.js')
const useHooksTsModule = await import('usehooks-ts')
const terminalNotificationModule = await import(
  '../ink/useTerminalNotification.js'
)
const appStateModule = await import('../state/AppState.js')
const teammateModule = await import('../utils/teammate.js')
const teammateContextModule = await import('../utils/teammateContext.js')
const teamHelpersModule = await import('../utils/swarm/teamHelpers.js')
const originalTeamHelpers = { ...teamHelpersModule }
const backendRegistryModule = await import(
  '../utils/swarm/backends/registry.js'
)
const backendDetectionModule = await import(
  '../utils/swarm/backends/detection.js'
)
const tasksModule = await import('../utils/tasks.js')

let intervalCallback: (() => void) | undefined
let state: AppState
let unreadMessages: TeammateMessage[] = []
let teamFileReadCount = 0

const markAllRead = mock(async () => {
  unreadMessages = unreadMessages.map(message => ({ ...message, read: true }))
})
const markReadByPredicate = mock(
  async (
    _agentName: string,
    predicate: (message: TeammateMessage) => boolean,
  ) => {
    unreadMessages = unreadMessages.map(message =>
      !message.read && predicate(message)
        ? { ...message, read: true }
        : message,
    )
  },
)
const removeTeammate = mock(() => {})
const killPane = mock(async () => true)

const store = {
  getState: () => state,
  setState: (updater: (previous: AppState) => AppState) => {
    state = updater(state)
  },
  subscribe: () => () => {},
}

mock.module('usehooks-ts', () => ({
  ...useHooksTsModule,
  useInterval: (callback: () => void) => {
    intervalCallback = callback
  },
}))

mock.module('../state/AppState.js', () => ({
  ...appStateModule,
  useAppStateStore: () => store,
  useSetAppState: () => store.setState,
  useAppState: (selector: (current: AppState) => unknown) => selector(state),
}))

mock.module('../ink/useTerminalNotification.js', () => ({
  ...terminalNotificationModule,
  useTerminalNotification: () => async () => {},
}))

mock.module('../services/notifier.js', () => ({
  sendNotification: async () => {},
}))

mock.module('../utils/teammate.js', () => ({
  ...teammateModule,
  getAgentName: () => undefined,
  isPlanModeRequired: () => false,
  isTeamLead: () => true,
  isTeammate: () => false,
}))

mock.module('../utils/teammateContext.js', () => ({
  ...teammateContextModule,
  isInProcessTeammate: () => false,
}))

mock.module('../utils/swarm/teamHelpers.js', () => ({
  ...teamHelpersModule,
  readTeamFileAsync: async () => {
    teamFileReadCount += 1
    if (teamFileReadCount === 1) return null
    return {
      leadAgentId: 'team-lead@review-team',
      members: [
        {
          agentId: 'team-lead@review-team',
          name: 'team-lead',
          tmuxPaneId: '',
          backendType: 'in-process',
        },
        {
          agentId: 'worker-id',
          name: 'worker',
          tmuxPaneId: '%trusted',
          backendType: 'tmux',
        },
      ],
    }
  },
  removeTeammateFromTeamFile: removeTeammate,
  setMemberMode: () => {},
}))

mock.module('../utils/swarm/backends/registry.js', () => ({
  ...backendRegistryModule,
  ensureBackendsRegistered: async () => {},
  getBackendByType: () => ({ killPane }),
}))

mock.module('../utils/swarm/backends/detection.js', () => ({
  ...backendDetectionModule,
  isInsideTmux: async () => true,
}))

mock.module('../utils/tasks.js', () => ({
  ...tasksModule,
  unassignTeammateTasks: async () => ({
    notificationMessage: 'worker has shut down.',
  }),
}))

mock.module('../utils/teammateMailbox.js', () => ({
  ...mailboxModule,
  readUnreadMessages: async () =>
    unreadMessages.filter(message => !message.read),
  markMessagesAsRead: markAllRead,
  markMessagesAsReadByPredicate: markReadByPredicate,
  writeToMailbox: async () => {},
}))

const { useInboxPoller } = await import('./useInboxPoller.js')

function Harness() {
  useInboxPoller({
    enabled: true,
    isLoading: false,
    focusedInputDialog: undefined,
    onSubmitMessage: () => true,
  })
  return null
}

beforeEach(() => {
  intervalCallback = undefined
  teamFileReadCount = 0
  markAllRead.mockClear()
  markReadByPredicate.mockClear()
  removeTeammate.mockClear()
  killPane.mockClear()
  unreadMessages = [
    shutdownApproval('worker', '%claimed'),
    shutdownApproval('attacker', '%victim'),
  ]
  state = {
    teamContext: {
      teamName: 'review-team',
      leadAgentId: 'team-lead@review-team',
      teammates: {
        'team-lead@review-team': {
          name: 'team-lead',
        },
        'worker-id': {
          name: 'worker',
        },
      },
    },
    tasks: {},
    inbox: { messages: [] },
  } as unknown as AppState
})

afterAll(() => {
  // Bun's mock.restore does not undo mock.module export replacements.
  mock.module('../utils/swarm/teamHelpers.js', () => originalTeamHelpers)
  mock.restore()
})

describe('shutdown approval polling', () => {
  test('retries after a temporary team-file read failure without trusting forged pane metadata', async () => {
    const output = new PassThrough()
    const app = render(<Harness />, {
      stdout: output,
      stderr: output,
      debug: false,
      exitOnCtrlC: false,
    })

    try {
      await waitFor(() => teamFileReadCount === 1)

      expect(unreadMessages.every(message => !message.read)).toBe(true)
      expect(removeTeammate).not.toHaveBeenCalled()
      expect(killPane).not.toHaveBeenCalled()

      intervalCallback?.()
      await waitFor(
        () =>
          teamFileReadCount === 2 &&
          removeTeammate.mock.calls.length === 1,
      )

      expect(removeTeammate).toHaveBeenCalledWith('review-team', {
        agentId: 'worker-id',
        name: 'worker',
      })
      expect(killPane).toHaveBeenCalledWith('%trusted', false)
      expect(killPane).toHaveBeenCalledTimes(1)
      expect(unreadMessages.every(message => message.read)).toBe(true)
    } finally {
      app.unmount()
      output.destroy()
    }
  })
})

function shutdownApproval(
  from: string,
  paneId: string,
): TeammateMessage {
  return {
    from,
    text: JSON.stringify({
      type: 'shutdown_approved',
      requestId: `shutdown-${from}`,
      from,
      timestamp: new Date().toISOString(),
      paneId,
      backendType: 'tmux',
    }),
    timestamp: new Date().toISOString(),
    read: false,
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for inbox poller')
    }
    await Bun.sleep(10)
  }
}
