import { beforeEach, describe, expect, it } from 'bun:test'
import {
  getEmptyToolPermissionContext,
  type ToolPermissionContext,
} from '../../Tool.js'
import {
  hasExitedPlanModeInSession,
  needsPlanModeExitAttachment,
  setHasExitedPlanMode,
  setNeedsPlanModeExitAttachment,
} from '../../bootstrap/state.js'
import {
  applyPermissionUpdate,
  applyPermissionUpdates,
} from './PermissionUpdate.js'
import type { PermissionUpdate } from './PermissionUpdateSchema.js'

function permissionContext(
  overrides: Partial<ToolPermissionContext>,
): ToolPermissionContext {
  return {
    ...getEmptyToolPermissionContext(),
    ...overrides,
  }
}

function setMode(mode: PermissionUpdate extends { mode: infer M } ? M : string): PermissionUpdate {
  return { type: 'setMode', mode, destination: 'session' } as PermissionUpdate
}

describe('setMode permission updates', () => {
  beforeEach(() => {
    setHasExitedPlanMode(false)
    setNeedsPlanModeExitAttachment(false)
  })

  it('runs the plan-exit transition when an approval leaves plan mode', () => {
    // The desktop's plan dialog approves ExitPlanMode with
    // `[{ setMode: bypassPermissions }]`. That write used to skip the
    // bookkeeping the CLI does on its own switches (handleSetPermissionMode),
    // so the session kept a half-applied plan exit.
    const next = applyPermissionUpdate(
      permissionContext({
        mode: 'plan',
        prePlanMode: 'bypassPermissions',
        isBypassPermissionsModeAvailable: true,
      }),
      setMode('bypassPermissions'),
    )

    expect(next.mode).toBe('bypassPermissions')
    expect(next.prePlanMode).toBeUndefined()
    expect(hasExitedPlanModeInSession()).toBe(true)
    expect(needsPlanModeExitAttachment()).toBe(true)
  })

  it('applies the same transition through the batch helper hosts call', () => {
    const next = applyPermissionUpdates(
      permissionContext({ mode: 'plan', prePlanMode: 'default' }),
      [
        setMode('acceptEdits'),
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'prompt: run tests' }],
          behavior: 'allow',
          destination: 'session',
        },
      ],
    )

    expect(next.mode).toBe('acceptEdits')
    expect(next.prePlanMode).toBeUndefined()
    expect(hasExitedPlanModeInSession()).toBe(true)
  })

  it('refuses bypassPermissions when the session cannot use it', () => {
    // Same gate the CLI applies to its own switches: an org policy or a
    // session launched without the capability must not be overridden by a
    // permission update.
    const context = permissionContext({
      mode: 'plan',
      prePlanMode: 'default',
      isBypassPermissionsModeAvailable: false,
    })

    const next = applyPermissionUpdate(context, setMode('bypassPermissions'))

    expect(next.mode).toBe('plan')
    expect(next).toBe(context)
  })

  it('leaves the plan-exit flags alone for mode changes outside plan mode', () => {
    const next = applyPermissionUpdate(
      permissionContext({ mode: 'default', prePlanMode: undefined }),
      setMode('acceptEdits'),
    )

    expect(next.mode).toBe('acceptEdits')
    expect(hasExitedPlanModeInSession()).toBe(false)
    expect(needsPlanModeExitAttachment()).toBe(false)
  })
})
