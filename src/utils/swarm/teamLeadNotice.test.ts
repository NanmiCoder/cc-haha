import { describe, expect, test } from 'bun:test'
import { isTeamLeadNotice, teamLaunchFailedNotice, teamLaunchedNotice, teamPlanNotice, teamStoppedNotice } from './teamLeadNotice.js'

describe('team lead notices', () => {
  test('keep the exact model-facing wording recorded in the agent-team replay cassette', () => {
    expect(teamLaunchedNotice('inventory-total', ['tester'])).toBe(
      'Approved team inventory-total is running. Members and their shared tasks are ready. Every task of tester waits on other tasks: such a member gets its instructions automatically once one of its tasks is ready. Messages sent to it before that wait in its inbox and arrive with those instructions. Each member is told to send its result to the members whose tasks depend on it before completing, so forward a result yourself only when a member says one is missing. Continue coordinating the approved team; do not spawn these members again. Members report back automatically when they finish or fail; you do not need to poll or wait in a loop.',
    )
    expect(teamLaunchedNotice('t', [])).toBe(
      'Approved team t is running. Members and their shared tasks are ready. Continue coordinating the approved team; do not spawn these members again. Members report back automatically when they finish or fail; you do not need to poll or wait in a loop.',
    )
    expect(teamStoppedNotice('t', 'user', ['- a: #1 Build (in_progress)', '- b: no unfinished task'])).toBe([
      "[Team runtime notice] The user's Stop also stopped your team t. These members are stopped and keep their work so far:",
      '- a: #1 Build (in_progress)',
      '- b: no unfinished task',
      'A stopped member does nothing until it is messaged: if the work should go on, SendMessage each member that still has work, and it resumes from its saved conversation where it left off. Do not spawn replacements or redo their tasks. If a woken member fails again with the same error (a usage limit, billing, the network), tell the user instead of retrying. If the user wants the team to stay stopped, leave them.',
    ].join('\n'))
    expect(teamLaunchFailedNotice('t', false, 'CLI exited\nstderr: bad model')).toBe(
      '[Team runtime notice] Your team t did not start, so none of its members is running. The user can review the plan and start it again, or cancel the team, from the team card; do not create the team again yourself.\nWhat failed: CLI exited\nstderr: bad model',
    )
    expect(teamPlanNotice('returned', 't')).toBe('The user returned team plan t for revision. No members were launched. Feedback: Revise the team proposal.')
    expect(teamPlanNotice('cancelled', 't', 'unused')).toBe('The user cancelled team plan t. Do not launch its members. Wait for new user instructions.')
    expect(teamPlanNotice('removed', 't')).toBe('The user cancelled team plan t before any member started, and the team was removed. You no longer lead a team. Wait for new user instructions.')
    expect(teamPlanNotice('ended', 't')).toBe('The user ended team t: its members were stopped and the team was removed. You no longer lead a team. Wait for new user instructions.')
  })

  test('recognize every notice as persisted (string or one text block), and only those', () => {
    const notices = [
      teamLaunchedNotice('todo-cli-team', ['tester']),
      teamLaunchedNotice('todo-cli-team', []),
      teamLaunchFailedNotice('t', true),
      teamLaunchFailedNotice('t', false, 'Teammate x failed to start\nstderr: …'),
      teamStoppedNotice('t', 'user', ['- a: no unfinished task']),
      teamStoppedNotice('t', 'restart', ['- a: no unfinished task']),
      teamStoppedNotice('t', 'error', ['- a (stopped on an error: 429): #2 Test (pending)']),
      teamPlanNotice('returned', 't', '换成三个成员\n前端单独一个'),
      teamPlanNotice('cancelled', 't'),
      teamPlanNotice('removed', 't'),
      teamPlanNotice('ended', 't'),
    ]
    for (const notice of notices) {
      expect(isTeamLeadNotice(notice)).toBe(true)
      expect(isTeamLeadNotice([{ type: 'text', text: notice }])).toBe(true)
    }
    // The user's own words, even quoting a notice, stay visible.
    expect(isTeamLeadNotice('Approved team foo is running? 我没看到成员')).toBe(false)
    expect(isTeamLeadNotice(`${teamPlanNotice('cancelled', 't')} 为什么取消了？`)).toBe(false)
    expect(isTeamLeadNotice(`为什么会这样：${teamLaunchedNotice('t', [])}`)).toBe(false)
    expect(isTeamLeadNotice([{ type: 'text', text: teamPlanNotice('ended', 't') }, { type: 'image' }])).toBe(false)
    expect(isTeamLeadNotice(undefined)).toBe(false)
  })
})
