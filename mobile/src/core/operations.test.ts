import { expect, test } from 'bun:test'
import { ApiClient } from './client'
import {
  activityFromEvent,
  canRestoreCode,
  checkpointDiff,
  dailyCron,
  latestRuns,
  listCheckpoints,
  loadSubagentRun,
  loadTaskOutput,
  parseDiff,
  rewind,
  scheduleLabel,
  shellOutputText,
  type BackgroundOutput,
  type BackgroundTask,
  type TaskRun,
} from './operations'
import { FocusedRequests } from './focusedRequests'

test('diff preserves independent old/new line numbers across hunks and file headers', () => {
  const lines = parseDiff(
    '--- a/a.ts\n+++ b/a.ts\n@@ -4,2 +4,3 @@\n same\n-old\n+new\n+extra\n@@ -20 +21 @@\n-end\n+finish'
  )
  expect(lines[0]?.kind).toBe('meta')
  expect(lines[3]).toEqual({
    text: 'same',
    kind: 'context',
    before: 4,
    after: 4,
  })
  expect(lines[4]).toEqual({ text: 'old', kind: 'remove', before: 5 })
  expect(lines[6]).toEqual({ text: 'extra', kind: 'add', after: 6 })
  expect(lines.at(-1)).toEqual({ text: 'finish', kind: 'add', after: 21 })
})

test('checkpoint APIs bind to host, exact message and explicit rewind mode', async () => {
  const calls: { url: string; body?: string }[] = []
  const client = new ApiClient(
    { id: 'a', name: 'A', url: 'http://192.168.1.8:3456', auth: 'lan' },
    'fixture-only',
    {
      fetch: async (url, options) => {
        calls.push({ url, body: options.body })
        return {
          ok: true,
          status: 200,
          url,
          redirected: false,
          text: async () => '{}',
        }
      },
    }
  )
  const target = {
    targetUserMessageId: 'turn/a?b',
    userMessageIndex: 3,
    userMessageCount: 5,
  }
  await listCheckpoints(client, 'session-a')
  await checkpointDiff(client, 'session-a', target, 'src/a + b.ts')
  await rewind(client, 'session-a', target, 'code', false)
  expect(calls[0]?.url).toBe(
    'http://192.168.1.8:3456/api/sessions/session-a/turn-checkpoints'
  )
  expect(new URL(calls[1]!.url).searchParams.get('path')).toBe('src/a + b.ts')
  expect(JSON.parse(calls[2]!.body!)).toEqual({
    targetUserMessageId: 'turn/a?b',
    mode: 'code',
    dryRun: false,
  })
  expect(canRestoreCode(undefined)).toBe(false)
})

test('activity ownership and terminal events never fabricate completed output', () => {
  const initial = activityFromEvent([], {
    type: 'system_notification',
    subtype: 'task_started',
    data: { task_id: 'a', task_type: 'local_agent', description: 'inspect' },
  })
  expect(initial[0]).toMatchObject({
    taskId: 'a',
    status: 'running',
    description: 'inspect',
  })
  expect(
    activityFromEvent(initial, {
      type: 'system_notification',
      subtype: 'task_started',
      data: { task_id: 'b', owner_agent_id: 'child' },
    })
  ).toBe(initial)
  expect(
    activityFromEvent(initial, {
      type: 'system_notification',
      subtype: 'task_notification',
      data: { task_id: 'a', status: 'killed', summary: 'stopped by user' },
    })[0]
  ).toMatchObject({ status: 'stopped', summary: 'stopped by user' })
  expect(
    activityFromEvent(initial, {
      type: 'system_notification',
      subtype: 'other',
      data: { task_id: 'a', status: 'nonsense' },
    })
  ).toBe(initial)
})

test('simple scheduler uses computer local cron and newest real run only', () => {
  expect(dailyCron('09:05', false)).toBe('5 9 * * *')
  expect(dailyCron('0:00', true)).toBe('0 0 * * 1-5')
  for (const bad of ['24:00', '10:60', '-1:00', '09:0', '* * * * *'])
    expect(() => dailyCron(bad, false)).toThrow()
  expect(scheduleLabel('5 9 * * 1-5')).toBe('工作日 09:05')
  expect(scheduleLabel('*/15 * * * *')).toBe('*/15 * * * *')
  const make = (id: string, date: string): TaskRun => ({
    id,
    taskId: 'task',
    taskName: 'task',
    startedAt: date,
    status: 'completed',
  })
  const runs = latestRuns([
    make('new', '2026-10-24T10:00:00Z'),
    make('old', '2026-10-23T10:00:00Z'),
  ])
  expect(runs.get('task')?.id).toBe('new')
})

const shellTask: BackgroundTask = { taskId: 'task-a', toolUseId: 'bash-a', taskType: 'local_bash', status: 'running' }
const shellOutput: BackgroundOutput = { taskId: 'task-a', state: 'available', text: 'server listening\n', totalBytes: 17, truncated: false }

