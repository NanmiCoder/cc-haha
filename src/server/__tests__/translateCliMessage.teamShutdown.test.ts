import { expect, test } from 'bun:test'
import { SHUTDOWN_TEAM_PROMPT } from '../../utils/swarm/teamShutdownPrompt.js'
import { translateCliMessage } from '../ws/handler.js'

test('internal shutdown reminders cannot replay as user messages', () => {
  const message = { type: 'user', isReplay: true, message: { role: 'user', content: SHUTDOWN_TEAM_PROMPT } }
  expect(translateCliMessage(message, 'shutdown-prompt-legacy')).toEqual([])
  expect(translateCliMessage({ ...message, isMeta: true }, 'shutdown-prompt-meta')).toEqual([])
  expect(translateCliMessage({ ...message, message: { role: 'user', content: 'Real user request' } }, 'shutdown-prompt-real')).toContainEqual({ type: 'user_message_replay', content: 'Real user request' })
})
