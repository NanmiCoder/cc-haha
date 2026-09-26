import { afterEach, expect, spyOn, test } from 'bun:test'
import { PassThrough } from 'node:stream'
import { render } from 'ink'
import React from 'react'
import * as ink from '../../ink.js'
import * as bindings from '../../keybindings/useKeybinding.js'
import * as appState from '../../state/AppState.js'
import * as registry from '../../utils/swarm/backends/registry.js'
import * as detection from '../../utils/swarm/backends/detection.js'
import * as teamDiscovery from '../../utils/teamDiscovery.js'
import * as teamHelpers from '../../utils/swarm/teamHelpers.js'
import * as mailbox from '../../utils/teammateMailbox.js'
import * as tasks from '../../utils/tasks.js'
import * as dialog from '../design-system/Dialog.js'
import { TeamsDialog } from './TeamsDialog.js'

const tick = () => new Promise(resolve => setTimeout(resolve, 20))

const TEAM = 'team-x'

type Handlers = {
  cycleMode: (() => void) | undefined
  input: ((input: string, key: Record<string, unknown>) => void) | undefined
  setMemberMode: any
  setMultipleMemberModes: any
  removeMemberFromTeam: any
  writeToMailbox: any
  removeRejects: { value: boolean }
}

let spies: any[] = []
let unmount: (() => void) | undefined

function teammateStatuses() {
  return [
    {
      name: 'worker-a',
      agentId: 'worker-a@team-x',
      status: 'idle' as const,
      tmuxPaneId: '%1',
      cwd: '/tmp',
      backendType: 'tmux' as const,
      mode: 'default',
    },
    {
      name: 'worker-b',
      agentId: 'worker-b@team-x',
      status: 'running' as const,
      tmuxPaneId: '%2',
      cwd: '/tmp',
      backendType: 'tmux' as const,
      mode: 'default',
    },
  ]
}

