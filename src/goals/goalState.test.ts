import { describe, expect, test } from 'bun:test'
import {
  accountThreadGoalUsage,
  buildGoalContinuationPrompt,
  clearThreadGoal,
  formatGoalStatus,
  getThreadGoal,
  markThreadGoalComplete,
  parseGoalCommand,
  setThreadGoal,
  updateThreadGoalStatus,
} from './goalState.js'

describe('goalState', () => {
  test('parses set and clear goal commands', () => {
    const parsed = parseGoalCommand(
      'migrate auth to the new API until tests pass',
    )

    expect(parsed).toEqual({
      type: 'set',
      objective: 'migrate auth to the new API until tests pass',
    })
    expect(parseGoalCommand('clear')).toEqual({ type: 'clear' })
    expect(() => parseGoalCommand('')).toThrow('Usage: /goal <condition> | clear')
    expect(() => parseGoalCommand('status')).toThrow('Usage: /goal <condition> | clear')
    expect(() => parseGoalCommand('pause')).toThrow('Usage: /goal <condition> | clear')
    expect(() => parseGoalCommand('resume')).toThrow('Usage: /goal <condition> | clear')
    expect(() => parseGoalCommand('complete')).toThrow('Usage: /goal <condition> | clear')
    expect(() => parseGoalCommand('--tokens 100 ship it')).toThrow('Usage: /goal <condition> | clear')
  })

  test('stores and formats the current thread goal', () => {
    const goal = setThreadGoal('thread-a', {
      objective: 'all provider tests pass',
      tokenBudget: 10_000,
      now: 1_000,
    })

    expect(goal.status).toBe('active')
    expect(getThreadGoal('thread-a')?.objective).toBe('all provider tests pass')
    expect(formatGoalStatus(goal, 61_000)).toContain('Goal: active')
    expect(formatGoalStatus(goal, 61_000)).toContain('Budget: 0 / 10,000 tokens')
    expect(formatGoalStatus(goal, 61_000)).toContain('Elapsed: 1m')
  })

  test('setting a new goal replaces the existing goal and resets accounting', () => {
    const first = setThreadGoal('thread-replace', {
      objective: 'first target',
      tokenBudget: 10_000,
      now: 1_000,
    })
    accountThreadGoalUsage('thread-replace', 2_500, 2_000)
    updateThreadGoalStatus('thread-replace', 'paused', 3_000)

    const replaced = setThreadGoal('thread-replace', {
      objective: 'second target',
      now: 4_000,
    })

    expect(replaced.goalId).not.toBe(first.goalId)
    expect(replaced.objective).toBe('second target')
    expect(replaced.status).toBe('active')
    expect(replaced.tokenBudget).toBeNull()
    expect(replaced.tokensUsed).toBe(0)
    expect(replaced.continuationCount).toBe(0)
    expect(replaced.createdAt).toBe(4_000)
    expect(formatGoalStatus(replaced, 4_000)).toContain('Budget: 0 / unlimited tokens')
  })

  test('pause, resume, complete, and clear are scoped to the thread', () => {
    setThreadGoal('thread-a', { objective: 'ship feature', now: 1_000 })
    setThreadGoal('thread-b', { objective: 'different work', now: 1_000 })

    expect(updateThreadGoalStatus('thread-a', 'paused', 2_000)?.status).toBe(
      'paused',
    )
    expect(updateThreadGoalStatus('thread-a', 'active', 3_000)?.status).toBe(
      'active',
    )
    expect(
      markThreadGoalComplete('thread-a', {
        reason: 'Done according to the transcript.',
        now: 4_000,
      })?.status,
    ).toBe('complete')
    expect(formatGoalStatus(getThreadGoal('thread-a'), 4_000)).toContain(
      'Latest reason: Done according to the transcript.',
    )
    expect(getThreadGoal('thread-b')?.status).toBe('active')
    expect(clearThreadGoal('thread-a')).toBe(true)
    expect(getThreadGoal('thread-a')).toBeNull()
  })

  test('builds a native-style continuation prompt', () => {
    const goal = setThreadGoal('thread-c', {
      objective: 'PR is ready and all tests pass',
      now: 1_000,
    })

    expect(
      buildGoalContinuationPrompt(goal, 'Tests have not been run yet.'),
    ).toContain('Continue working toward the active /goal')
    expect(
      buildGoalContinuationPrompt(goal, 'Tests have not been run yet.'),
    ).toContain('<objective>PR is ready and all tests pass</objective>')
    expect(
      buildGoalContinuationPrompt(goal, 'Tests have not been run yet.'),
    ).toContain('Tests have not been run yet.')
  })
})
