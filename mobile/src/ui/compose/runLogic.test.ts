import { describe, expect, test } from 'bun:test'
import {
  composerPlaceholder,
  computerNote,
  effortSegments,
  effortStopAt,
  effortToCommit,
  effortStopX,
  modeChange,
  modeConfirmation,
  modeRisk,
  modelRowLabel,
  nextChosenModel,
  runCapsule,
  runCapsuleA11y,
  runLabel,
  runSheetReasons,
  runShortcut,
  sendSlot,
  teamNote,
} from './runLogic'

const idle = { hasContent: false, busy: false, queueing: false, disabled: false, picking: false, canStop: false }

describe('run capsule', () => {
  test('risk follows the permission mode', () => {
    expect(modeRisk('default')).toBe('normal')
    expect(modeRisk('acceptEdits')).toBe('normal')
    expect(modeRisk('plan')).toBe('normal')
    expect(modeRisk(undefined)).toBe('normal')
    expect(modeRisk('auto')).toBe('attention')
    expect(modeRisk('dontAsk')).toBe('attention')
    expect(modeRisk('bypassPermissions')).toBe('danger')
  })

  test('label is the model, followed by the thinking effort when one is set', () => {
    expect(runLabel('Sonnet 4.5', 'high')).toBe('Sonnet 4.5 · High')
    expect(runLabel('Sonnet 4.5')).toBe('Sonnet 4.5')
    expect(runLabel('  ', null)).toBe('Computer default model')
    expect(runLabel(undefined, 'xhigh')).toBe('Computer default model · Max')
  })

  test('only flags that are on appear on the capsule', () => {
    expect(runCapsule({ mode: 'bypassPermissions', model: 'M', effort: 'low' })).toEqual({ label: 'M · Low', risk: 'danger' })
    expect(runCapsule({ model: 'M', locked: true, disabled: true })).toEqual({
      label: 'M',
      risk: 'normal',
      disabled: true,
      locked: true,
    })
  })

  test('the spoken label carries risk and lock, not only color', () => {
    expect(runCapsuleA11y({ label: 'M · High', risk: 'normal' })).toBe('Run mode: M · High')
    expect(runCapsuleA11y({ label: 'M', risk: 'danger' })).toContain('risky')
    expect(runCapsuleA11y({ label: 'M', risk: 'attention' })).toContain('needs attention')
    expect(runCapsuleA11y({ label: 'M', risk: 'normal', locked: true })).toContain('cannot change while running')
  })
})

describe('send slot', () => {
  test('an empty box is a greyed arrow, and a stop key only while running with a stop handler', () => {
    expect(sendSlot(idle)).toEqual({ kind: 'idle', enabled: false, label: 'Send' })
    expect(sendSlot({ ...idle, busy: true })).toMatchObject({ kind: 'idle', enabled: false })
    expect(sendSlot({ ...idle, busy: true, canStop: true })).toEqual({ kind: 'stop', enabled: true, label: 'Stop' })
    expect(sendSlot({ ...idle, canStop: true })).toMatchObject({ kind: 'idle' })
  })

  test('approved team members still working after the turn: an empty box stops them, content sends right away', () => {
    expect(sendSlot({ ...idle, background: true, canStop: true })).toEqual({ kind: 'stop', enabled: true, label: 'Stop' })
    expect(sendSlot({ ...idle, background: true })).toMatchObject({ kind: 'idle' })
    expect(sendSlot({ ...idle, background: true, canStop: true, hasContent: true })).toEqual({ kind: 'send', enabled: true, label: 'Send' })
  })

  test('stopping stays available even when the composer itself is locked', () => {
    expect(sendSlot({ ...idle, busy: true, canStop: true, disabled: true })).toMatchObject({ kind: 'stop', enabled: true })
  })

  test('content sends, or queues while a turn is running', () => {
    expect(sendSlot({ ...idle, hasContent: true })).toEqual({ kind: 'send', enabled: true, label: 'Send' })
    expect(sendSlot({ ...idle, hasContent: true, starting: true }).label).toBe('Start task')
    expect(sendSlot({ ...idle, hasContent: true, busy: true, queueing: true, canStop: true })).toEqual({
      kind: 'queue',
      enabled: true,
      label: 'Queue to send',
    })
  })

  test('content never sends while the turn is blocked, the composer is disabled or a file is loading', () => {
    expect(sendSlot({ ...idle, hasContent: true, busy: true })).toMatchObject({ kind: 'blocked', enabled: false })
    expect(sendSlot({ ...idle, hasContent: true, disabled: true })).toMatchObject({ kind: 'blocked', enabled: false })
    expect(sendSlot({ ...idle, hasContent: true, picking: true })).toMatchObject({ kind: 'blocked', enabled: false })
    expect(sendSlot({ ...idle, hasContent: true, busy: true, queueing: true, disabled: true })).toMatchObject({
      enabled: false,
    })
  })
})

