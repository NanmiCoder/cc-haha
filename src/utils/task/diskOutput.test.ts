import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import * as fsPromises from 'fs/promises'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

import {
  _clearOutputsForTest,
  _resetTaskOutputDirForTest,
  _setSymlinkCapableForTest,
  appendTaskOutput,
  cleanupTaskOutput,
  flushTaskOutput,
  getTaskOutput,
  getTaskOutputDir,
  getTaskOutputPath,
  getTaskOutputSize,
  initTaskOutput,
  initTaskOutputAsSymlink,
  writeTaskOutput,
} from './diskOutput.js'

const TRANSCRIPT_BODY =
  '{"type":"assistant","message":{"content":[{"type":"text","text":"agent result"}]}}\n'

/** Exercise the successful syscall branch even on unprivileged Windows hosts. */
function availableSymlinkFixture() {
  if (process.platform !== 'win32') return undefined
  // A hard link supplies real shared file bytes for this syscall substitute.
  // It is not used to claim Windows symlink/containment behavior is tested.
  return spyOn(fsPromises, 'symlink').mockImplementation(async (target, destination, type) => {
    expect(type).toBe('file')
    await fsPromises.link(target, destination)
  })
}

async function assertTranscriptLink(
  fixture: ReturnType<typeof availableSymlinkFixture>,
  target: string,
  outputPath: string,
) {
  if (fixture) {
    expect(fixture).toHaveBeenLastCalledWith(target, outputPath, 'file')
    const [targetStat, outputStat] = await Promise.all([fsPromises.stat(target), fsPromises.stat(outputPath)])
    expect([outputStat.dev, outputStat.ino]).toEqual([targetStat.dev, targetStat.ino])
  } else {
    expect((await fsPromises.lstat(outputPath)).isSymbolicLink()).toBe(true)
  }
}

/** Mirrors the real layout: transcripts live outside the tasks directory. */
function writeTranscript(taskId: string): string {
  const target = join(
    getTaskOutputDir(),
    '..',
    'subagents',
    `agent-${taskId}.jsonl`,
  )
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, TRANSCRIPT_BODY)
  return target
}

afterEach(async () => {
  await _clearOutputsForTest()
  mock.restore()
  rmSync(join(getTaskOutputDir(), '..'), { recursive: true, force: true })
  _resetTaskOutputDirForTest()
})

describe('writeTaskOutput', () => {
  test('creates a missing session output directory for the first task', async () => {
    const taskId = 'workflow-first-output'
    rmSync(getTaskOutputDir(), { recursive: true, force: true })

    await writeTaskOutput(taskId, '{"cached":true}')

    expect(readFileSync(getTaskOutputPath(taskId), 'utf8')).toBe('{"cached":true}')
  })
})

