import { describe, expect, test } from 'bun:test'
import {
  formatPhaseCount,
  formatWorkflowTime,
  resolveHistoryPhases,
} from './workflowHistoryView'

describe('workflowHistoryView', () => {
  test('formats same-day and cross-day start/end times and duration', () => {
    const now = new Date(2026, 9, 25, 16, 0, 0)
    const startSameDay = new Date(2026, 9, 25, 14, 20, 0).getTime()
    const endSameDay = new Date(2026, 9, 25, 14, 25, 12).getTime()
    expect(formatWorkflowTime(startSameDay, endSameDay, now)).toEqual({
      range: '今天 14:20 – 14:25',
      start: '今天 14:20',
      end: '今天 14:25',
      duration: '5:12',
    })

    const startYesterday = new Date(2026, 9, 24, 23, 55, 0).getTime()
    const endToday = new Date(2026, 9, 25, 0, 8, 0).getTime()
    expect(formatWorkflowTime(startYesterday, endToday, now)).toEqual({
      range: '昨天 23:55 – 今天 00:08',
      start: '昨天 23:55',
      end: '今天 00:08',
      duration: '13:00',
    })

    expect(formatWorkflowTime(startSameDay, undefined, now)).toEqual({
      range: '开始 今天 14:20',
      start: '今天 14:20',
      end: '',
      duration: '',
    })
  })

  test('formats phase count and resolves detail fallback phases', () => {
    expect(formatPhaseCount(3)).toBe('3 个阶段')
    expect(formatPhaseCount(0)).toBe('未记录阶段')

    expect(
      resolveHistoryPhases(
        { phases: [{ index: 1, title: '调研' }] },
        { phases: [{ title: 'ignored' }] }
      )
    ).toEqual([{ index: 1, title: '调研' }])

    expect(
      resolveHistoryPhases(
        { phases: [] },
        { phases: [{ title: '调研' }, { title: '实现' }, { title: '  ' }] }
      )
    ).toEqual([
      { index: 1, title: '调研' },
      { index: 2, title: '实现' },
    ])
  })
})
