import { describe, expect, test } from 'bun:test'
import { classifyFailedFiles, formatFlakeReport } from './server-test-flakes'
import { runServerTestFiles } from './server-test-scheduling'

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

const screenshotTest = 'src/tools/FileReadTool/FileReadTool.imageContext.test.ts'

function latch() {
  let release!: () => void
  const ready = new Promise<void>(resolve => { release = resolve })
  return { ready, release }
}

test('the 59-image regression waits for the parallel pool to drain and keeps its result', async () => {
  const first = latch(), second = latch(), secondStarted = latch(), thirdStarted = latch()
  const started: string[] = []
  const active = new Set<string>()
  const screenshotPeers: string[][] = []
  const files = ['a.test.ts', screenshotTest, 'b.test.ts', 'c.test.ts']
  const running = runServerTestFiles(files, 2, async file => {
    started.push(file)
    if (file === screenshotTest) screenshotPeers.push([...active])
    active.add(file)
    if (file === 'a.test.ts') await first.ready
    if (file === 'b.test.ts') {
      secondStarted.release()
      await second.ready
    }
    if (file === 'c.test.ts') thirdStarted.release()
    active.delete(file)
    return { file, passed: file !== screenshotTest }
  })
  try {
    await secondStarted.ready
    expect(started).toEqual(['a.test.ts', 'b.test.ts'])
    first.release()
    await thirdStarted.ready
    expect(started).toEqual(['a.test.ts', 'b.test.ts', 'c.test.ts'])
  } finally {
    first.release()
    second.release()
  }
  const results = await running
  expect(screenshotPeers).toEqual([[]])
  expect(started).toEqual(['a.test.ts', 'b.test.ts', 'c.test.ts', screenshotTest])
  expect(results).toHaveLength(files.length)
  expect(new Set(results.map(result => result.file))).toEqual(new Set(files))
  expect(results.find(result => result.file === screenshotTest)?.passed).toBe(false)
})

test('ordinary files use all requested slots and empty selections run nothing', async () => {
  const release = latch(), twoStarted = latch()
  const started: string[] = []
  let active = 0, maximum = 0
  const files = ['a.test.ts', 'b.test.ts', `${screenshotTest}.other`]
  const running = runServerTestFiles(files, 2, async file => {
    started.push(file)
    maximum = Math.max(maximum, ++active)
    if (started.length === 2) twoStarted.release()
    await release.ready
    active--
    return file
  })
  try {
    await twoStarted.ready
    expect(started).toEqual(['a.test.ts', 'b.test.ts'])
  } finally {
    release.release()
  }
  expect(new Set(await running)).toEqual(new Set(files))
  expect(maximum).toBe(2)
  expect(await runServerTestFiles([], 2, async () => { throw new Error('No file selected') })).toEqual([])
})

test('a failed ordinary file still runs the isolated regression and keeps the overall gate failed', async () => {
  const ran: string[] = []
  const results = await runServerTestFiles(['failed.test.ts', screenshotTest], 2, async file => {
    ran.push(file)
    return { file, passed: file !== 'failed.test.ts' }
  })
  expect(ran).toEqual(['failed.test.ts', screenshotTest])
  expect(results).toEqual([
    { file: 'failed.test.ts', passed: false },
    { file: screenshotTest, passed: true },
  ])
  const report = await classifyFailedFiles(results.filter(result => !result.passed).map(result => result.file), async () => true)
  expect(report.exitCode).toBe(1)
  expect(report.verdicts).toEqual([{ file: 'failed.test.ts', verdict: 'flaky' }])
})
