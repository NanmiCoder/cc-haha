import { effortName } from '../modes'

/* ───────────── 运行胶囊 ───────────── */

export type RunRisk = 'normal' | 'attention' | 'danger'
export type RunCapsule = {
  label: string
  risk: RunRisk
  disabled?: boolean
  locked?: boolean
}

/** 权限档位对应的提醒程度：全权限最危险，自动和不询问要留意，其余正常。 */
export function modeRisk(mode?: string): RunRisk {
  if (mode === 'bypassPermissions') return 'danger'
  if (mode === 'auto' || mode === 'dontAsk') return 'attention'
  return 'normal'
}

/** 运行胶囊上的字：模型名，有思考强度时跟一个「 · 高」。 */
export function runLabel(model?: string, effort?: string | null): string {
  const name = model?.trim() || '电脑默认模型'
  return effort ? `${name} · ${effortName(effort)}` : name
}

export function runCapsule(input: {
  mode?: string
  model?: string
  effort?: string | null
  disabled?: boolean
  locked?: boolean
}): RunCapsule {
  return {
    label: runLabel(input.model, input.effort),
    risk: modeRisk(input.mode),
    ...(input.disabled ? { disabled: true } : {}),
    ...(input.locked ? { locked: true } : {}),
  }
}

const riskNote: Record<RunRisk, string> = { normal: '', attention: '，需要留意', danger: '，有风险' }

export function runCapsuleA11y(run: Pick<RunCapsule, 'label' | 'risk' | 'locked'>): string {
  return `运行方式：${run.label}${riskNote[run.risk]}${run.locked ? '，运行中不可改' : ''}`
}

/** 锁住时胶囊旁边的说明（C7）。 */
export const runLockedNote = '运行中不能换模型'

/* ───────────── 发送位 ───────────── */

export type SendSlot = {
  kind: 'send' | 'queue' | 'stop' | 'idle' | 'blocked'
  enabled: boolean
  label: string
}

/**
 * 输入框右下角那一个键：
 * 没有内容、正在运行、页面给了停止 → 实心停止方块；
 * 有内容 → 向上箭头（运行中且允许排队时是「排队发送」）；其余是置灰的箭头。
 */
export function sendSlot(input: {
  hasContent: boolean
  busy: boolean
  queueing: boolean
  disabled: boolean
  picking: boolean
  canStop: boolean
  /** 没有会话 id：这是新任务页，键上写「开始任务」。 */
  starting?: boolean
}): SendSlot {
  const idle = input.starting ? '开始任务' : '发送'
  if (!input.hasContent) {
    if (input.busy && input.canStop) return { kind: 'stop', enabled: true, label: '停止' }
    return { kind: 'idle', enabled: false, label: idle }
  }
  if (input.disabled || input.picking) return { kind: 'blocked', enabled: false, label: idle }
  if (input.busy) {
    return input.queueing
      ? { kind: 'queue', enabled: true, label: '排队发送' }
      : { kind: 'blocked', enabled: false, label: idle }
  }
  return { kind: 'send', enabled: true, label: idle }
}

/** 输入框占位文字。 */
export function composerPlaceholder(input: { queueing: boolean; empty: boolean }): string {
  return input.queueing ? '补充要求，这一轮结束后自动发送' : input.empty ? '说说你想做什么…' : '接着说…'
}

/** 草稿正好是 /model、/permissions（没有别的材料）时，改成打开「运行方式」。 */
export function runShortcut(draft: string, hasMaterial: boolean): 'run' | null {
  if (hasMaterial) return null
  const text = draft.trim()
  return text === '/model' || text === '/permissions' ? 'run' : null
}

/* ───────────── 运行方式底单 ───────────── */

export type TeamsSetting = 'on' | 'off' | 'unknown' | 'error'

export type RunSheetReasons = {
  /** 权限单选整体不可用的原因。 */
  mode?: string
  /** 「计划」这一档不可用的原因（轻量档位）。 */
  plan?: string
  /** 模型与思考强度不可用的原因。 */
  runtime?: string
  /** 团队开关不可用的原因。 */
  team?: string
}

/** 各项置灰的原因：页面给出的优先，其次是轻量档位和电脑设置的限制。 */
export function runSheetReasons(input: {
  lean: boolean
  teams: TeamsSetting
  disabled?: { mode?: string; runtime?: string; team?: string }
}): RunSheetReasons {
  const given = input.disabled ?? {}
  return {
    ...(given.mode ? { mode: given.mode } : {}),
    ...(input.lean ? { plan: '轻量档位不支持计划模式' } : {}),
    ...(given.runtime ? { runtime: given.runtime } : {}),
    ...(given.team
      ? { team: given.team }
      : input.lean
        ? { team: '轻量档位不支持团队' }
        : input.teams === 'off'
          ? { team: '请先在电脑设置中启用团队' }
          : input.teams === 'error'
            ? { team: '暂时读不到电脑上的团队设置' }
            : {}),
  }
}

/** 开关当前的说明文字：不可用时换成原因，否则是固定说明。 */
export const teamNote = (reason?: string) => reason ?? '只对下一条消息生效'
export function computerNote(input: { supported: boolean | null; reason?: string }) {
  if (input.reason) return input.reason
  return input.supported === false ? '这台电脑暂不支持' : '允许 Agent 操作这台电脑的屏幕和应用'
}

/** 模型一行：`供应商 · 模型`，缺哪个就只显示另一个。 */
export function modelRowLabel(input: { source?: string; model?: string }): string {
  const parts = [input.source?.trim(), input.model?.trim()].filter(Boolean)
  return parts.length ? parts.join(' · ') : '电脑默认模型'
}

/** 思考强度三段（或模型实际支持的几段）：只在能设置、且来源可用时给出。 */
export function effortSegments(input: {
  canSetEffort: boolean
  authReady: boolean
  efforts?: string[]
}): { value: string; label: string }[] {
  if (!input.canSetEffort || !input.authReady) return []
  return (input.efforts ?? []).map((value) => ({ value, label: effortName(value) }))
}

/** 底单里新任务专有的「运行档位」分组。 */
export type RunProfile = {
  value: 'standard' | 'lean'
  onChange(value: 'standard' | 'lean'): void
  disabled?: string
}

/**
 * 应用一次运行配置后，页面里记住的「已选模型」（带显示名和上下文窗口）该是什么：
 * 选了新模型就用新的；只改了思考强度（没带 model）且模型没变就保留；换了模型但没带 model 就清掉。
 */
export function nextChosenModel<T extends { id: string }>(input: {
  picked?: T | null
  appliedModelId: string
  currentModelId?: string
  chosen: T | null
}): T | null {
  if (input.picked) return input.picked
  return input.appliedModelId === input.currentModelId ? input.chosen : null
}
