import type { ChatItem } from '../../core/types'
import { describeStep, type StepLabel } from './steps'

/** 最近一个还没有结果的工具调用（只看最后一条用户消息之后）；没有就是 null。 */
export function currentStepLabel(
  items: readonly ChatItem[],
  workDir?: string | null
): StepLabel | null {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]
    if (item.type === 'user') return null
    if (item.type !== 'tool') continue
    // 带 parentToolUseId 的是子 Agent 内部的步骤，不是主 Agent 当前在做的事。
    if (item.parentToolUseId) continue
    // 历史里打开的会话没有 pending 标记，只是还没有结果。
    if (item.pending || item.result === undefined) return describeStep(item, workDir)
  }
  return null
}

export type CaptionInput = {
  step?: StepLabel | null
  waiting?: boolean
  compacting?: boolean
}
export type CaptionParts = {
  tone: 'run' | 'attention'
  /** 前导文字：“正在运行”“等你批准 · 运行”“正在思考”。 */
  lead: string
  /** 命令、路径等对象；自然语言对象也放这里，mono 标明字体。 */
  object?: string
  mono: boolean
}

/** 含汉字才按中文处理；英文里的弯引号、破折号、省略号等排版符号不算。 */
const HAS_HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

/** 工具名是 ASCII（未知工具）时说“调用 X”，其余动词前加“正在”。 */
function progressive(label: StepLabel): { lead: string; object?: string } {
  if (label.description) {
    // 命令自带的说明本身就是完整动作（“运行单元测试”“Run tests”）：中文接“正在”，
    // 英文原样作为状态文字，避免“正在调用 Run tests”这种病句。
    return HAS_HAN.test(label.verb) ? { lead: `正在${label.verb}` } : { lead: label.verb }
  }
  switch (label.verb) {
    case '思考过程':
      return { lead: '正在思考' }
    case '子 Agent':
      return { lead: '正在运行子 Agent', object: label.object }
    case '提问':
      return { lead: '正在向你提问', object: label.object }
  }
  if (/^[\x20-\x7e]+$/.test(label.verb)) return { lead: `正在调用 ${label.verb}`, object: label.object }
  return { lead: `正在${label.verb}`, object: label.object }
}

export function captionParts({ step, waiting, compacting }: CaptionInput): CaptionParts {
  if (waiting) {
    // 等批准：琥珀色，说明批准的是哪一步。
    const verb = step && step.verb !== '思考过程' ? step.verb : undefined
    return {
      tone: 'attention',
      lead: verb ? `等你批准 · ${verb}` : '等你批准',
      object: verb ? step?.object : undefined,
      mono: step?.mono ?? false,
    }
  }
  if (compacting) return { tone: 'run', lead: '正在整理上下文', mono: false }
  if (!step) return { tone: 'run', lead: '正在思考', mono: false }
  const { lead, object } = progressive(step)
  return { tone: 'run', lead, object, mono: step.mono }
}

/** 等批准时，状态行要说的是正在等批准的那一次调用，而不是最近一个还没结果的调用（并行调用时两者不是同一个）。 */
export function pendingStepLabel(
  items: readonly ChatItem[],
  toolUseId: string | undefined,
  workDir?: string | null
): StepLabel | null {
  if (!toolUseId) return null
  const item = items.findLast((entry) => entry.type === 'tool' && entry.toolUseId === toolUseId)
  return item ? describeStep(item, workDir) : null
}