describe('initTaskOutputAsSymlink', () => {
  test('symlinks .output at the transcript when the platform allows it', async () => {
    const fixture = availableSymlinkFixture()
    _setSymlinkCapableForTest(true)
    const taskId = 'symlink-ok'
    const target = writeTranscript(taskId)

    const outputPath = await initTaskOutputAsSymlink(taskId, target)

    expect(outputPath).toBe(join(getTaskOutputDir(), `${taskId}.output`))
    await assertTranscriptLink(fixture, target, outputPath)
    expect(getTaskOutputPath(taskId)).toBe(outputPath)
    expect(await getTaskOutput(taskId)).toBe(TRANSCRIPT_BODY)
    await fsPromises.appendFile(target, 'later result\n')
    expect(await getTaskOutput(taskId)).toBe(`${TRANSCRIPT_BODY}later result\n`)
  })

  test('links before the target exists — the agent transcript is written later', async () => {
    _setSymlinkCapableForTest(true)
    const taskId = 'symlink-dangling'
    const target = join(
      getTaskOutputDir(),
      '..',
      'subagents',
      `agent-${taskId}.jsonl`,
    )

    await initTaskOutputAsSymlink(taskId, target)
    // Agent starts producing output only now.
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, TRANSCRIPT_BODY)

    expect(await getTaskOutput(taskId)).toBe(TRANSCRIPT_BODY)
  })

  test('replaces a file already sitting at the output path', async () => {
    const fixture = availableSymlinkFixture()
    _setSymlinkCapableForTest(true)
    const taskId = 'symlink-occupied'
    const target = writeTranscript(taskId)
    await initTaskOutput(taskId)

    const outputPath = await initTaskOutputAsSymlink(taskId, target)

    await assertTranscriptLink(fixture, target, outputPath)
    expect(getTaskOutputPath(taskId)).toBe(outputPath)
    expect(await getTaskOutput(taskId)).toBe(TRANSCRIPT_BODY)
    await fsPromises.appendFile(target, 'replacement result\n')
    expect(await getTaskOutput(taskId)).toBe(`${TRANSCRIPT_BODY}replacement result\n`)
  })

  // #1141: Windows only grants symlink privileges to administrators / Developer
  // Mode. Agent tasks never append to .output — the symlink is how the result
  // is delivered — so falling back to an empty placeholder lost the result
  // entirely: every background agent's .output stayed 0 bytes.
  describe('when symlinks are unavailable (Windows without Developer Mode)', () => {
    test('reads resolve to the transcript instead of an empty placeholder', async () => {
      _setSymlinkCapableForTest(false)
      const taskId = 'symlink-denied'
      const target = writeTranscript(taskId)

      const outputPath = await initTaskOutputAsSymlink(taskId, target)

      expect(outputPath).toBe(target)
      expect(await getTaskOutput(taskId)).toBe(TRANSCRIPT_BODY)
      expect(await getTaskOutputSize(taskId)).toBe(TRANSCRIPT_BODY.length)
    })

    test('hands the model a path that actually has the output', async () => {
      _setSymlinkCapableForTest(false)
      const taskId = 'symlink-denied-path'
      const target = writeTranscript(taskId)

      // registerAsyncAgent voids this promise and AgentTool reads the path in
      // the same tick, so the redirect has to be registered synchronously.
      void initTaskOutputAsSymlink(taskId, target)

      const exposed = getTaskOutputPath(taskId)
      expect(exposed).toBe(target)
      expect(readFileSync(exposed, 'utf8')).toBe(TRANSCRIPT_BODY)
    })

    test('never writes into the redirected transcript', async () => {
      _setSymlinkCapableForTest(false)
      const taskId = 'symlink-denied-write'
      const target = writeTranscript(taskId)
      await initTaskOutputAsSymlink(taskId, target)

      appendTaskOutput(taskId, 'stray write')
      await flushTaskOutput(taskId)

      expect(readFileSync(target, 'utf8')).toBe(TRANSCRIPT_BODY)
      expect(readFileSync(join(getTaskOutputDir(), `${taskId}.output`), 'utf8')).toBe(
        'stray write',
      )
    })

    test('never unlinks the redirected transcript on cleanup', async () => {
      _setSymlinkCapableForTest(false)
      const taskId = 'symlink-denied-cleanup'
      const target = writeTranscript(taskId)
      await initTaskOutputAsSymlink(taskId, target)

      await cleanupTaskOutput(taskId)

      expect(existsSync(target)).toBe(true)
      expect(getTaskOutputPath(taskId)).toBe(
        join(getTaskOutputDir(), `${taskId}.output`),
      )
    })
  })

  test('redirects reads when symlink() fails despite the probe passing', async () => {
    _setSymlinkCapableForTest(true)
    const taskId = 'symlink-throws'

    mock.module('fs/promises', () => ({
      ...fsPromises,
      symlink: async () => {
        const err = new Error(
          'EPERM: operation not permitted, symlink',
        ) as NodeJS.ErrnoException
        err.code = 'EPERM'
        throw err
      },
    }))
    const disk = await import(`./diskOutput.js?throwing=${process.pid}`)
    disk._setSymlinkCapableForTest(true)
    const target = writeTranscript(taskId)

    await disk.initTaskOutputAsSymlink(taskId, target)

    expect(await disk.getTaskOutput(taskId)).toBe(TRANSCRIPT_BODY)
    // Placeholder still exists so a path captured earlier stays valid.
    expect(statSync(join(getTaskOutputDir(), `${taskId}.output`)).size).toBe(0)
    await disk._clearOutputsForTest()
  })
})

describe('appendTaskOutput', () => {
  test('appends across calls and reports size', async () => {
    const taskId = 'append-basic'
    appendTaskOutput(taskId, 'first\n')
    appendTaskOutput(taskId, 'second\n')
    await flushTaskOutput(taskId)

    expect(await getTaskOutput(taskId)).toBe('first\nsecond\n')
    expect(await getTaskOutputSize(taskId)).toBe('first\nsecond\n'.length)
  })

  test('reads of an absent task are empty rather than throwing', async () => {
    expect(await getTaskOutput('never-created')).toBe('')
    expect(await getTaskOutputSize('never-created')).toBe(0)
  })
})