describe('composer text', () => {
  test('placeholder tells the user what happens to the message', () => {
    expect(composerPlaceholder({ queueing: true, empty: false })).toContain('sends automatically')
    expect(composerPlaceholder({ queueing: false, empty: true })).toBe('Describe what you want to do…')
    expect(composerPlaceholder({ queueing: false, empty: false })).toBe('Continue…')
  })

  test('/model and /permissions open the run sheet only when nothing else is attached', () => {
    expect(runShortcut('/model', false)).toBe('run')
    expect(runShortcut(' /permissions \n', false)).toBe('run')
    expect(runShortcut('/model', true)).toBeNull()
    expect(runShortcut('/model gpt', false)).toBeNull()
    expect(runShortcut('hello /model', false)).toBeNull()
  })
})

describe('run sheet reasons', () => {
  test('nothing is greyed out when the computer allows everything', () => {
    expect(runSheetReasons({ lean: false, teams: 'on' })).toEqual({})
    expect(runSheetReasons({ lean: false, teams: 'unknown' })).toEqual({})
  })

  test('lean profile blocks plan mode and teams with its own wording', () => {
    expect(runSheetReasons({ lean: true, teams: 'on' })).toEqual({
      plan: 'The light tier does not support plan mode',
      team: 'The light tier does not support teams',
    })
  })

  test('the page decides when mode, model and team are busy, and its words win', () => {
    const reasons = runSheetReasons({
      lean: true,
      teams: 'off',
      disabled: { mode: 'Can switch only after this turn ends.', runtime: 'Cannot change model while running', team: 'Cannot change team while running' },
    })
    expect(reasons.mode).toBe('Can switch only after this turn ends.')
    expect(reasons.runtime).toBe('Cannot change model while running')
    expect(reasons.team).toBe('Cannot change team while running')
  })

  test('teams turned off on the computer explain themselves; an unreadable setting is not mistaken for off', () => {
    expect(runSheetReasons({ lean: false, teams: 'off' }).team).toBe('Enable teams in the computer settings first')
    expect(runSheetReasons({ lean: false, teams: 'error' }).team).toBe('Cannot read team settings from the computer right now')
  })

  test('switch captions show the reason instead of the usual note', () => {
    expect(teamNote()).toBe('Applies only to the next message')
    expect(teamNote('Enable teams in the computer settings first')).toBe('Enable teams in the computer settings first')
    expect(computerNote({ supported: true })).toBe('Allow the agent to operate this computer’s screen and apps')
    expect(computerNote({ supported: null })).toBe('Allow the agent to operate this computer’s screen and apps')
    expect(computerNote({ supported: false })).toBe('Not supported on this computer yet')
    expect(computerNote({ supported: true, reason: 'Try again later' })).toBe('Try again later')
  })

  test('model row names the source and model, whichever is known', () => {
    expect(modelRowLabel({ source: 'Claude Official', model: 'Sonnet 4.5' })).toBe('Claude Official · Sonnet 4.5')
    expect(modelRowLabel({ model: 'deepseek-flash' })).toBe('deepseek-flash')
    expect(modelRowLabel({ source: ' ', model: '' })).toBe('Computer default model')
  })

  test('effort segments appear only when the account can set them and the source is ready', () => {
    const efforts = ['low', 'medium', 'high']
    expect(effortSegments({ canSetEffort: true, authReady: true, efforts })).toEqual([
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
    ])
    expect(effortSegments({ canSetEffort: false, authReady: true, efforts })).toEqual([])
    expect(effortSegments({ canSetEffort: true, authReady: false, efforts })).toEqual([])
    expect(effortSegments({ canSetEffort: true, authReady: true })).toEqual([])
  })
})

