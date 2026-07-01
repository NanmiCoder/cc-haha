import { describe, expect, test } from 'bun:test'
import { TaskOutputTool } from './TaskOutputTool.js'

describe('TaskOutputTool', () => {
  test('explains missing agent tasks with output_file guidance', async () => {
    const result = await TaskOutputTool.validateInput?.(
      { task_id: 'agent-missing', block: false, timeout: 1000 },
      { getAppState: () => ({ tasks: {} }) } as never,
    )

    expect(result).toMatchObject({ result: false, errorCode: 2 })
    expect(result?.message).toContain('No active task found')
    expect(result?.message).toContain('completed and been evicted')
    expect(result?.message).toContain('another process/session')
    expect(result?.message).toContain('Read')
    expect(result?.message).toContain('output_file')
  })
})
