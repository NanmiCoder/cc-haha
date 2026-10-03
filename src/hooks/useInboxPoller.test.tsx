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
const notifierModule = await import('../services/notifier.js')

// mock.module replaces exports process-wide and outlives this file, so every
// module mocked below is put back afterwards from these untouched copies.
// Otherwise later files in one `bun test` run (the coverage gate runs all of
// src in a single process) see this file's fake mailbox, team file and tasks.
const originalModules: Array<[string, Record<string, unknown>]> = [
  ['usehooks-ts', { ...useHooksTsModule }],
  ['../state/AppState.js', { ...appStateModule }],
  ['../ink/useTerminalNotification.js', { ...terminalNotificationModule }],
  ['../services/notifier.js', { ...notifierModule }],
  ['../utils/teammate.js', { ...teammateModule }],
  ['../utils/teammateContext.js', { ...teammateContextModule }],
  ['../utils/swarm/backends/registry.js', { ...backendRegistryModule }],
  ['../utils/swarm/backends/detection.js', { ...backendDetectionModule }],
  ['../utils/tasks.js', { ...tasksModule }],
  ['../utils/teammateMailbox.js', { ...mailboxModule }],
]

let intervalCallback: (() => void) | undefined
let state: AppState
let unreadMessages: TeammateMessage[] = []
let teamFileReadCount = 0
let submitted: string[] = []
let onSubmit: (formatted: string) => boolean = () => true
// While set, every inbox read waits for it, like a slow disk.
let readGate: Promise<void> | undefined

const readUnread = mock(async () => {
  await readGate
  return unreadMessages.filter(message => !message.read)
})
const markReadByIdentity = mock(
  async (
    _agentName: string,
    _teamName: string | undefined,
    delivered: readonly TeammateMessage[],
  ) => {
    const identities = new Set(
      delivered.map(mailboxModule.getMailboxMessageIdentity),
    )
    unreadMessages = unreadMessages.map(message =>
      !message.read &&
      identities.has(mailboxModule.getMailboxMessageIdentity(message))
        ? { ...message, read: true }
        : message,
    )
    return true
  },
)
const removeTeammate = mock(async () => true)
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
  setMemberMode: async () => true,
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
  readUnreadMessages: readUnread,
  markMessagesAsReadByIdentity: markReadByIdentity,
  writeToMailbox: async () => true,
}))

const { useInboxPoller } = await import('./useInboxPoller.js')

function Harness() {
  useInboxPoller({
    enabled: true,
    isLoading: false,
    focusedInputDialog: undefined,
    onSubmitMessage: formatted => {
      submitted.push(formatted)
      return onSubmit(formatted)
    },
  })
  return null
}

beforeEach(() => {
  intervalCallback = undefined
  teamFileReadCount = 0
  submitted = []
  onSubmit = () => true
  readGate = undefined
  readUnread.mockClear()
  markReadByIdentity.mockClear()
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
  for (const [path, original] of originalModules) {
    mock.module(path, () => original)
  }
  mock.restore()
})

describe('shutdown approval polling', () => {
  test('waits for team-file removal before acknowledging shutdown or removing UI state', async () => {
    teamFileReadCount = 1
    let finishRemoval!: (result: boolean) => void
    const removal = new Promise<boolean>(resolve => { finishRemoval = resolve })
    removeTeammate.mockImplementationOnce(() => removal)
    const output = new PassThrough()
    const app = render(<Harness />, {
      stdout: output,
      stderr: output,
      debug: false,
      exitOnCtrlC: false,
    })

    try {
      await waitFor(() => removeTeammate.mock.calls.length === 1)
      expect(state.teamContext?.teammates?.['worker-id']).toBeDefined()
      expect(unreadMessages.every(message => !message.read)).toBe(true)

      finishRemoval(true)
      await waitFor(() => unreadMessages.every(message => message.read))
      expect(state.teamContext?.teammates?.['worker-id']).toBeUndefined()
    } finally {
      finishRemoval(true)
      app.unmount()
      output.destroy()
    }
  })

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

describe('teammate message delivery', () => {
  test('acknowledges exactly the delivered batch', async () => {
    unreadMessages = [chat('alice', 'report')]
    onSubmit = () => {
      // A teammate writes while this poll is still delivering.
      unreadMessages = [...unreadMessages, chat('bob', 'late result')]
      return true
    }
    const output = new PassThrough()
    const app = render(<Harness />, {
      stdout: output,
      stderr: output,
      debug: false,
      exitOnCtrlC: false,
    })

    try {
      await waitFor(() => markReadByIdentity.mock.calls.length === 1)

      expect(submitted).toHaveLength(1)
      expect(submitted[0]).toContain('report')
      expect(markReadByIdentity.mock.calls[0]?.[2]).toEqual([
        chat('alice', 'report'),
      ])
      expect(
        unreadMessages.filter(message => !message.read).map(m => m.text),
      ).toEqual(['late result'])
    } finally {
      app.unmount()
      output.destroy()
    }
  })

  test('delivers mail queued during a busy turn with the shared envelope', async () => {
    unreadMessages = []
    state = {
      ...state,
      inbox: {
        messages: [
          {
            id: 'queued-1',
            from: 'worker',
            text: 'Finished the migration',
            timestamp: '2026-10-03T00:00:00.000Z',
            status: 'pending',
            summary: 'migration "done"',
          },
        ],
      },
    } as AppState
    const output = new PassThrough()
    const app = render(<Harness />, {
      stdout: output,
      stderr: output,
      debug: false,
      exitOnCtrlC: false,
    })

    try {
      await waitFor(() => submitted.length === 1)

      expect(submitted[0]).toBe(
        '<teammate-message teammate_id="worker" summary="migration &quot;done&quot;">\n' +
          'Finished the migration\n' +
          '</teammate-message>',
      )
      expect(state.inbox.messages).toEqual([])
    } finally {
      app.unmount()
      output.destroy()
    }
  })

  test('does not deliver a batch twice when polls overlap', async () => {
    unreadMessages = [chat('alice', 'report')]
    let openGate!: () => void
    readGate = new Promise<void>(resolve => {
      openGate = resolve
    })
    const output = new PassThrough()
    const app = render(<Harness />, {
      stdout: output,
      stderr: output,
      debug: false,
      exitOnCtrlC: false,
    })

    try {
      await waitFor(() => readUnread.mock.calls.length === 1)
      // The next interval tick fires while the first poll is still reading.
      intervalCallback?.()
      intervalCallback?.()
      openGate()
      await waitFor(() => markReadByIdentity.mock.calls.length === 1)
      intervalCallback?.()
      await waitFor(() => readUnread.mock.calls.length === 2)
      await Bun.sleep(20)

      expect(submitted).toHaveLength(1)
      expect(markReadByIdentity).toHaveBeenCalledTimes(1)
    } finally {
      openGate()
      app.unmount()
      output.destroy()
    }
  })
})

function chat(from: string, text: string): TeammateMessage {
  return {
    id: `mailbox-${from}-${text}`,
    from,
    text,
    timestamp: '2026-10-03T00:00:00.000Z',
    read: false,
  }
}

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
