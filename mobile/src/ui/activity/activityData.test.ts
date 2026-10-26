import { expect, test } from 'bun:test'
import { ApiClient } from '../../core/client'
import { loadTaskList, loadTeam, loadMemberTranscript, taskState, teamMessageText, memberState, memberTasks, teamMembers, type TaskInfo, type TeamMember, type TeamWorkbenchSnapshot } from './activityData'
const task = (patch: Partial<TaskInfo>): TaskInfo => ({ id: '1', subject: '任务', description: '', status: 'pending', blocks: [], blockedBy: [], taskListId: 'session', ...patch })
const member = (patch: Partial<TeamMember>): TeamMember => ({ agentId: 'qa@team', name: 'qa', agentType: 'QA', status: 'running', ...patch })
const snapshot = (members: TeamMember[], incarnationId = 'first') => ({ version: '1', generatedAt: '', tasks: [], messages: [], team: { name: 'team/a', incarnationId, leadSessionId: 'session/a', createdAt: 1, members } }) as TeamWorkbenchSnapshot
const client = (reply: unknown, status = 200) => {
  const paths: string[] = []
  return { paths, api: new ApiClient({ id: 'fixture', name: '', url: 'http://127.0.0.1:3457', auth: 'lan' }, 'fixture', { fetch: async (url) => {
    paths.push(url)
    return { ok: status === 200, status, redirected: false, url, text: async () => JSON.stringify(reply) }
  } }) }
}
test('task progress differentiates blockers, completed and removed dependencies', () => {
  const a = task({}), b = task({ id: '2', blockedBy: ['1', 'deleted'] })
  expect(taskState(b, [a, b])).toBe('等待依赖')
  expect(taskState(b, [{ ...a, status: 'completed' }, b])).toBe('待开始')
  expect(taskState(b, [b])).toBe('待开始')
  expect(taskState({ ...b, status: 'in_progress' }, [a, b])).toBe('进行中')
})
test('member activity distinguishes stopped, retries and departed from task status', () => {
  expect(memberState(member({ status: 'failed', activity: 'active' }))).toBe('工作中')
  expect(memberState(member({ activity: 'stopped' }))).toBe('已停止')
  expect(memberState(member({ activity: 'idle' }))).toBe('空闲')
  expect(memberState(member({ activity: 'exited' }))).toBe('已退出')
  expect(memberTasks(member({}), [task({ owner: 'qa' }), task({ id: '2', owner: 'other' })])).toHaveLength(1)
})
test('archived roster keeps departed member but never imports another incarnation', () => {
  const frames = [snapshot([member({ agentId: 'old' })], 'old'), snapshot([member({})]), snapshot([])]
  const members = teamMembers({ sessionId: 's', teamName: 'team/a', incarnationId: 'first', source: 'archive', snapshots: frames })
  expect(members.map((m) => m.agentId)).toEqual(['qa@team'])
  expect(memberState(members[0]!)).toBe('已退出')
})
test('real API paths encode identity and distinguish absent team from failure', async () => {
  const fixture = client({ tasks: [task({})] })
  expect(await loadTaskList(fixture.api, 's/a', new AbortController().signal)).toHaveLength(1)
  expect(fixture.paths[0]).toContain('/api/tasks/lists/s%2Fa')
  expect(await loadTeam(client({}, 404).api, 's', new AbortController().signal)).toBeNull()
  await expect(loadTeam(client({ error: 'offline' }, 500).api, 's', new AbortController().signal)).rejects.toThrow()
  const transcript = client({ messages: [{ id: 'm', type: 'assistant', timestamp: '', content: 'verified result' }] })
  expect(await loadMemberTranscript(transcript.api, snapshot([member({})]), member({}), new AbortController().signal)).toContain('verified result')
  expect(transcript.paths[0]).toContain('/api/teams/team%2Fa/members/qa%40team/transcript?')
  expect(transcript.paths[0]).toContain('incarnationId=first')
  expect(transcript.paths[0]).toContain('leadSessionId=session%2Fa')
})

test('team communications show human text instead of protocol JSON', () => {
  const message = { id: 'm', from: 'qa', to: '*', kind: 'system', timestamp: '', text: '{"type":"idle_notification"}' }
  expect(teamMessageText(message)).toBe('成员当前空闲')
  expect(teamMessageText({ ...message, text: '实际测试结果' })).toBe('实际测试结果')
  expect(teamMessageText({ ...message, summary: '完成验证' })).toBe('完成验证')
})

test('deleted team frames never show a retained member as still working', () => {
  const frame = { ...snapshot([member({ activity: 'active' })]), deletedAt: '2026-10-25T00:00:00Z' }
  const members = teamMembers({ sessionId: 's', teamName: 'team/a', incarnationId: 'first', source: 'archive', snapshots: [frame] })
  expect(memberState(members[0]!)).toBe('已退出')
})
