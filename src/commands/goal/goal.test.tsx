import { describe, expect, test } from 'bun:test'
import { switchSession } from '../../bootstrap/state.js'
import type { SessionId } from '../../types/ids.js'
import type { LocalJSXCommandContext } from '../../types/command.js'
import { createCommandInputMessage } from '../../utils/messages.js'
import { call } from './goal.js'

async function runGoal(args: string, context: Partial<LocalJSXCommandContext> = {}) {
  const calls: Array<{
    result?: string
    options?: {
      display?: string
      shouldQuery?: boolean
      metaMessages?: string[]
    }
  }> = []

  await call(
    (result, options) => {
      calls.push({ result, options })
    },
    {
      messages: [],
      ...context,
    } as LocalJSXCommandContext,
    args,
  )

  expect(calls).toHaveLength(1)
  return calls[0]!
}

describe('/goal command', () => {
  test('sets and clears a goal in one CLI session', async () => {
    switchSession(`goal-command-${crypto.randomUUID()}` as SessionId)

    const created = await runGoal('ship the smoke test')
    expect(created.result).toBe('Goal set: ship the smoke test')
    expect(created.options).toMatchObject({
      display: 'system',
      shouldQuery: true,
    })
    expect(created.options?.metaMessages?.[0]).toContain(
      '<objective>ship the smoke test</objective>',
    )

    const replaced = await runGoal('ship the replacement target')
    expect(replaced.result).toBe('Goal set: ship the replacement target')
    expect(replaced.options).toMatchObject({
      display: 'system',
      shouldQuery: true,
    })
    expect(replaced.options?.metaMessages?.[0]).toContain(
      '<objective>ship the replacement target</objective>',
    )

    const cleared = await runGoal('clear')
    expect(cleared.result).toBe('Goal cleared: ship the replacement target')
    expect(cleared.options).toMatchObject({
      display: 'system',
    })

    const empty = await runGoal('')
    expect(empty.result).toBe('Usage: /goal <condition> | clear')
    expect(empty.options).toMatchObject({
      display: 'system',
    })
  })

  test('reports usage errors without querying the model', async () => {
    switchSession(`goal-command-${crypto.randomUUID()}` as SessionId)

    const result = await runGoal('')

    expect(result.result).toBe('Usage: /goal <condition> | clear')
    expect(result.options).toMatchObject({
      display: 'system',
    })
    expect(result.options?.shouldQuery).toBeUndefined()
  })

  test('does not treat removed subcommands as replacement goals', async () => {
    switchSession(`goal-command-${crypto.randomUUID()}` as SessionId)

    const created = await runGoal('ship the smoke test')
    expect(created.result).toBe('Goal set: ship the smoke test')

    const status = await runGoal('status')
    expect(status.result).toBe('Usage: /goal <condition> | clear')
    expect(status.options?.shouldQuery).toBeUndefined()

    const cleared = await runGoal('clear')
    expect(cleared.result).toBe('Goal cleared: ship the smoke test')
  })

  test('hydrates completed goal state from persisted slash command history', async () => {
    switchSession(`goal-command-${crypto.randomUUID()}` as SessionId)

    const result = await runGoal('clear', {
      messages: [
        createCommandInputMessage([
          '<command-name>/goal</command-name>',
          '<command-args>ship persisted goal</command-args>',
        ].join('\n')),
        createCommandInputMessage([
          '<local-command-stdout>',
          'Goal set: ship persisted goal',
          '</local-command-stdout>',
        ].join('\n')),
        createCommandInputMessage([
          '<local-command-stdout>',
          'Goal marked complete.',
          '</local-command-stdout>',
        ].join('\n')),
      ],
    })

    expect(result.result).toBe('Goal cleared: ship persisted goal')
  })
})
