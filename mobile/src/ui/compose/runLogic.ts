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

/**
 * 点了某一档权限之后怎么办：点当前档不动；切到全权限或自动先确认（和桌面端一样，每次都问），
 * 其余直接生效。
 */
export function modeChange(next: string, current?: string): 'none' | 'confirm' | 'apply' {
  if (next === (current ?? 'default')) return 'none'
  return next === 'bypassPermissions' || next === 'auto' ? 'confirm' : 'apply'
}

/**
 * 切换前的确认框文案，对齐桌面端「启用跳过权限？」「启用自动模式？」。
 * 显式切到自动本身就算同意，CLI 不依赖桌面端额外记下的 skipAutoPermissionPrompt。
 */
export function modeConfirmation(mode: 'bypassPermissions' | 'auto', workDir?: string) {
  if (mode === 'auto')
    return {
      title: '启用自动模式？',
      message:
        '自动模式会减少权限询问，但不能保证绝对安全。\n\n' +
        '它会检查工具调用中的风险操作和提示词注入，执行认为安全的操作，阻止认为有风险的操作。请仅在隔离环境中使用。',
      confirm: '启用自动模式',
      destructive: false,
    }
  return {
    title: '启用全权限？',
    message:
      '这将授予对电脑的完全访问权限，之后不再逐项确认：\n' +
      '· 读取、写入和删除任何文件\n' +
      '· 执行任意 Shell 命令\n' +
      '· 安装或移除软件包' +
      (workDir ? `\n\n目录：${workDir}` : ''),
    confirm: '启用全权限',
    destructive: true,
  }
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

/* ───────────── 思考强度滑块 ───────────── */

/**
 * 关掉运行方式底单时要提交的配置：拖动过程中只改底单里的草稿，退出时变了才发一次，
 * 不让每一下滑动都去改电脑上的配置。底单里强度已不可改（这一轮开始了等）时丢掉草稿。
 */
export function effortToCommit<T extends { effortLevel?: string }>(input: {
  runtime?: T
  draft?: string
  blocked?: string
}): T | null {
  const { runtime, draft, blocked } = input
  if (!runtime || !draft || blocked || draft === runtime.effortLevel) return null
  return { ...runtime, effortLevel: draft }
}

/** 第 index 档圆点的横坐标：两端各留半个滑块宽，滑块停在档位上时圆心正好压住圆点。 */
export function effortStopX(index: number, input: { width: number; count: number; thumb: number }): number {
  const span = Math.max(0, input.width - input.thumb)
  return input.thumb / 2 + (input.count > 1 ? (span * index) / (input.count - 1) : span / 2)
}

/** 手指在横坐标 x 时最近的档位，超出两端按两端算。 */
export function effortStopAt(x: number, input: { width: number; count: number; thumb: number }): number {
  if (input.count <= 1) return 0
  const span = Math.max(1, input.width - input.thumb)
  const ratio = Math.min(1, Math.max(0, (x - input.thumb / 2) / span))
  return Math.round(ratio * (input.count - 1))
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
