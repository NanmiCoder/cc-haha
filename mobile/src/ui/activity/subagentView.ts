import { normalizeHistory } from '../../core/chat'
import type { BackgroundTask, SubagentOutput } from '../../core/operations'
import type { ChatItem } from '../../core/types'
import { currentStepLabel } from '../chat/captionModel'
import { buildChatRows, type ChatRow, type StepLabel } from '../chat/steps'

export type SubagentRunView = {
  /** 主 Agent 交给它的任务（transcript 里的第一条用户消息）。 */
  prompt: ChatItem | null
  /** 和主对话同一套行：第一行是 prompt，结束后的处理过程折成「用时 …」。 */
  rows: ChatRow[]
  /** 运行中正在做的这一步（已从步骤摘要里扣掉，由页面单独画在末尾）。 */
  current: StepLabel | null
  truncated: boolean
  /** transcript 里一条都没有。 */
  empty: boolean
}

/**
 * 把电脑返回的子 Agent 原始记录归一化成和主对话一致的时间线：
 * 第一条用户消息是主 Agent 交给它的任务，整段走同一套 buildChatRows（工具聚合、折叠）。
 * 一条记录都没有时，已结束的运行退而显示电脑给出的最终结果，运行中则保持空白。
 */
export function subagentRunView(
  output: Pick<SubagentOutput, 'messages' | 'result' | 'truncated'> | null,
  running: boolean
): SubagentRunView {
  if (!output) return { prompt: null, rows: [], current: null, truncated: false, empty: true }
  const items = normalizeHistory(output.messages ?? [])
  const prompt = items.find((item) => item.type === 'user') ?? null
  const result = output.result?.trim()
  const body: ChatItem[] =
    !items.length && !running && result
      ? [{ id: 'subagent:result', type: 'assistant', text: result }]
      : items
  return {
    prompt,
    rows: buildChatRows(body, running),
    current: running ? currentStepLabel(items) : null,
    truncated: output.truncated === true,
    empty: body.length === 0,
  }
}

export type SubagentHeader = {
  title: string
  status: BackgroundTask['status']
  startedAt?: number
}

const known = ['running', 'completed', 'failed', 'stopped'] as const

/** 页眉：名称取任务说明，状态以后台任务列表为准，列表里找不到时退回 transcript 自带的状态。 */
export function subagentHeader(
  task: BackgroundTask | undefined,
  output: Pick<SubagentOutput, 'status'> | null
): SubagentHeader {
  const reported = known.find((status) => status === output?.status)
  const started = task?.startedAt ? Date.parse(task.startedAt) : NaN
  return {
    title: task?.description?.trim() || '子 Agent',
    status: task?.status ?? reported ?? 'completed',
    ...(Number.isFinite(started) ? { startedAt: started } : {}),
  }
}
