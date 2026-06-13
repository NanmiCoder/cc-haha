import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  _clearOutputsForTest,
  _resetTaskOutputDirForTest,
  getTaskOutput,
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

  test('writes diagnostic output when agent transcript symlink fallback is used', async () => {
    const root = mkdtempSync(join(tmpdir(), 'task-output-symlink-fallback-'))
    tempDirs.push(root)
    const taskId = 'agent-symlink-fallback'
    const targetPath = join(root, 'transcript.jsonl')
    const outputPath = await initTaskOutputAsSymlink(taskId, targetPath)

    rmSync(outputPath, { force: true })
    writeFileSync(outputPath, '')
    const fallbackPath = await initTaskOutputAsSymlink(taskId, targetPath)

    expect(fallbackPath).toBe(outputPath)
    expect(await getTaskOutput(taskId)).toContain(targetPath)
    expect(await getTaskOutput(taskId)).toContain('Agent transcript symlink unavailable')
  })
})