test('shell task output uses the selected host and exact IDs while agents keep their transcript endpoint', async () => {
  const requests: { url: string; auth: string; signal: AbortSignal }[] = []
  const client = (id: string, address: string) => new ApiClient({ id, name: id, url: address, auth: 'lan' }, `fixture-${id}`, { fetch: async (url, options) => {
    requests.push({ url, auth: options.headers.Authorization!, signal: options.signal })
    return { ok: true, status: 200, url, redirected: false, text: async () => JSON.stringify(shellOutput) }
  } })
  const a = client('a', 'http://192.168.1.2:3456')
  const b = client('b', 'http://192.168.1.3:3456')
  const controller = new AbortController()
  expect(await loadTaskOutput(a, 'session/a', { ...shellTask, taskId: 'task?b' }, controller.signal)).toEqual({ kind: 'shell', output: shellOutput })
  await loadTaskOutput(b, 'session/a', shellTask, controller.signal)
  await loadTaskOutput(a, 'session/a', { ...shellTask, taskType: 'local_agent', toolUseId: 'tool/a' }, controller.signal)
  expect(requests.map(({ url, auth }) => ({ url, auth }))).toEqual([
    { url: 'http://192.168.1.2:3456/api/sessions/session%2Fa/background-tasks/task%3Fb/output', auth: 'Bearer fixture-a' },
    { url: 'http://192.168.1.3:3456/api/sessions/session%2Fa/background-tasks/task-a/output', auth: 'Bearer fixture-b' },
    { url: 'http://192.168.1.2:3456/api/sessions/session%2Fa/subagents/by-tool/tool%2Fa?taskId=task-a', auth: 'Bearer fixture-a' },
  ])
  expect(requests.every(request => !new URL(request.url).searchParams.has('path'))).toBe(true)
})

test('missing, empty, failed and unsupported task output remain distinguishable', async () => {
  expect(shellOutputText({ ...shellOutput, state: 'empty', text: '' })).toBe('任务尚未写入输出。')
  expect(shellOutputText({ ...shellOutput, state: 'missing', text: '' })).toBe('电脑上的任务日志暂未生成或已被清理。')
  expect(shellOutputText(shellOutput)).toBe('server listening\n')
  let calls = 0
  const client = new ApiClient({ id: 'a', name: 'A', url: 'http://192.168.1.2:3456', auth: 'lan' }, 'fixture-a', { fetch: async (url) => {
    calls++
    return { ok: false, status: 403, url, redirected: false, text: async () => JSON.stringify({ message: 'Output access denied' }) }
  } })
  expect(await loadTaskOutput(client, 'session', { ...shellTask, taskType: 'local_workflow' }, new AbortController().signal)).toEqual({ kind: 'notice', text: '电脑暂不提供此类任务的日志读取。' })
  expect(calls).toBe(0)
  await expect(loadTaskOutput(client, 'session', shellTask, new AbortController().signal)).rejects.toMatchObject({ status: 403 })
})

test('closing or changing the focused task aborts its fetch and late output cannot reopen the detail', async () => {
  for (const leave of ['close', 'switch', 'blur'] as const) {
    let finish!: () => void
    let transportSignal: AbortSignal | undefined
    const client = new ApiClient({ id: 'a', name: 'A', url: 'http://192.168.1.2:3456', auth: 'lan' }, 'fixture-a', { fetch: async (url, options) => {
      transportSignal = options.signal
      await new Promise<void>(resolve => { finish = resolve })
      return { ok: true, status: 200, url, redirected: false, text: async () => JSON.stringify(shellOutput) }
    } })
    const requests = new FocusedRequests()
    requests.focus()
    const request = requests.begin()!
    let visible: string | null = null
    const pending = loadTaskOutput(client, 'session', shellTask, request.signal).then(value => {
      if (request.isCurrent() && value.kind === 'shell') visible = value.output.text
    })
    if (leave === 'blur') requests.blur()
    else if (leave === 'switch') requests.begin()
    else requests.invalidate()
    expect(transportSignal?.aborted).toBe(true)
    finish()
    await pending
    expect(visible).toBeNull()
    requests.blur()
  }
})

test('subagent run reads the by-tool transcript with escaped IDs; taskId is optional', async () => {
  const urls: string[] = []
  const client = new ApiClient({ id: 'a', name: 'a', url: 'http://192.168.1.2:3456', auth: 'lan' }, 'fixture', { fetch: async (url) => {
    urls.push(url)
    return { ok: true, status: 200, url, redirected: false, text: async () => JSON.stringify({ messages: [], status: 'running' }) }
  } })
  const signal = new AbortController().signal
  expect(await loadSubagentRun(client, 'session/a', 'tool/a', 'task?b', signal)).toEqual({ messages: [], status: 'running' })
  await loadSubagentRun(client, 'session/a', 'tool/a', undefined, signal)
  expect(urls).toEqual([
    'http://192.168.1.2:3456/api/sessions/session%2Fa/subagents/by-tool/tool%2Fa?taskId=task%3Fb',
    'http://192.168.1.2:3456/api/sessions/session%2Fa/subagents/by-tool/tool%2Fa',
  ])
})
