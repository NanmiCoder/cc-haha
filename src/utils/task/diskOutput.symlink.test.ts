import { describe, expect, mock, test } from 'bun:test'

let unlinkCalled = false

mock.module('fs/promises', () => ({
  mkdir: async () => {},
  open: async () => ({ close: async () => {} }),
  stat: async () => ({ size: 0 }),
  symlink: async () => {
    const error = new Error('symlink not permitted') as Error & { code: string }
    error.code = 'EPERM'
    throw error
  },
  unlink: async () => {
    unlinkCalled = true
  },
  readFile: async () => '',
  writeFile: async () => {},
}))

mock.module('../../bootstrap/state.js', () => ({
  getSessionId: () => 'session-for-symlink-test',
}))

mock.module('../fsOperations.js', () => ({
  readFileRange: async () => '',
  tailFile: async () => '',
}))

mock.module('../log.js', () => ({
  logError: () => {},
}))

mock.module('../permissions/filesystem.js', () => ({
  getProjectTempDir: () => '/tmp/cc-haha-task-output-test',
}))

const { initTaskOutputAsSymlink, _clearOutputsForTest, _resetTaskOutputDirForTest } = await import('./diskOutput.js')

describe('initTaskOutputAsSymlink', () => {
  test('does not unlink output path when symlink fails for non-EEXIST errors', async () => {
    unlinkCalled = false
    _resetTaskOutputDirForTest()

    await initTaskOutputAsSymlink('task-id', '/tmp/transcript.jsonl')
    await _clearOutputsForTest()

    expect(unlinkCalled).toBe(false)
  })
})
