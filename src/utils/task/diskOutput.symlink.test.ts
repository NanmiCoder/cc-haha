import { describe, expect, test } from 'bun:test'

async function runIsolated(script: string) {
  const proc = Bun.spawn(['bun', '-e', script], {
    cwd: process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, exitCode }
}

describe('initTaskOutputAsSymlink', () => {
  test('does not unlink output path when symlink fails for non-EEXIST errors', async () => {
    const result = await runIsolated(String.raw`
      import { mock } from 'bun:test'

      let unlinkCalled = false

      mock.module('fs/promises', () => ({
        mkdir: async () => {},
        open: async () => ({ close: async () => {} }),
        stat: async () => ({ size: 0 }),
        symlink: async () => {
          const error = new Error('symlink not permitted')
          error.code = 'EPERM'
          throw error
        },
        unlink: async () => {
          unlinkCalled = true
        },
        readFile: async () => '',
        writeFile: async () => {},
      }))

      mock.module('./src/bootstrap/state.js', () => ({
        getSessionId: () => 'session-for-symlink-test',
      }))

      mock.module('./src/utils/fsOperations.js', () => ({
        readFileRange: async () => '',
        tailFile: async () => '',
      }))

      mock.module('./src/utils/log.js', () => ({
        logError: () => {},
      }))

      mock.module('./src/utils/permissions/filesystem.js', () => ({
        getProjectTempDir: () => '/tmp/cc-haha-task-output-test',
      }))

      const modulePath = './src/utils/task/' + 'diskOutput.js'
      const { initTaskOutputAsSymlink, _clearOutputsForTest, _resetTaskOutputDirForTest } = await import(modulePath)
      _resetTaskOutputDirForTest()
      await initTaskOutputAsSymlink('task-id', '/tmp/transcript.jsonl')
      await _clearOutputsForTest()

      if (unlinkCalled) {
        throw new Error('unlink was called for non-EEXIST symlink failure')
      }
    `)

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
  })
})
