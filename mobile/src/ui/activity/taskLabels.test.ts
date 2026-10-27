import { expect, test } from 'bun:test'
import type { BackgroundTask } from '../../core/operations'
import { outputPreview, stopTargets, taskGlyph, taskSubline, taskTitle } from './taskLabels'

const now = Date.parse('2026-10-25T10:00:00Z')
const task = (patch: Partial<BackgroundTask>): BackgroundTask => ({
  taskId: 'task-1',
  status: 'running',
  ...patch,
})

test('status maps to the shared glyphs', () => {
  expect(taskGlyph('running')).toBe('running')
  expect(taskGlyph('completed')).toBe('done')
  expect(taskGlyph('stopped')).toBe('stopped')
  expect(taskGlyph('failed')).toBe('failed')
})

test('title falls back to the task id', () => {
  expect(taskTitle(task({ description: '  做扫码页界面 ' }))).toBe('做扫码页界面')
  expect(taskTitle(task({ description: '' }))).toBe('task-1')
})

test('running agents show summary and elapsed; running commands show only elapsed', () => {
  const startedAt = new Date(now - 372000).toISOString()
  expect(
    taskSubline(task({ taskType: 'local_agent', summary: '编辑 src/app/connect.tsx', startedAt }), now)
  ).toEqual({ text: '编辑 src/app/connect.tsx · 6:12', mono: true, tone: 'muted' })
  expect(
    taskSubline(task({ taskType: 'local_bash', summary: 'listening', startedAt }), now)
  ).toEqual({ text: '6:12', mono: true, tone: 'muted' })
  expect(taskSubline(task({ taskType: 'local_bash' }), now).text).toBe('正在执行')
})

test('finished tasks never invent a duration', () => {
  const startedAt = new Date(now - 280000).toISOString()
  expect(
    taskSubline(task({ status: 'completed', summary: '新增 8 个用例', startedAt }), now)
  ).toEqual({ text: '完成 · 新增 8 个用例', mono: false, tone: 'muted' })
  expect(taskSubline(task({ status: 'completed' }), now).text).toBe('完成')
  expect(taskSubline(task({ status: 'stopped', startedAt }), now)).toEqual({
    text: '已停止',
    mono: false,
    tone: 'muted',
  })
  expect(taskSubline(task({ status: 'failed', summary: 'exit 1' }), now)).toEqual({
    text: '失败 · exit 1',
    mono: false,
    tone: 'err',
  })
})

test('only running commands preview two non-empty output lines', () => {
  const result = 'fixture listening on 127.0.0.1:3457\n\nGET /api/sessions 200 · 4ms\nWS connected'
  expect(outputPreview(task({ taskType: 'local_bash', result }))).toEqual([
    'fixture listening on 127.0.0.1:3457',
    'GET /api/sessions 200 · 4ms',
  ])
  expect(outputPreview(task({ taskType: 'local_bash', status: 'completed', result }))).toEqual([])
  expect(outputPreview(task({ taskType: 'local_agent', result }))).toEqual([])
  expect(outputPreview(task({ taskType: 'local_bash' }))).toEqual([])
})

test('stop targets drop tasks that already finished', () => {
  const a = task({ taskId: 'a' })
  const b = task({ taskId: 'b' })
  expect(stopTargets([a, b], [a, { ...b, status: 'completed' }]).map((item) => item.taskId)).toEqual(['a'])
})
