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
    expect(runLabel('Sonnet 4.5', 'high')).toBe('Sonnet 4.5 · 高')
    expect(runLabel('Sonnet 4.5')).toBe('Sonnet 4.5')
    expect(runLabel('  ', null)).toBe('电脑默认模型')
    expect(runLabel(undefined, 'xhigh')).toBe('电脑默认模型 · 超高')
  })

  test('only flags that are on appear on the capsule', () => {
    expect(runCapsule({ mode: 'bypassPermissions', model: 'M', effort: 'low' })).toEqual({ label: 'M · 低', risk: 'danger' })
    expect(runCapsule({ model: 'M', locked: true, disabled: true })).toEqual({
      label: 'M',
      risk: 'normal',
      disabled: true,
      locked: true,
    })
  })

  test('the spoken label carries risk and lock, not only color', () => {
    expect(runCapsuleA11y({ label: 'M · 高', risk: 'normal' })).toBe('运行方式：M · 高')
    expect(runCapsuleA11y({ label: 'M', risk: 'danger' })).toContain('有风险')
    expect(runCapsuleA11y({ label: 'M', risk: 'attention' })).toContain('需要留意')
    expect(runCapsuleA11y({ label: 'M', risk: 'normal', locked: true })).toContain('运行中不可改')
  })
})

describe('send slot', () => {
  test('an empty box is a greyed arrow, and a stop key only while running with a stop handler', () => {
    expect(sendSlot(idle)).toEqual({ kind: 'idle', enabled: false, label: '发送' })
    expect(sendSlot({ ...idle, busy: true })).toMatchObject({ kind: 'idle', enabled: false })
    expect(sendSlot({ ...idle, busy: true, canStop: true })).toEqual({ kind: 'stop', enabled: true, label: '停止' })
    expect(sendSlot({ ...idle, canStop: true })).toMatchObject({ kind: 'idle' })
  })

  test('approved team members still working after the turn: an empty box stops them, content sends right away', () => {
    expect(sendSlot({ ...idle, background: true, canStop: true })).toEqual({ kind: 'stop', enabled: true, label: '停止' })
    expect(sendSlot({ ...idle, background: true })).toMatchObject({ kind: 'idle' })
    expect(sendSlot({ ...idle, background: true, canStop: true, hasContent: true })).toEqual({ kind: 'send', enabled: true, label: '发送' })
  })

  test('stopping stays available even when the composer itself is locked', () => {
    expect(sendSlot({ ...idle, busy: true, canStop: true, disabled: true })).toMatchObject({ kind: 'stop', enabled: true })
  })

  test('content sends, or queues while a turn is running', () => {
    expect(sendSlot({ ...idle, hasContent: true })).toEqual({ kind: 'send', enabled: true, label: '发送' })
    expect(sendSlot({ ...idle, hasContent: true, starting: true }).label).toBe('开始任务')
    expect(sendSlot({ ...idle, hasContent: true, busy: true, queueing: true, canStop: true })).toEqual({
      kind: 'queue',
      enabled: true,
      label: '排队发送',
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
    expect(composerPlaceholder({ queueing: true, empty: false })).toContain('自动发送')
    expect(composerPlaceholder({ queueing: false, empty: true })).toBe('说说你想做什么…')
    expect(composerPlaceholder({ queueing: false, empty: false })).toBe('接着说…')
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
      plan: '轻量档位不支持计划模式',
      team: '轻量档位不支持团队',
    })
  })

  test('the page decides when mode, model and team are busy, and its words win', () => {
    const reasons = runSheetReasons({
      lean: true,
      teams: 'off',
      disabled: { mode: '这一轮结束后才能切换。', runtime: '运行中不能换模型', team: '运行中不能改团队' },
    })
    expect(reasons.mode).toBe('这一轮结束后才能切换。')
    expect(reasons.runtime).toBe('运行中不能换模型')
    expect(reasons.team).toBe('运行中不能改团队')
  })

  test('teams turned off on the computer explain themselves; an unreadable setting is not mistaken for off', () => {
    expect(runSheetReasons({ lean: false, teams: 'off' }).team).toBe('请先在电脑设置中启用团队')
    expect(runSheetReasons({ lean: false, teams: 'error' }).team).toBe('暂时读不到电脑上的团队设置')
  })

  test('switch captions show the reason instead of the usual note', () => {
    expect(teamNote()).toBe('只对下一条消息生效')
    expect(teamNote('请先在电脑设置中启用团队')).toBe('请先在电脑设置中启用团队')
    expect(computerNote({ supported: true })).toBe('允许 Agent 操作这台电脑的屏幕和应用')
    expect(computerNote({ supported: null })).toBe('允许 Agent 操作这台电脑的屏幕和应用')
    expect(computerNote({ supported: false })).toBe('这台电脑暂不支持')
    expect(computerNote({ supported: true, reason: '稍后再试' })).toBe('稍后再试')
  })

  test('model row names the source and model, whichever is known', () => {
    expect(modelRowLabel({ source: 'Claude 官方', model: 'Sonnet 4.5' })).toBe('Claude 官方 · Sonnet 4.5')
    expect(modelRowLabel({ model: 'deepseek-flash' })).toBe('deepseek-flash')
    expect(modelRowLabel({ source: ' ', model: '' })).toBe('电脑默认模型')
  })

  test('effort segments appear only when the account can set them and the source is ready', () => {
    const efforts = ['low', 'medium', 'high']
    expect(effortSegments({ canSetEffort: true, authReady: true, efforts })).toEqual([
      { value: 'low', label: '低' },
      { value: 'medium', label: '中' },
      { value: 'high', label: '高' },
    ])
    expect(effortSegments({ canSetEffort: false, authReady: true, efforts })).toEqual([])
    expect(effortSegments({ canSetEffort: true, authReady: false, efforts })).toEqual([])
    expect(effortSegments({ canSetEffort: true, authReady: true })).toEqual([])
  })
})

