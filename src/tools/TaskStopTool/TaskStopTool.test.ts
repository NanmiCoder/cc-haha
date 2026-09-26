import { describe, expect, test } from 'bun:test'
import type { AppState } from '../../state/AppState.js'
import type { ToolUseContext } from '../../Tool.js'
import { TaskStopTool } from './TaskStopTool.js'

function makeContext(task?: Record<string, unknown>) {
  const state = {
    tasks: task ? { [String(task.id)]: task } : {},
  } as unknown as AppState
  return {
    getAppState: () => state,
  } as unknown as ToolUseContext
}

function shellTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'bstop-test',
    type: 'local_bash',
    status: 'running',
    description: 'Stop task',
    command: 'sleep 10',
    startTime: 1,
    outputFile: '',
    outputOffset: 0,
    notified: false,
    completionStatusSentInAttachment: false,
    shellCommand: { kill() {} },
    lastReportedTotalLines: 0,
    isBackgrounded: true,
    ...overrides,
  }
}

describe('TaskStopTool validation', () => {
  test('requires a task id and rejects unknown tasks', async () => {
    await expect(TaskStopTool.validateInput({}, makeContext())).resolves.toMatchObject({
      result: false,
      errorCode: 1,
    })
    await expect(TaskStopTool.validateInput({ task_id: 'bmissing' }, makeContext())).resolves.toMatchObject({
      result: false,
      errorCode: 1,
    })
  })

  test('accepts a controllable running task and the deprecated shell id', async () => {
    const context = makeContext(shellTask())
    await expect(TaskStopTool.validateInput({ task_id: 'bstop-test' }, context)).resolves.toEqual({ result: true })
    await expect(TaskStopTool.validateInput({ shell_id: 'bstop-test' }, context)).resolves.toEqual({ result: true })
  })

  test('拒绝重复终止和缺少进程句柄的恢复任务', async () => {
    await expect(TaskStopTool.validateInput(
      { task_id: 'bstop-test' },
      makeContext(shellTask({ terminationPending: true })),
    )).resolves.toMatchObject({ result: false, errorCode: 4 })
    await expect(TaskStopTool.validateInput(
      { task_id: 'bstop-test' },
      makeContext(shellTask({ shellCommand: null })),
    )).resolves.toMatchObject({ result: false, errorCode: 3 })
  })

  test('调用时拒绝缺失或不存在的任务', async () => {
    await expect(TaskStopTool.call({}, makeContext())).rejects.toThrow('Missing required parameter: task_id')
    await expect(TaskStopTool.call({ task_id: 'bmissing' }, makeContext())).rejects.toThrow()
  })

  test('rejects terminal and unverified shell tasks', async () => {
    await expect(TaskStopTool.validateInput(
      { task_id: 'bstop-test' },
      makeContext(shellTask({ status: 'completed' })),
    )).resolves.toMatchObject({ result: false, errorCode: 3 })
    await expect(TaskStopTool.validateInput(
      { task_id: 'bstop-test' },
      makeContext(shellTask({ processObservation: 'unknown' })),
    )).resolves.toMatchObject({ result: false, errorCode: 3 })
  })
})
