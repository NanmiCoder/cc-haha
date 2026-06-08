import { describe, expect, it } from 'bun:test'
import type { AppState } from '../../state/AppState.js'
import { spawnInProcessTeammate } from './spawnInProcess.js'

function createHarness(permissionMode: AppState['toolPermissionContext']['mode']) {
  let state = {
    tasks: {},
    toolPermissionContext: {
      mode: permissionMode,
    },
  } as AppState

  return {
    get state() {
      return state
    },
    context: {
      getAppState: () => state,
      setAppState: (updater: (prev: AppState) => AppState) => {
        state = updater(state)
      },
    },
  }
}

describe('spawnInProcessTeammate', () => {
  it('inherits bypass permissions from the parent session', async () => {
    const harness = createHarness('bypassPermissions')

    const result = await spawnInProcessTeammate(
      {
        name: 'researcher',
        teamName: 'team',
        prompt: 'check this',
        planModeRequired: false,
      },
      harness.context,
    )

    expect(result.success).toBe(true)
    expect(result.taskId).toBeString()
    expect(harness.state.tasks[result.taskId!]).toMatchObject({
      type: 'in_process_teammate',
      permissionMode: 'bypassPermissions',
    })
  })

  it('keeps plan mode when the teammate explicitly requires planning', async () => {
    const harness = createHarness('bypassPermissions')

    const result = await spawnInProcessTeammate(
      {
        name: 'planner',
        teamName: 'team',
        prompt: 'plan this',
        planModeRequired: true,
      },
      harness.context,
    )

    expect(result.success).toBe(true)
    expect(harness.state.tasks[result.taskId!]).toMatchObject({
      type: 'in_process_teammate',
      permissionMode: 'plan',
    })
  })
})
