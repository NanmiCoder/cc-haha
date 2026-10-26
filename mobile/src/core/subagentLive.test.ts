import { describe, expect, test } from 'bun:test'
import { chatReducer, createChatState } from './chat'
import {
  MAX_SUBAGENT_ENTRIES,
  MAX_SUBAGENT_STEPS,
  liveFor,
  reduceSubagents,
  runKey,
  taskKey,
  toolKey,
} from './subagentLive'
import type { ServerEvent } from './types'

const route = { runAgentId: 'agent-1', streamId: 's1', targetAgentId: 'agent-1' }
const run = (event: Extract<ServerEvent, { type: 'agent_run_event' }>['event'], runAgentId = 'agent-1'): ServerEvent => ({
  type: 'agent_run_event',
  ...route,
  runAgentId,
  event,
})
const toolUse = (id: string, name = 'Read', input: unknown = { file_path: `/repo/${id}.ts` }) =>
  run({ type: 'tool_use_complete', toolName: name, toolUseId: id, input })
const toolResult = (id: string, isError = false) =>
  run({ type: 'tool_result', toolUseId: id, content: 'ok', isError })

const apply = (events: ServerEvent[]) =>
  events.reduce<ReturnType<typeof reduceSubagents>>((live, event) => reduceSubagents(live, event), undefined)

describe('agent_run_event 累积子 Agent 实时步骤', () => {
  test('工具调用进入步骤，结果把它标成完成', () => {
    const live = apply([toolUse('a'), toolResult('a'), toolUse('b', 'Bash', { command: 'bun test' })])
    expect(live?.[runKey('agent-1')]?.steps).toEqual([
      { toolUseId: 'a', toolName: 'Read', input: { file_path: '/repo/a.ts' }, done: true, isError: false },
      { toolUseId: 'b', toolName: 'Bash', input: { command: 'bun test' }, done: false },
    ])
  })

  test('失败的结果带上 isError，未知 id 的结果被忽略', () => {
    const live = apply([toolUse('a'), toolResult('a', true)])
    expect(live?.[runKey('agent-1')]?.steps[0]).toMatchObject({ done: true, isError: true })
    expect(reduceSubagents(live, toolResult('missing'))).toBe(live)
  })

  test('只留最近几步，不会无限增长', () => {
    const events = Array.from({ length: MAX_SUBAGENT_STEPS + 5 }, (_, index) => toolUse(`t${index}`))
    const steps = apply(events)?.[runKey('agent-1')]?.steps ?? []
    expect(steps).toHaveLength(MAX_SUBAGENT_STEPS)
    expect(steps.at(-1)?.toolUseId).toBe(`t${MAX_SUBAGENT_STEPS + 4}`)
    expect(steps[0]?.toolUseId).toBe('t5')
  })

  test('同一个工具调用重复到达只更新、不重复记步', () => {
    const live = apply([toolUse('a', 'Read', undefined), toolUse('a')])
    const entry = live?.[runKey('agent-1')]
    expect(entry?.steps).toHaveLength(1)
    expect(entry?.steps[0]?.input).toEqual({ file_path: '/repo/a.ts' })
    expect(entry?.reads).toEqual(['/repo/a.ts'])
  })

  test('读过的文件按路径去重计数，其他工具不算', () => {
    const live = apply([
      toolUse('a'),
      toolUse('b', 'Read', { file_path: '/repo/a.ts' }),
      toolUse('c', 'Read', { file_path: '/repo/c.ts' }),
      toolUse('d', 'Grep', { pattern: 'x' }),
    ])
    expect(live?.[runKey('agent-1')]?.reads).toEqual(['/repo/a.ts', '/repo/c.ts'])
  })

  test('运行结束（status idle / error）把未完成步骤收口并标记 finished', () => {
    const live = apply([toolUse('a'), run({ type: 'status', state: 'idle' })])
    expect(live?.[runKey('agent-1')]).toMatchObject({ finished: true, steps: [{ done: true }] })
    const again = reduceSubagents(live, run({ type: 'status', state: 'idle' }))
    expect(again).toBe(live)
    const errored = apply([toolUse('a'), run({ type: 'error', message: 'x', code: 'AGENT_RUN_ERROR' })])
    expect(errored?.[runKey('agent-1')]?.finished).toBe(true)
  })

  test('文字流、思考等不带步骤的事件保持同一个对象', () => {
    const live = apply([toolUse('a')])
    for (const event of [
      run({ type: 'content_delta', text: 'hi' }),
      run({ type: 'thinking', text: 'hmm' }),
      run({ type: 'status', state: 'thinking' }),
      { type: 'content_delta', text: 'root' } as ServerEvent,
    ])
      expect(reduceSubagents(live, event)).toBe(live)
  })

  test('不同 run 各记各的', () => {
    const live = apply([toolUse('a'), run({ type: 'tool_use_complete', toolName: 'Read', toolUseId: 'z', input: {} }, 'agent-2')])
    expect(Object.keys(live ?? {}).sort()).toEqual([runKey('agent-1'), runKey('agent-2')])
  })

  const spawn = (i: number) =>
    run({ type: 'tool_use_complete', toolName: 'Read', toolUseId: `t${i}`, input: {} }, `agent-${i}`)

  test('只保留最近的若干个子 Agent，丢最久没动静的', () => {
    const live = apply(Array.from({ length: MAX_SUBAGENT_ENTRIES + 4 }, (_, i) => spawn(i)))!
    expect(Object.keys(live)).toHaveLength(MAX_SUBAGENT_ENTRIES)
    expect(live[runKey(`agent-${MAX_SUBAGENT_ENTRIES + 3}`)]).toBeDefined()
    expect(live[runKey('agent-0')]).toBeUndefined()
  })

  test('一直在更新的子 Agent 即使最早出现也不会被挤掉', () => {
    const live = apply([
      ...Array.from({ length: MAX_SUBAGENT_ENTRIES }, (_, i) => spawn(i)),
      run({ type: 'tool_use_complete', toolName: 'Bash', toolUseId: 'late', input: {} }, 'agent-0'),
      ...Array.from({ length: 3 }, (_, i) => spawn(100 + i)),
    ])!
    expect(live[runKey('agent-0')]?.steps.map((step) => step.toolUseId)).toEqual(['t0', 'late'])
    expect(live[runKey('agent-1')]).toBeUndefined()
  })
})

