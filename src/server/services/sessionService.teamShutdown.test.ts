import { expect, test } from 'bun:test'
import { SHUTDOWN_TEAM_PROMPT } from '../../utils/swarm/teamShutdownPrompt.js'
import { sessionService } from './sessionService.js'

test('old shutdown reminders without isMeta stay out of restored chat history', () => {
  const entriesToMessages = (sessionService as unknown as { entriesToMessages: (entries: unknown[]) => unknown[] }).entriesToMessages.bind(sessionService)
  const entry = (content: string) => ({ type: 'user', uuid: crypto.randomUUID(), message: { role: 'user', content } })
  expect(entriesToMessages([entry('Visible request'), entry(SHUTDOWN_TEAM_PROMPT)])).toHaveLength(1)
})
