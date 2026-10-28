import type { PermissionMode } from '../core/types'

/** 全应用统一的权限模式名称：输入框、新任务、计划执行、设置都用这一套。 */
export const modes: {
  id: PermissionMode
  title: string
  description: string
}[] = [
  { id: 'default', title: '询问', description: '需要权限的操作先问你' },
  {
    id: 'acceptEdits',
    title: '自动接受编辑',
    description: '改文件不再问你，其他操作照常确认',
  },
  { id: 'auto', title: '自动', description: '按电脑上的自动审批规则处理' },
  { id: 'plan', title: '计划', description: '先讨论和出计划，你批准后再执行' },
  {
    id: 'bypassPermissions',
    title: '全权限',
    description: '跳过所有工具审批，只在你信任的项目里用',
  },
]

const extraModeNames: Record<string, string> = { dontAsk: '不询问' }

export const modeName = (id?: string) =>
  modes.find((mode) => mode.id === id)?.title ??
  (id ? (extraModeNames[id] ?? id) : '询问')

/** 批准计划时可选的执行方式（不含“计划”本身）。 */
export const planExecutionModes = modes.filter((mode) =>
  ['default', 'acceptEdits', 'bypassPermissions'].includes(mode.id)
)

const effortNames: Record<string, string> = {
  none: '关闭',
  minimal: '最低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '超高',
  max: '最高',
}

/** 思考强度统一中文名；未知值原样显示，未设置显示“默认”。 */
export const effortName = (effort?: string | null) =>
  effort ? (effortNames[effort] ?? effort) : '默认'

/** Standard / Lean 两种运行档位的用户可见名称。 */
export const profileName = (profile?: string | null) =>
  profile === 'lean' ? '轻量' : '完整工具'

export const profileDescription = (profile?: string | null) =>
  profile === 'lean'
    ? '精简工具环境，不支持计划模式和团队'
    : '完整工具、计划与团队能力'
