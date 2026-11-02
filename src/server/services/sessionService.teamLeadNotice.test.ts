import { expect, test } from 'bun:test'
import { teamLaunchedNotice, teamStoppedNotice } from '../../utils/swarm/teamLeadNotice.js'
import { sessionService } from './sessionService.js'

test("the server's team notices to the lead stay out of restored chat history", () => {
  const entriesToMessages = (sessionService as unknown as { entriesToMessages: (entries: unknown[]) => { content: unknown }[] }).entriesToMessages.bind(sessionService)
  const entry = (text: string) => ({ type: 'user', uuid: crypto.randomUUID(), message: { role: 'user', content: [{ type: 'text', text }] } })
  const messages = entriesToMessages([
    entry('用团队做一个待办'),
    entry(teamLaunchedNotice('todo-cli-team', ['tester'])),
    entry(teamStoppedNotice('todo-cli-team', 'user', ['- tester: #2 Test (pending)'])),
    entry('继续'),
  ])
  expect(messages.map(message => JSON.stringify(message.content))).toEqual([
    JSON.stringify([{ type: 'text', text: '用团队做一个待办' }]),
    JSON.stringify([{ type: 'text', text: '继续' }]),
  ])
})
