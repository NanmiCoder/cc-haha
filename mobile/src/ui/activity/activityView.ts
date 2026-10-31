import type { ActivityProgress } from '../../core/sessionActivityModel'

export type CapsuleInput = {
  progress: ActivityProgress
  runningCount: number
  tone: 'run' | 'attention'
  /** 这一轮还在跑或有后台任务在跑。 */
  active: boolean
  /** 团队方案刚确认、成员还在就位。 */
  launching?: boolean
}

/** 胶囊里的主文字：有任务清单显示“完成/总数”，只有后台在跑时显示在跑的个数。 */
export function capsuleText({ progress, runningCount }: Pick<CapsuleInput, 'progress' | 'runningCount'>) {
  return progress.total > 0 ? `${progress.done}/${progress.total}` : String(runningCount)
}

/** 角标：有清单又有子 Agent/后台在跑时，叠一个在跑的个数；其余情况不重复显示。 */
export function capsuleBadge({ progress, runningCount }: Pick<CapsuleInput, 'progress' | 'runningCount'>) {
  return progress.total > 0 && runningCount > 0 ? runningCount : null
}

export function capsuleLabel(input: CapsuleInput) {
  if (input.launching && input.tone !== 'attention') return '团队启动中，点开看详情'
  const parts = [
    input.tone === 'attention' ? '等你批准' : input.active ? '运行中' : '任务',
    input.progress.total > 0 ? `任务 ${input.progress.done}/${input.progress.total}` : '',
    input.runningCount > 0 && input.tone !== 'attention' ? `${input.runningCount} 项后台在跑` : '',
    '点开看详情',
  ]
  return parts.filter(Boolean).join('，')
}

/** 子 Agent / 团队 / 命令状态的文字和颜色语义。 */
export function agentStatusText(status: 'running' | 'completed' | 'failed' | 'stopped') {
  return status === 'running'
    ? '运行中'
    : status === 'completed'
      ? '已完成'
      : status === 'failed'
        ? '失败'
        : '已停止'
}

/** 毫秒 -> 1:12 / 1:02:03；没有开始时间返回空串。 */
export function clock(startedAt: number | undefined, now: number) {
  if (startedAt === undefined) return ''
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000))
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = String(seconds % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}