describe('nextChosenModel', () => {
  const sonnet = { id: 'sonnet', name: 'Sonnet 4.5' }
  const opus = { id: 'opus', name: 'Opus' }
  test('When only thinking effort changes (no model passed) and the model is unchanged, keep the selected model', () => {
    expect(nextChosenModel({ appliedModelId: 'sonnet', currentModelId: 'sonnet', chosen: sonnet })).toBe(sonnet)
  })
  test('Use the new model when one is chosen', () => {
    expect(nextChosenModel({ picked: opus, appliedModelId: 'opus', currentModelId: 'sonnet', chosen: sonnet })).toBe(opus)
  })
  test('When the model changed without passing model, the old display name and window must not remain', () => {
    expect(nextChosenModel({ appliedModelId: 'opus', currentModelId: 'sonnet', chosen: sonnet })).toBeNull()
  })
  test('Stays empty when there was no selected model', () => {
    expect(nextChosenModel({ appliedModelId: 'sonnet', currentModelId: 'sonnet', chosen: null })).toBeNull()
  })
})

describe('switching permission mode', () => {
  test('full access and auto need a confirmation, other modes apply at once', () => {
    expect(modeChange('bypassPermissions', 'default')).toBe('confirm')
    expect(modeChange('auto', 'default')).toBe('confirm')
    expect(modeChange('auto', 'bypassPermissions')).toBe('confirm')
    expect(modeChange('acceptEdits', 'default')).toBe('apply')
    // Going back from full access or auto needs no confirmation.
    expect(modeChange('default', 'bypassPermissions')).toBe('apply')
    expect(modeChange('plan', 'auto')).toBe('apply')
  })

  test('tapping the current mode does nothing, including the implicit default', () => {
    expect(modeChange('bypassPermissions', 'bypassPermissions')).toBe('none')
    expect(modeChange('auto', 'auto')).toBe('none')
    expect(modeChange('default', undefined)).toBe('none')
  })

  test('full access confirmation names what it allows and where', () => {
    const copy = modeConfirmation('bypassPermissions', '/Users/me/project')
    expect(copy).toMatchObject({ title: 'Enable full access?', confirm: 'Enable full access', destructive: true })
    expect(copy.message).toContain('Run any shell command')
    expect(copy.message).toContain('Directory: /Users/me/project')
    expect(modeConfirmation('bypassPermissions').message).not.toContain('Directory: ')
  })

  test('auto confirmation warns it is not guaranteed safe', () => {
    const copy = modeConfirmation('auto', '/Users/me/project')
    expect(copy).toMatchObject({ title: 'Enable auto mode?', confirm: 'Enable auto mode', destructive: false })
    expect(copy.message).toContain('cannot guarantee complete safety')
  })
})

describe('effort slider geometry', () => {
  const track = { width: 336, count: 5, thumb: 36 }

  test('stops sit evenly between half a thumb in from each end', () => {
    expect([0, 1, 2, 3, 4].map((index) => effortStopX(index, track))).toEqual([18, 93, 168, 243, 318])
  })

  test('a drag or tap lands on the nearest stop and clamps at both ends', () => {
    expect(effortStopAt(18, track)).toBe(0)
    expect(effortStopAt(130, track)).toBe(1)
    expect(effortStopAt(131, track)).toBe(2)
    expect(effortStopAt(-50, track)).toBe(0)
    expect(effortStopAt(999, track)).toBe(4)
  })

  test('every stop maps back to itself', () => {
    for (let index = 0; index < track.count; index++)
      expect(effortStopAt(effortStopX(index, track), track)).toBe(index)
  })

  test('a single option is always that option', () => {
    expect(effortStopAt(300, { ...track, count: 1 })).toBe(0)
  })
})

describe('committing effort when the run sheet closes', () => {
  const runtime = { providerId: 'deepseek', modelId: 'deepseek-flash[1m]', effortLevel: 'low' }

  test('sliding only changes the draft; closing sends one change with the model untouched', () => {
    expect(effortToCommit({ runtime, draft: 'high' })).toEqual({ ...runtime, effortLevel: 'high' })
  })

  test('nothing is sent when the draft is unchanged or was never touched', () => {
    expect(effortToCommit({ runtime, draft: 'low' })).toBeNull()
    expect(effortToCommit({ runtime, draft: undefined })).toBeNull()
    expect(effortToCommit({ runtime: undefined, draft: 'high' })).toBeNull()
  })

  test('a draft is dropped once effort can no longer be changed', () => {
    expect(effortToCommit({ runtime, draft: 'high', blocked: 'Can switch only after this turn ends.' })).toBeNull()
  })
})
