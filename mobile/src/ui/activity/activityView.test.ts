import { describe, expect, test } from 'bun:test'
import { agentStatusText, capsuleBadge, capsuleLabel, capsuleText, clock } from './activityView'

const progress = (done: number, total: number) => ({ done, total })

describe('Capsule text', () => {
  test('With a list: done/total; without a list and only background running: show the running count', () => {
    expect(capsuleText({ progress: progress(1, 5), runningCount: 2 })).toBe('1/5')
    expect(capsuleText({ progress: progress(0, 0), runningCount: 2 })).toBe('2')
  })
  test('The badge only appears when “there is a list and something is running”, to avoid showing the same number twice', () => {
    expect(capsuleBadge({ progress: progress(1, 5), runningCount: 2 })).toBe(2)
    expect(capsuleBadge({ progress: progress(1, 5), runningCount: 0 })).toBeNull()
    expect(capsuleBadge({ progress: progress(0, 0), runningCount: 2 })).toBeNull()
  })
  test('Accessibility label: status, task progress, background count; background not announced while waiting for approval', () => {
    expect(capsuleLabel({ progress: progress(1, 5), runningCount: 2, tone: 'run', active: true })).toBe(
      'Running, task 1/5, 2 running in background, tap for details'
    )
    expect(capsuleLabel({ progress: progress(1, 5), runningCount: 2, tone: 'attention', active: true })).toBe(
      'Waiting for your approval, task 1/5, tap for details'
    )
    expect(capsuleLabel({ progress: progress(2, 5), runningCount: 0, tone: 'run', active: false })).toBe(
      'Tasks, task 2/5, tap for details'
    )
  })
  test('Team starting: say “Team starting”; when an approval is also pending, approval comes first', () => {
    expect(capsuleLabel({ progress: progress(0, 0), runningCount: 0, tone: 'run', active: false, launching: true })).toBe(
      'Team starting, tap for details'
    )
    expect(capsuleLabel({ progress: progress(0, 0), runningCount: 0, tone: 'attention', active: false, launching: true })).toBe(
      'Waiting for your approval, tap for details'
    )
  })
})

describe('Time and status', () => {
  test('clock: min:sec, with hours over an hour; empty without a start time; never negative when the clock moves back', () => {
    expect(clock(0, 72_000)).toBe('1:12')
    expect(clock(0, 3_723_000)).toBe('1:02:03')
    expect(clock(undefined, 1)).toBe('')
    expect(clock(10_000, 0)).toBe('0:00')
  })
  test('Status text', () => {
    expect(['running', 'completed', 'failed', 'stopped'].map((s) => agentStatusText(s as 'running'))).toEqual([
      'Running',
      'Done',
      'Failed',
      'Stopped',
    ])
  })
})
