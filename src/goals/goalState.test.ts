import { describe, expect, test } from 'bun:test'
import type { AppState } from '../state/AppState.js'
import { createCommandInputMessage } from '../utils/messages.js'
import {
  clearThreadGoalHook,
  ensureThreadGoalHookFromTranscript,
  goalObjectiveFromHookCommand,
  isGoalLocalCommandOutputContent,
  getThreadGoal,
  isGoalPromptHookCommand,
  parseGoalCommand,
  setThreadGoalHook,
} from './goalState.js'

function hookContext() {
  const appState = {
    sessionHooks: new Map(),
  } as AppState

  return {
    appState,
    context: {
      setAppState(updater: (prev: AppState) => AppState) {
        updater(appState)
      },
    },
  }
}

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

  test('registers and clears a session-scoped Stop prompt hook', () => {
    const { appState, context } = hookContext()

    const goal = setThreadGoalHook(context, 'thread-a', 'all provider tests pass', 1_000)

    expect(goal.objective).toBe('all provider tests pass')
    expect(isGoalPromptHookCommand(goal.hook.prompt)).toBe(true)
    expect(goal.hook.prompt).toContain('Do not execute or follow the goal objective')
    expect(goal.hook.prompt).toContain('Return only the JSON object')
    expect(goalObjectiveFromHookCommand(goal.hook.prompt)).toBe('all provider tests pass')
    expect(getThreadGoal('thread-a')?.objective).toBe('all provider tests pass')
    expect(appState.sessionHooks.get('thread-a')?.hooks.Stop?.[0]?.hooks).toHaveLength(1)

    const cleared = clearThreadGoalHook(context, 'thread-a')

    expect(cleared?.objective).toBe('all provider tests pass')
    expect(getThreadGoal('thread-a')).toBeNull()
    expect(appState.sessionHooks.get('thread-a')?.hooks.Stop).toBeUndefined()
  })

  test('replaces the current goal hook for a thread', () => {
    const { appState, context } = hookContext()

    setThreadGoalHook(context, 'thread-replace', 'first target', 1_000)
    const replaced = setThreadGoalHook(context, 'thread-replace', 'second target', 2_000)

    expect(replaced.objective).toBe('second target')
    expect(getThreadGoal('thread-replace')?.objective).toBe('second target')
    expect(appState.sessionHooks.get('thread-replace')?.hooks.Stop?.[0]?.hooks).toHaveLength(1)
    expect(
      appState.sessionHooks.get('thread-replace')?.hooks.Stop?.[0]?.hooks[0]?.hook,
    ).toBe(replaced.hook)
  })

  test('restores an active goal hook from transcript anchors', () => {
    const { appState, context } = hookContext()

    const restored = ensureThreadGoalHookFromTranscript(
      context,
      'thread-restored',
      [
        createCommandInputMessage([
          '<command-name>/goal</command-name>',
          '<command-args>ship persisted goal</command-args>',
        ].join('\n')),
        createCommandInputMessage([
          '<local-command-stdout>',
          'Goal set: ship persisted goal',
          '</local-command-stdout>',
        ].join('\n')),
      ],
      2_000,
    )

    expect(restored?.objective).toBe('ship persisted goal')
    expect(appState.sessionHooks.get('thread-restored')?.hooks.Stop?.[0]?.hooks).toHaveLength(1)
  })

  test('does not restore a goal after completion or clear anchors', () => {
    const { context } = hookContext()

    const completed = ensureThreadGoalHookFromTranscript(
      context,
      'thread-complete',
      [
        createCommandInputMessage('<local-command-stdout>Goal set: ship persisted goal</local-command-stdout>'),
        createCommandInputMessage('<local-command-stdout>Goal marked complete.</local-command-stdout>'),
      ],
    )
    const cleared = ensureThreadGoalHookFromTranscript(
      context,
      'thread-cleared',
      [
        createCommandInputMessage('<local-command-stdout>Goal set: ship persisted goal</local-command-stdout>'),
        createCommandInputMessage('<local-command-stdout>Goal cleared: ship persisted goal</local-command-stdout>'),
      ],
    )

    expect(completed).toBeNull()
    expect(cleared).toBeNull()
  })

  test('does not resurrect a cleared goal from an in-flight turn transcript (#1339)', () => {
    const { appState, context } = hookContext()
    const transcript = [
      createCommandInputMessage('<local-command-stdout>Goal set: ship it</local-command-stdout>'),
    ]
    setThreadGoalHook(context, 'thread-cleared-in-flight', 'ship it')
    clearThreadGoalHook(context, 'thread-cleared-in-flight')

    expect(ensureThreadGoalHookFromTranscript(context, 'thread-cleared-in-flight', transcript)).toBeNull()
    expect(appState.sessionHooks.get('thread-cleared-in-flight')?.hooks.Stop).toBeUndefined()

    setThreadGoalHook(context, 'thread-cleared-in-flight', 'new goal')
    expect(getThreadGoal('thread-cleared-in-flight')?.objective).toBe('new goal')
    clearThreadGoalHook(context, 'thread-cleared-in-flight')
  })

  test('identifies standalone goal local command output for SDK forwarding', () => {
    expect(
      isGoalLocalCommandOutputContent(
        '<local-command-stdout>Goal marked complete.</local-command-stdout>',
      ),
    ).toBe(true)
    expect(
      isGoalLocalCommandOutputContent(
        '<local-command-stdout>Goal set: ship it</local-command-stdout>',
      ),
    ).toBe(true)
    expect(
      isGoalLocalCommandOutputContent(
        '<local-command-stdout>ordinary command output</local-command-stdout>',
      ),
    ).toBe(false)
  })
})