describe('带 parentToolUseId 的工具事件（后台子 Agent 的 agent_tool_activity）', () => {
  const child = (id: string, parent?: string): ServerEvent => ({
    type: 'tool_use_complete',
    toolName: 'Read',
    toolUseId: `${parent}:${id}`,
    input: { file_path: `/repo/${id}.ts` },
    ...(parent ? { parentToolUseId: parent } : {}),
  })

  test('按父级 Agent 工具调用记在 tool 通道，主 Agent 自己的工具不记', () => {
    const live = apply([child('a', 'agent-tool'), child('b'), {
      type: 'tool_result',
      toolUseId: 'agent-tool:a',
      content: 'ok',
      isError: false,
      parentToolUseId: 'agent-tool',
    }])
    expect(Object.keys(live ?? {})).toEqual([toolKey('agent-tool')])
    expect(live?.[toolKey('agent-tool')]?.steps).toMatchObject([{ toolUseId: 'agent-tool:a', done: true }])
  })
})

describe('task_progress 通知', () => {
  const progress = (taskId: string, toolUses: unknown): ServerEvent => ({
    type: 'system_notification',
    subtype: 'task_progress',
    data: { task_id: taskId, usage: { tool_uses: toolUses, total_tokens: 10 } },
  })
  test('记录电脑给出的工具调用总数，相同数值不触发更新', () => {
    const live = apply([progress('t1', 8)])
    expect(live?.[taskKey('t1')]?.toolUses).toBe(8)
    expect(reduceSubagents(live, progress('t1', 8))).toBe(live)
    expect(reduceSubagents(live, progress('t1', 9))?.[taskKey('t1')]?.toolUses).toBe(9)
  })
  test('没有数字、没有 task_id 的通知忽略；终态通知标记 finished', () => {
    expect(reduceSubagents(undefined, progress('t1', 'many'))).toBeUndefined()
    expect(reduceSubagents(undefined, { type: 'system_notification', subtype: 'task_progress', data: {} })).toBeUndefined()
    const live = apply([progress('t1', 3), { type: 'system_notification', subtype: 'task_notification', data: { task_id: 't1', status: 'completed' } }])
    expect(live?.[taskKey('t1')]?.finished).toBe(true)
  })
})

describe('liveFor 合并三条通道', () => {
  test('步骤优先 run 通道，其次 tool 通道；计数来自 task 通道', () => {
    const live = apply([
      toolUse('r1'),
      { type: 'tool_use_complete', toolName: 'Read', toolUseId: 'p:x', input: { file_path: '/x' }, parentToolUseId: 'parent' },
      { type: 'system_notification', subtype: 'task_progress', data: { task_id: 'agent-1', usage: { tool_uses: 5 } } },
    ])
    const merged = liveFor(live, { taskId: 'agent-1', toolUseId: 'parent' })
    expect(merged?.steps.map((step) => step.toolUseId)).toEqual(['r1'])
    expect(merged?.toolUses).toBe(5)
    expect(merged?.reads).toBe(1)
    const viaTool = liveFor(live, { taskId: 'other', toolUseId: 'parent' })
    expect(viaTool?.steps.map((step) => step.toolUseId)).toEqual(['p:x'])
  })
  test('完全没有数据时返回 null', () => {
    expect(liveFor(undefined, { taskId: 'a' })).toBeNull()
    expect(liveFor({}, { taskId: 'a', toolUseId: 'b' })).toBeNull()
  })
})

describe('chatReducer 接入', () => {
  test('agent_run_event 进入 state.subagents，主对话流不变', () => {
    const state = createChatState('s')
    const next = chatReducer(state, toolUse('a'))
    expect(next.items).toBe(state.items)
    expect(next.subagents?.[runKey('agent-1')]?.steps).toHaveLength(1)
  })
  test('没有可记录内容时状态对象保持不变', () => {
    const state = createChatState('s')
    expect(chatReducer(state, run({ type: 'content_delta', text: 'x' }))).toBe(state)
  })
  test('带 parentToolUseId 的工具事件仍进入主列表，同时记入子 Agent 轨迹', () => {
    const state = createChatState('s')
    const next = chatReducer(state, {
      type: 'tool_use_complete',
      toolName: 'Read',
      toolUseId: 'p:1',
      input: { file_path: '/a' },
      parentToolUseId: 'p',
    })
    expect(next.items).toHaveLength(1)
    expect(next.subagents?.[toolKey('p')]?.steps).toHaveLength(1)
  })
})
