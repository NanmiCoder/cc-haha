import { describe, expect, test } from 'bun:test'
import type { HistoryEntry } from '../../core/types'
import { subagentHeader, subagentRunView } from './subagentView'

const entry = (id: string, type: HistoryEntry['type'], content: unknown, timestamp = '2026-10-25T10:00:00.000Z'): HistoryEntry => ({
  id,
  type,
  content,
  timestamp,
})
const messages: HistoryEntry[] = [
  entry('m1', 'user', '梳理现有的配对流程，列出需要改动的位置。'),
  entry('m2', 'assistant', [
    { type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/repo/a.ts' } },
    { type: 'tool_use', id: 'r2', name: 'Grep', input: { pattern: 'pair' } },
  ]),
  entry('m3', 'user', [
    { type: 'tool_result', tool_use_id: 'r1', content: 'file a' },
    { type: 'tool_result', tool_use_id: 'r2', content: '3 matches' },
  ]),
  entry('m4', 'assistant', [{ type: 'text', text: '连接入口集中在 connectHost.ts。' }]),
  entry('m5', 'assistant', [{ type: 'tool_use', id: 'r3', name: 'Read', input: { file_path: '/repo/connectHost.ts' } }]),
]

describe('subagentRunView 归一化成和主对话一致的时间线', () => {
  test('第一条用户消息是主 Agent 交给它的任务；工具结果合并进工具行，不变成用户气泡', () => {
    const view = subagentRunView({ messages }, true)
    expect(view.prompt?.text).toBe('梳理现有的配对流程，列出需要改动的位置。')
    const kinds = view.rows.map((row) => row.kind)
    expect(kinds.filter((kind) => kind === 'message')).toHaveLength(2) // prompt + 文字回复
    const groups = view.rows.filter((row) => row.kind === 'steps')
    expect(groups).toHaveLength(2)
    expect(groups[0]?.kind === 'steps' && groups[0].steps.map((step) => step.result !== undefined)).toEqual([true, true])
    expect(view.empty).toBe(false)
  })
  test('运行中：当前一步是还没结果的工具；结束后没有', () => {
    expect(subagentRunView({ messages }, true).current).toMatchObject({ verb: '读取', object: '/repo/connectHost.ts' })
    expect(subagentRunView({ messages }, false).current).toBeNull()
  })
  test('运行中最后一组是 live（由当前步骤行承接），结束后处理过程折叠成一行', () => {
    const running = subagentRunView({ messages }, true)
    expect(running.rows.at(-1)).toMatchObject({ kind: 'steps', live: true })
    expect(running.rows.some((row) => row.kind === 'turn')).toBe(false)
    const finished = subagentRunView({ messages: messages.slice(0, 4) }, false)
    expect(finished.rows.every((row) => row.kind !== 'steps' || !row.live)).toBe(true)
  })
  test('transcript 为空：运行中保持空白，结束后退而显示电脑给出的结果', () => {
    expect(subagentRunView({ messages: [], result: '做完了' }, true)).toMatchObject({ rows: [], empty: true })
    const done = subagentRunView({ messages: [], result: '做完了' }, false)
    expect(done.rows).toHaveLength(1)
    expect(done.rows[0]).toMatchObject({ kind: 'message', item: { type: 'assistant', text: '做完了' } })
    expect(done.empty).toBe(false)
    expect(subagentRunView({ messages: [] }, false).empty).toBe(true)
  })
  test('没有数据 / 截断标记', () => {
    expect(subagentRunView(null, true)).toMatchObject({ rows: [], prompt: null, empty: true })
    expect(subagentRunView({ messages, truncated: true }, false).truncated).toBe(true)
  })
})

describe('subagentHeader', () => {
  test('名称取任务说明；状态以后台任务列表为准，找不到时退回 transcript 的状态', () => {
    expect(
      subagentHeader({ taskId: 't', status: 'running', description: ' explorer ', startedAt: '2026-10-25T10:00:00.000Z' }, { status: 'completed' })
    ).toEqual({ title: 'explorer', status: 'running', startedAt: Date.parse('2026-10-25T10:00:00.000Z') })
    expect(subagentHeader(undefined, { status: 'running' })).toEqual({ title: '子 Agent', status: 'running' })
    expect(subagentHeader(undefined, { status: 'weird' })).toMatchObject({ status: 'completed' })
    expect(subagentHeader(undefined, null)).toMatchObject({ title: '子 Agent', status: 'completed' })
  })
})
