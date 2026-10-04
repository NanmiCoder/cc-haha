import { describe, expect, test } from 'bun:test'
import { formatShellProcessDetails } from './ShellDetailDialog.js'
import { getTaskStatusColor, getTaskStatusIcon, isTerminalStatus } from './taskStatusUtils.js'
import figures from 'figures'

test('未知任务显示警告状态并结束运行指示', () => {
  expect(isTerminalStatus('unknown')).toBe(true)
  expect(isTerminalStatus('running')).toBe(false)
  expect(getTaskStatusColor('unknown')).toBe('warning')
  expect(getTaskStatusIcon('unknown')).toBe(figures.warning)
})

describe('formatShellProcessDetails', () => {
  test('formats observation and terminal reason', () => {
    expect(formatShellProcessDetails('unknown', 'process_state_unverified')).toBe(
      ' (process state unavailable; state could not be verified after restart; the process may still be running outside cc-haha)',
    )
  })

  test('explains an unavailable exit status', () => {
    expect(formatShellProcessDetails('dead', 'process_disappeared')).toBe(
      ' (process is no longer running; exit status unavailable)',
    )
  })

  test('distinguishes automatic termination reasons from a stop request timeout', () => {
    expect(formatShellProcessDetails(undefined, 'timeout_termination_confirmed')).toBe(' (command terminated after timeout)')
    expect(formatShellProcessDetails(undefined, 'abort_termination_confirmed')).toBe(' (command terminated after abort)')
    expect(formatShellProcessDetails(undefined, 'output_limit_termination_confirmed')).toBe(' (command terminated after output limit)')
    expect(formatShellProcessDetails(undefined, 'termination_timeout')).toBe(' (stop request timed out)')
  })

  test('omits empty details', () => {
    expect(formatShellProcessDetails()).toBe('')
    expect(formatShellProcessDetails('', undefined)).toBe('')
  })
})
