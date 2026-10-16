import { describe, expect, test } from 'bun:test'
import { classifyFailedFiles, formatFlakeReport } from './server-test-flakes'

describe('server test flake labelling', () => {
  test('labels files without ever turning a failed run green', async () => {
    const reruns: string[] = []
    const report = await classifyFailedFiles(['src/a.test.ts', 'src/b.test.ts'], async (file) => {
      reruns.push(file)
      return file === 'src/a.test.ts'
    })

    expect(reruns).toEqual(['src/a.test.ts', 'src/b.test.ts'])
    expect(report.verdicts).toEqual([
      { file: 'src/a.test.ts', verdict: 'flaky' },
      { file: 'src/b.test.ts', verdict: 'failed' },
    ])
    // A file that passed on its re-run still fails the gate.
    expect(report.exitCode).toBe(1)
    expect(formatFlakeReport(report)[0]).toContain('FLAKY src/a.test.ts')
    expect(formatFlakeReport(report)[1]).toContain('FAILED src/b.test.ts')
  })

  test('only a run without failures exits 0', async () => {
    const onlyFlaky = await classifyFailedFiles(['src/a.test.ts'], async () => true)
    expect(onlyFlaky.exitCode).toBe(1)
    const clean = await classifyFailedFiles([], async () => { throw new Error('nothing to re-run') })
    expect(clean).toEqual({ schemaVersion: 1, verdicts: [], exitCode: 0 })
  })
})
