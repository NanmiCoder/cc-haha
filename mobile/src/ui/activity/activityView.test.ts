import { describe, expect, test } from 'bun:test'
import { agentStatusText, capsuleBadge, capsuleLabel, capsuleText, clock } from './activityView'

const progress = (done: number, total: number) => ({ done, total })

describe('胶囊文案', () => {
  test('有清单：完成/总数；没有清单只有后台在跑：显示在跑的个数', () => {
    expect(capsuleText({ progress: progress(1, 5), runningCount: 2 })).toBe('1/5')
    expect(capsuleText({ progress: progress(0, 0), runningCount: 2 })).toBe('2')
  })
  test('角标只在“有清单且有东西在跑”时出现，避免同一个数出现两次', () => {
    expect(capsuleBadge({ progress: progress(1, 5), runningCount: 2 })).toBe(2)
    expect(capsuleBadge({ progress: progress(1, 5), runningCount: 0 })).toBeNull()
    expect(capsuleBadge({ progress: progress(0, 0), runningCount: 2 })).toBeNull()
  })
  test('无障碍标签：状态、任务进度、后台个数；等批准时不报后台', () => {
    expect(capsuleLabel({ progress: progress(1, 5), runningCount: 2, tone: 'run', active: true })).toBe(
      '运行中，任务 1/5，2 项后台在跑，点开看详情'
    )
    expect(capsuleLabel({ progress: progress(1, 5), runningCount: 2, tone: 'attention', active: true })).toBe(
      '等你批准，任务 1/5，点开看详情'
    )
    expect(capsuleLabel({ progress: progress(2, 5), runningCount: 0, tone: 'run', active: false })).toBe(
      '任务，任务 2/5，点开看详情'
    )
  })
})

describe('时间与状态', () => {
  test('clock：分:秒、超过一小时带小时；没有开始时间为空；时钟回拨不出负数', () => {
    expect(clock(0, 72_000)).toBe('1:12')
    expect(clock(0, 3_723_000)).toBe('1:02:03')
    expect(clock(undefined, 1)).toBe('')
    expect(clock(10_000, 0)).toBe('0:00')
  })
  test('状态文字', () => {
    expect(['running', 'completed', 'failed', 'stopped'].map((s) => agentStatusText(s as 'running'))).toEqual([
      '运行中',
      '已完成',
      '失败',
      '已停止',
    ])
  })
})
