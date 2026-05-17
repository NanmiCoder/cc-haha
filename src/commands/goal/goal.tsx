import * as React from 'react'
import { getSessionId } from '../../bootstrap/state.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import {
  buildGoalStartPrompt,
  clearThreadGoal,
  getThreadGoal,
  hydrateThreadGoalFromMessages,
  parseGoalCommand,
  setThreadGoal,
} from '../../goals/goalState.js'

export async function call(
  onDone: LocalJSXCommandOnDone,
  _context: LocalJSXCommandContext,
  args: string,
): Promise<React.ReactNode> {
  const threadId = getSessionId()
  const getCurrentGoal = () =>
    getThreadGoal(threadId) ?? hydrateThreadGoalFromMessages(threadId, _context.messages)

  try {
    const parsed = parseGoalCommand(args)
    if (parsed.type === 'clear') {
      const existing = getCurrentGoal()
      const cleared = clearThreadGoal(threadId)
      onDone(
        cleared && existing ? `Goal cleared: ${existing.objective}` : 'No active goal.',
        { display: 'system' },
      )
      return null
    }

    const goal = setThreadGoal(threadId, {
      objective: parsed.objective,
    })
    onDone(`Goal set: ${goal.objective}`, {
      display: 'system',
      shouldQuery: true,
      metaMessages: [buildGoalStartPrompt(goal)],
    })
    return null
  } catch (error) {
    onDone(error instanceof Error ? error.message : String(error), {
      display: 'system',
    })
    return null
  }
}