describe('nextChosenModel', () => {
  const sonnet = { id: 'sonnet', name: 'Sonnet 4.5' }
  const opus = { id: 'opus', name: 'Opus' }
  test('只改思考强度（没带 model）、模型没变时，保留已选模型', () => {
    expect(nextChosenModel({ appliedModelId: 'sonnet', currentModelId: 'sonnet', chosen: sonnet })).toBe(sonnet)
  })
  test('选了新模型就用新的', () => {
    expect(nextChosenModel({ picked: opus, appliedModelId: 'opus', currentModelId: 'sonnet', chosen: sonnet })).toBe(opus)
  })
  test('换了模型却没带 model，旧的显示名和窗口不能留着', () => {
    expect(nextChosenModel({ appliedModelId: 'opus', currentModelId: 'sonnet', chosen: sonnet })).toBeNull()
  })
  test('原来就没有已选模型时保持为空', () => {
    expect(nextChosenModel({ appliedModelId: 'sonnet', currentModelId: 'sonnet', chosen: null })).toBeNull()
  })
})

describe('switching permission mode', () => {
  test('full access and auto need a confirmation, other modes apply at once', () => {
    expect(modeChange('bypassPermissions', 'default')).toBe('confirm')
    expect(modeChange('auto', 'default')).toBe('confirm')
    expect(modeChange('auto', 'bypassPermissions')).toBe('confirm')
    expect(modeChange('acceptEdits', 'default')).toBe('apply')
    // 从全权限、自动退回来不用确认。
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
    expect(copy).toMatchObject({ title: '启用全权限？', confirm: '启用全权限', destructive: true })
    expect(copy.message).toContain('执行任意 Shell 命令')
    expect(copy.message).toContain('目录：/Users/me/project')
    expect(modeConfirmation('bypassPermissions').message).not.toContain('目录：')
  })

  test('auto confirmation warns it is not guaranteed safe', () => {
    const copy = modeConfirmation('auto', '/Users/me/project')
    expect(copy).toMatchObject({ title: '启用自动模式？', confirm: '启用自动模式', destructive: false })
    expect(copy.message).toContain('不能保证绝对安全')
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
    expect(effortToCommit({ runtime, draft: 'high', blocked: '这一轮结束后才能切换。' })).toBeNull()
  })
})
