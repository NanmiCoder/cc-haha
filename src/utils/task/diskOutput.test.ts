import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  _clearOutputsForTest,
  _resetTaskOutputDirForTest,
  getTaskOutput,
  initTaskOutput,
  initTaskOutputAsSymlink,
} from './diskOutput.js'

const tempDirs: string[] = []

describe('task disk output', () => {
  afterEach(async () => {
    await _clearOutputsForTest()
    _resetTaskOutputDirForTest()
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('initTaskOutput creates a readable empty output file', async () => {
    const taskId = 'agent-init-output'
    const outputPath = await initTaskOutput(taskId)

    expect(outputPath).toContain(taskId)
    expect(outputPath).toContain('.output')
    // The file should exist and be readable (empty)
    expect(await getTaskOutput(taskId)).toBe('')
  })

  test('initTaskOutputAsSymlink creates an output path for the task', async () => {
    const root = mkdtempSync(join(tmpdir(), 'task-output-symlink-'))
    tempDirs.push(root)
    const taskId = 'agent-symlink-ok'
    const targetPath = join(root, 'transcript.jsonl')
    const outputPath = await initTaskOutputAsSymlink(taskId, targetPath)

    expect(outputPath).toContain(taskId)
    expect(outputPath).toContain('.output')
  })
})
