import { expect, test } from 'bun:test'
import { teamLaunchedNotice, teamPlanNotice } from '../../utils/swarm/teamLeadNotice.js'
import { translateCliMessage } from '../ws/handler.js'

test("the server's own team notices to the lead do not replay as the user's words", () => {
  // The CLI replays them as user turns: they arrive over stdin like the user's input.
  const replay = (text: string) => ({ type: 'user', isReplay: true, message: { role: 'user', content: [{ type: 'text', text }] } })
  expect(translateCliMessage(replay(teamLaunchedNotice('todo-cli-team', ['tester'])), 'team-notice-launched')).toEqual([])
  expect(translateCliMessage(replay(teamPlanNotice('returned', 'todo-cli-team', '拆成三个成员')), 'team-notice-returned')).toEqual([])
  expect(translateCliMessage(replay('Approved team todo-cli-team is running? 成员呢'), 'team-notice-user')).toContainEqual({
    type: 'user_message_replay',
    content: 'Approved team todo-cli-team is running? 成员呢',
  })
})