function setup(): Handlers {
  const handlers: Handlers = {
    cycleMode: undefined,
    input: undefined,
    setMemberMode: undefined as never,
    setMultipleMemberModes: undefined as never,
    removeMemberFromTeam: undefined as never,
    writeToMailbox: undefined as never,
    removeRejects: { value: false },
  }
  let state = {
    toolPermissionContext: { isBypassPermissionsModeAvailable: false },
    teamContext: {
      teamName: TEAM,
      leadAgentId: `team-lead@${TEAM}`,
      teammates: { 'worker-a@team-x': { name: 'worker-a' } },
    },
    inbox: { messages: [] },
  } as any

  spies = [
    spyOn(ink, 'Box').mockImplementation(() => null),
    spyOn(ink, 'Text').mockImplementation(() => null),
    spyOn(ink, 'useInput').mockImplementation((handler: any) => {
      // TeamsDialog's own handler takes (input, key) and closes over the current
      // dialog level; its detail view hooks a second, key-less input handler.
      if (handler.length > 1) handlers.input = handler
    }),
    spyOn(dialog, 'Dialog').mockReturnValue(null as never),
    spyOn(bindings, 'useKeybindings').mockImplementation((actions: any) => {
      for (const [action, handler] of Object.entries(actions)) {
        if (action === 'confirm:cycleMode') handlers.cycleMode = handler as () => void
      }
    }),
    spyOn(appState, 'useAppState').mockImplementation((selector: any) => selector(state)),
    spyOn(appState, 'useSetAppState').mockReturnValue((updater: any) => {
      state = updater(state)
    }),
    spyOn(teamDiscovery, 'getTeammateStatuses').mockImplementation(() => teammateStatuses() as never),
    spyOn(registry, 'ensureBackendsRegistered').mockImplementation(async () => {}),
    spyOn(registry, 'getBackendByType').mockReturnValue({ killPane: async () => {} } as never),
    spyOn(registry, 'getCachedBackend').mockReturnValue({ supportsHideShow: false } as never),
    spyOn(detection, 'isInsideTmuxSync').mockReturnValue(false),
    spyOn(tasks, 'listTasks').mockImplementation(async () => []),
    spyOn(tasks, 'unassignTeammateTasks').mockImplementation(async () => ({
      notificationMessage: 'worker-a has shut down.',
    })),
    spyOn(mailbox, 'sendShutdownRequestToMailbox').mockImplementation(async () => {}),
    // The last four are the ones the assertions reach for (see below).
    spyOn(mailbox, 'writeToMailbox').mockImplementation(async () => {}),
    spyOn(teamHelpers, 'setMemberMode').mockImplementation(async () => true as never),
    spyOn(teamHelpers, 'setMultipleMemberModes').mockImplementation(async () => true as never),
    spyOn(teamHelpers, 'removeMemberFromTeam').mockImplementation((async () => {
      if (handlers.removeRejects.value) throw new Error('team file is locked')
      return true
    }) as never),
  ]
  handlers.writeToMailbox = spies[spies.length - 4]
  handlers.setMemberMode = spies[spies.length - 3]
  handlers.setMultipleMemberModes = spies[spies.length - 2]
  handlers.removeMemberFromTeam = spies[spies.length - 1]

  const output = new PassThrough()
  const app = render(
    <TeamsDialog
      initialTeams={[{ name: TEAM, memberCount: 2, runningCount: 1, idleCount: 1 }]}
      onDone={() => {}}
    />,
    {
      stdout: output,
      stderr: output,
      stdin: new PassThrough(),
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )
  unmount = () => {
    app.unmount()
    output.destroy()
  }
  return handlers
}

afterEach(() => {
  unmount?.()
  unmount = undefined
  for (const spy of spies.reverse()) spy.mockRestore()
  spies = []
})

test('cycles modes and kills teammates from both the list and the detail view', async () => {
  const handlers = setup()
  await tick()

  // List view: cycling affects every teammate in one batch write.
  handlers.cycleMode?.()
  await tick()
  expect(handlers.setMultipleMemberModes).toHaveBeenCalledTimes(1)
  const [batchTeam, batchUpdates] = handlers.setMultipleMemberModes.mock.calls[0] as [string, Array<{ memberName: string }>]
  expect(batchTeam).toBe(TEAM)
  expect(batchUpdates.map(update => update.memberName)).toEqual(['worker-a', 'worker-b'])
  expect(handlers.writeToMailbox).toHaveBeenCalledTimes(2)

  // List view: killing the selected teammate removes it from the team file.
  handlers.input?.('k', {})
  await tick()
  expect(handlers.removeMemberFromTeam).toHaveBeenCalledWith(TEAM, '%1')

  // Enter drills into the selected teammate, where cycling touches only that one.
  handlers.input?.('', { return: true })
  await tick()
  handlers.cycleMode?.()
  await tick()
  expect(handlers.setMemberMode).toHaveBeenCalledTimes(1)
  expect(handlers.setMemberMode.mock.calls[0][0]).toBe(TEAM)
  expect(handlers.setMemberMode.mock.calls[0][1]).toBe('worker-a')

  // Detail view: killing returns to the list.
  handlers.removeMemberFromTeam.mockClear()
  handlers.input?.('k', {})
  await tick()
  expect(handlers.removeMemberFromTeam).toHaveBeenCalledWith(TEAM, '%1')

  // List view: pruning kills every idle teammate.
  handlers.removeMemberFromTeam.mockClear()
  handlers.input?.('p', {})
  await tick()
  expect(handlers.removeMemberFromTeam).toHaveBeenCalledWith(TEAM, '%1')
})

test('reports failures when mode sync and teammate removal reject', async () => {
  const handlers = setup()
  handlers.removeRejects.value = true
  await tick()

  // List view cycle failure.
  handlers.setMultipleMemberModes.mockImplementation(async () => {
    throw new Error('config.json is locked')
  })
  handlers.cycleMode?.()
  await tick()

  // List view kill failure.
  handlers.input?.('k', {})
  await tick()

  // Detail view cycle failure.
  handlers.input?.('', { return: true })
  await tick()
  handlers.setMemberMode.mockImplementation(async () => {
    throw new Error('config.json is locked')
  })
  handlers.cycleMode?.()
  await tick()

  // Detail view kill failure leaves the detail open, so step back to the list.
  handlers.input?.('k', {})
  await tick()
  handlers.input?.('', { leftArrow: true })
  await tick()

  // List view prune failure.
  handlers.input?.('p', {})
  await tick()

  expect(handlers.setMultipleMemberModes).toHaveBeenCalledTimes(1)
  expect(handlers.setMemberMode).toHaveBeenCalledTimes(1)
  expect(handlers.removeMemberFromTeam.mock.calls.length).toBeGreaterThanOrEqual(3)
})
