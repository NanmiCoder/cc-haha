import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID, type UUID } from 'crypto'
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  getIsInteractive,
  getOriginalCwd,
  getSessionId,
  setIsInteractive,
  setOriginalCwd,
} from '../bootstrap/state.js'
import {
  fileHistoryMakeSnapshot,
  fileHistoryCompleteSnapshot,
  withFileHistoryCompletion,
  migrateFileHistorySnapshot,
  readBackupFileSafely,
  fileHistoryRewind,
  fileHistoryTrackEdit,
  type FileHistoryState,
} from './fileHistory.js'

const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
const originalDisableCheckpointing =
  process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING
const originalCwd = getOriginalCwd()
const originalInteractive = getIsInteractive()
let testRoot: string | null = null

beforeEach(async () => {
  testRoot = await mkdtemp(join(tmpdir(), 'cc-haha-file-history-security-'))
  process.env.CLAUDE_CONFIG_DIR = join(testRoot, 'config')
  delete process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING
  setOriginalCwd(join(testRoot, 'project'))
  setIsInteractive(true)
  await mkdir(getOriginalCwd(), { recursive: true })
})

afterEach(async () => {
  setOriginalCwd(originalCwd)
  setIsInteractive(originalInteractive)
  restoreEnv('CLAUDE_CONFIG_DIR', originalConfigDir)
  restoreEnv(
    'CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING',
    originalDisableCheckpointing,
  )
  if (testRoot) {
    await Bun.sleep(50)
    await rm(testRoot, { recursive: true, force: true })
    testRoot = null
  }
})

describe('file history rewind link safety', () => {
  test('refuses to create a backup through a symlinked backup directory', async () => {
    const targetMessageId = randomUUID() as UUID
    const trackedPath = join(getOriginalCwd(), 'tracked.txt')
    const outsideBackupDirectory = join(testRoot!, 'outside-backups')
    const backupRoot = join(
      process.env.CLAUDE_CONFIG_DIR!,
      'file-history',
    )
    await writeFile(trackedPath, 'snapshot content')
    await mkdir(backupRoot, { recursive: true })
    await mkdir(outsideBackupDirectory)
    await symlink(
      outsideBackupDirectory,
      join(backupRoot, getSessionId()),
    )
    const { getState, updateState } = createHistoryState(targetMessageId)

    await fileHistoryTrackEdit(updateState, trackedPath, targetMessageId)

    expect(await readdir(outsideBackupDirectory)).toEqual([])
    expect(getState().trackedFiles.size).toBe(0)
  })

  test('cleans up a partial backup when snapshot copying fails', async () => {
    const targetMessageId = randomUUID() as UUID
    const trackedPath = join(getOriginalCwd(), 'tracked.txt')
    await writeFile(trackedPath, 'snapshot content')
    const { getState, updateState } = createHistoryState(targetMessageId)
    const probe = await open(trackedPath, 'r')
    const fileHandlePrototype = Object.getPrototypeOf(probe) as {
      write: (...args: unknown[]) => Promise<unknown>
    }
    await probe.close()
    const originalWrite = fileHandlePrototype.write
    fileHandlePrototype.write = async function () {
      throw new Error('injected backup write failure')
    }

    try {
      await fileHistoryTrackEdit(updateState, trackedPath, targetMessageId)
    } finally {
      fileHandlePrototype.write = originalWrite
    }

    const backupDirectory = join(
      process.env.CLAUDE_CONFIG_DIR!,
      'file-history',
      getSessionId(),
    )
    expect(await readdir(backupDirectory)).toEqual([])
    expect(getState().trackedFiles.size).toBe(0)
  })

  test.each(['symlink', 'hardlink'] as const)(
    'does not overwrite an external victim through a %s',
    async linkType => {
      const targetMessageId = randomUUID() as UUID
      const trackedPath = join(getOriginalCwd(), 'tracked.txt')
      const victimPath = join(testRoot!, 'outside-victim.txt')
      await writeFile(trackedPath, 'snapshot content')
      await writeFile(victimPath, 'outside content')

      let state: FileHistoryState = {
        snapshots: [
          {
            messageId: targetMessageId,
            trackedFileBackups: {},
            timestamp: new Date(),
          },
        ],
        trackedFiles: new Set(),
        snapshotSequence: 1,
      }
      const updateState = (
        updater: (previous: FileHistoryState) => FileHistoryState,
      ) => {
        state = updater(state)
      }

      await fileHistoryTrackEdit(updateState, trackedPath, targetMessageId)
      await unlink(trackedPath)
      if (linkType === 'symlink') {
        await symlink(victimPath, trackedPath)
      } else {
        await link(victimPath, trackedPath)
      }

      await fileHistoryRewind(updateState, targetMessageId)

      expect(await readFile(victimPath, 'utf8')).toBe('outside content')
    },
  )

  test('restores a regular file after its parent directory was deleted', async () => {
    const targetMessageId = randomUUID() as UUID
    const trackedPath = join(getOriginalCwd(), 'nested', 'tracked.txt')
    await mkdir(join(getOriginalCwd(), 'nested'))
    await writeFile(trackedPath, 'snapshot content')
    const { updateState } = createHistoryState(targetMessageId)

    await fileHistoryTrackEdit(updateState, trackedPath, targetMessageId)
    await rm(join(getOriginalCwd(), 'nested'), {
      recursive: true,
      force: true,
    })
    await fileHistoryRewind(updateState, targetMessageId)

    expect(await readFile(trackedPath, 'utf8')).toBe('snapshot content')
  })

  test('keeps the new-file marker when the future parent does not exist', async () => {
    const targetMessageId = randomUUID() as UUID
    const trackedPath = join(getOriginalCwd(), 'future', 'tracked.txt')
    const { updateState } = createHistoryState(targetMessageId)

    await fileHistoryTrackEdit(updateState, trackedPath, targetMessageId)
    await mkdir(join(getOriginalCwd(), 'future'))
    await writeFile(trackedPath, 'created later')
    await fileHistoryRewind(updateState, targetMessageId)

    await expect(Bun.file(trackedPath).exists()).resolves.toBe(false)
  })

  test.each(['symlink', 'hardlink'] as const)(
    'refuses to snapshot a tracked file replaced by a %s',
    async linkType => {
      const targetMessageId = randomUUID() as UUID
      const trackedPath = join(getOriginalCwd(), 'tracked.txt')
      const victimPath = join(testRoot!, 'snapshot-victim.txt')
      await writeFile(trackedPath, 'snapshot content')
      await writeFile(victimPath, 'outside content')
      const { getState, updateState } = createHistoryState(targetMessageId)

      await fileHistoryTrackEdit(updateState, trackedPath, targetMessageId)
      const trackingPath = 'tracked.txt'
      const before =
        getState().snapshots.at(-1)!.trackedFileBackups[trackingPath]!
      await unlink(trackedPath)
      if (linkType === 'symlink') {
        await symlink(victimPath, trackedPath)
      } else {
        await link(victimPath, trackedPath)
      }
      await fileHistoryMakeSnapshot(updateState, randomUUID() as UUID)

      expect(await readFile(victimPath, 'utf8')).toBe('outside content')
      expect(
        getState().snapshots.at(-1)!.trackedFileBackups[trackingPath],
      ).toEqual(before)
    },
  )

  test('does not begin tracking an existing hardlink', async () => {
    const targetMessageId = randomUUID() as UUID
    const trackedPath = join(getOriginalCwd(), 'tracked.txt')
    const victimPath = join(testRoot!, 'track-victim.txt')
    await writeFile(victimPath, 'outside content')
    await link(victimPath, trackedPath)
    const { getState, updateState } = createHistoryState(targetMessageId)

    await fileHistoryTrackEdit(updateState, trackedPath, targetMessageId)

    expect(getState().trackedFiles.size).toBe(0)
  })

  test('refuses to restore through a parent directory symlink', async () => {
    const targetMessageId = randomUUID() as UUID
    const nestedDir = join(getOriginalCwd(), 'nested')
    const trackedPath = join(nestedDir, 'tracked.txt')
    const outsideDir = join(testRoot!, 'outside-directory')
    const victimPath = join(outsideDir, 'tracked.txt')
    await mkdir(nestedDir)
    await mkdir(outsideDir)
    await writeFile(trackedPath, 'snapshot content')
    await writeFile(victimPath, 'outside content')
    const { updateState } = createHistoryState(targetMessageId)

    await fileHistoryTrackEdit(updateState, trackedPath, targetMessageId)
    await rm(nestedDir, { recursive: true, force: true })
    await symlink(outsideDir, nestedDir)
    await fileHistoryRewind(updateState, targetMessageId)

    expect(await readFile(victimPath, 'utf8')).toBe('outside content')
  })

  test('refuses to delete through a parent directory symlink', async () => {
    const targetMessageId = randomUUID() as UUID
    const nestedDir = join(getOriginalCwd(), 'nested')
    const trackedPath = join(nestedDir, 'tracked.txt')
    const outsideDir = join(testRoot!, 'outside-delete-directory')
    const victimPath = join(outsideDir, 'tracked.txt')
    const { updateState } = createHistoryState(targetMessageId)

    await fileHistoryTrackEdit(updateState, trackedPath, targetMessageId)
    await mkdir(outsideDir)
    await writeFile(victimPath, 'outside content')
    await symlink(outsideDir, nestedDir)
    await fileHistoryRewind(updateState, targetMessageId)

    expect(await readFile(victimPath, 'utf8')).toBe('outside content')
  })

  test('treats a missing delete parent as already absent', async () => {
    const targetMessageId = randomUUID() as UUID
    const trackedPath = join(getOriginalCwd(), 'missing', 'tracked.txt')
    const { updateState } = createHistoryState(targetMessageId)

    await fileHistoryTrackEdit(updateState, trackedPath, targetMessageId)
    await fileHistoryRewind(updateState, targetMessageId)

    await expect(Bun.file(trackedPath).exists()).resolves.toBe(false)
  })

  test('keeps the original file intact when a restore write fails midway', async () => {
    const targetMessageId = randomUUID() as UUID
    const trackedPath = join(getOriginalCwd(), 'tracked.txt')
    await writeFile(trackedPath, 's'.repeat(3 * 1024 * 1024))
    const { updateState } = createHistoryState(targetMessageId)

    await fileHistoryTrackEdit(updateState, trackedPath, targetMessageId)
    await writeFile(trackedPath, 'modified content')

    const probe = await open(trackedPath, 'r')
    const fileHandlePrototype = Object.getPrototypeOf(probe) as {
      write: (...args: unknown[]) => Promise<unknown>
    }
    await probe.close()
    const originalWrite = fileHandlePrototype.write
    let writes = 0
    fileHandlePrototype.write = async function (...args: unknown[]) {
      writes += 1
      if (writes === 2) {
        throw new Error('injected restore write failure')
      }
      return Reflect.apply(originalWrite, this, args) as Promise<unknown>
    }

    try {
      await fileHistoryRewind(updateState, targetMessageId)
    } finally {
      fileHandlePrototype.write = originalWrite
    }

    expect(await readFile(trackedPath, 'utf8')).toBe('modified content')
  })

  test.each(['missing', 'symlink'] as const)(
    'keeps the current file when its backup is %s',
    async backupState => {
      const targetMessageId = randomUUID() as UUID
      const trackedPath = join(getOriginalCwd(), 'tracked.txt')
      await writeFile(trackedPath, 'snapshot content')
      const { getState, updateState } = createHistoryState(targetMessageId)

      await fileHistoryTrackEdit(updateState, trackedPath, targetMessageId)
      const backupName =
        getState().snapshots.at(-1)!.trackedFileBackups['tracked.txt']!
          .backupFileName
      if (!backupName) throw new Error('expected a file backup')
      const backupPath = join(
        process.env.CLAUDE_CONFIG_DIR!,
        'file-history',
        getSessionId(),
        backupName,
      )
      await unlink(backupPath)
      if (backupState === 'symlink') {
        const outsideBackup = join(testRoot!, 'outside-backup.txt')
        await writeFile(outsideBackup, 'outside backup content')
        await symlink(outsideBackup, backupPath)
      }
      await writeFile(trackedPath, 'modified content')

      await fileHistoryRewind(updateState, targetMessageId)

      expect(await readFile(trackedPath, 'utf8')).toBe('modified content')
    },
  )

  test('preserves explicitly tracked absolute paths outside the project', async () => {
    const targetMessageId = randomUUID() as UUID
    const trackedPath = join(testRoot!, 'explicit-external.txt')
    await writeFile(trackedPath, 'snapshot content')
    const { updateState } = createHistoryState(targetMessageId)

    await fileHistoryTrackEdit(updateState, trackedPath, targetMessageId)
    await writeFile(trackedPath, 'modified content')
    await fileHistoryRewind(updateState, targetMessageId)

    expect(await readFile(trackedPath, 'utf8')).toBe('snapshot content')
  })

  test('keeps a same-prefix sibling path absolute', async () => {
    const targetMessageId = randomUUID() as UUID
    const trackedPath = join(`${getOriginalCwd()}-sibling`, 'tracked.txt')
    await mkdir(join(`${getOriginalCwd()}-sibling`), { recursive: true })
    await writeFile(trackedPath, 'snapshot content')
    const { getState, updateState } = createHistoryState(targetMessageId)

    await fileHistoryTrackEdit(updateState, trackedPath, targetMessageId)

    expect(getState().snapshots[0]?.trackedFileBackups[trackedPath]).toBeDefined()
    expect(getState().snapshots[0]?.trackedFileBackups['../project-sibling/tracked.txt'])
      .toBeUndefined()
  })
})

describe('migrated backup hard links', () => {
  // Session resume migrates backups with link(), so a resumed session's backup
  // shares its inode with the previous session's directory (nlink > 1). The
  // first read must sever the link into a private copy instead of refusing —
  // refusing made every checkpoint/restore on a resumed session see the
  // carried backups as unreadable.
  async function linkBackupIntoPreviousSessionDir(backupName: string) {
    const backupPath = join(
      process.env.CLAUDE_CONFIG_DIR!,
      'file-history',
      getSessionId(),
      backupName,
    )
    const previousDir = join(
      process.env.CLAUDE_CONFIG_DIR!,
      'file-history',
      randomUUID(),
    )
    await mkdir(previousDir, { recursive: true })
    const migratedPath = join(previousDir, backupName)
    await link(backupPath, migratedPath)
    return { backupPath, migratedPath }
  }

  test('reads a migrated (hard-linked) backup and severs the link', async () => {
    const targetMessageId = randomUUID() as UUID
    const trackedPath = join(getOriginalCwd(), 'tracked.txt')
    await writeFile(trackedPath, 'snapshot content')
    const { getState, updateState } = createHistoryState(targetMessageId)
    await fileHistoryTrackEdit(updateState, trackedPath, targetMessageId)
    const backupName =
      getState().snapshots.at(-1)!.trackedFileBackups['tracked.txt']!.backupFileName!
    const { backupPath, migratedPath } = await linkBackupIntoPreviousSessionDir(backupName)
    expect((await lstat(backupPath)).nlink).toBe(2)
    const migratedStats = await lstat(migratedPath)

    const { content } = await readBackupFileSafely(backupName)
    expect(content.toString()).toBe('snapshot content')

    const healed = await lstat(backupPath)
    expect(healed.nlink).toBe(1)
    expect(await readFile(backupPath, 'utf8')).toBe('snapshot content')
    // The previous session's directory keeps the original inode and content.
    expect((await lstat(migratedPath)).ino).toBe(migratedStats.ino)
    expect(await readFile(migratedPath, 'utf8')).toBe('snapshot content')
  })

  test('rewinds through a migrated (hard-linked) backup', async () => {
    const targetMessageId = randomUUID() as UUID
    const trackedPath = join(getOriginalCwd(), 'tracked.txt')
    await writeFile(trackedPath, 'snapshot content')
    const { getState, updateState } = createHistoryState(targetMessageId)
    await fileHistoryTrackEdit(updateState, trackedPath, targetMessageId)
    const backupName =
      getState().snapshots.at(-1)!.trackedFileBackups['tracked.txt']!.backupFileName!
    await linkBackupIntoPreviousSessionDir(backupName)

    await writeFile(trackedPath, 'modified content')
    await fileHistoryRewind(updateState, targetMessageId)

    expect(await readFile(trackedPath, 'utf8')).toBe('snapshot content')
  })

  test('still refuses a symlinked backup', async () => {
    const targetMessageId = randomUUID() as UUID
    const trackedPath = join(getOriginalCwd(), 'tracked.txt')
    await writeFile(trackedPath, 'snapshot content')
    const { getState, updateState } = createHistoryState(targetMessageId)
    await fileHistoryTrackEdit(updateState, trackedPath, targetMessageId)
    const backupName =
      getState().snapshots.at(-1)!.trackedFileBackups['tracked.txt']!.backupFileName!
    const backupPath = join(
      process.env.CLAUDE_CONFIG_DIR!,
      'file-history',
      getSessionId(),
      backupName,
    )
    const outsideBackup = join(testRoot!, 'outside-backup.txt')
    await writeFile(outsideBackup, 'outside backup content')
    await unlink(backupPath)
    await symlink(outsideBackup, backupPath)

    await expect(readBackupFileSafely(backupName)).rejects.toThrow(/unsafe linked/)
  })
})

function createHistoryState(targetMessageId: UUID): {
  getState: () => FileHistoryState
  updateState: (
    updater: (previous: FileHistoryState) => FileHistoryState,
  ) => void
} {
  let state: FileHistoryState = {
    snapshots: [
      {
        messageId: targetMessageId,
        trackedFileBackups: {},
        timestamp: new Date(),
      },
    ],
    trackedFiles: new Set(),
    snapshotSequence: 1,
  }
  return {
    getState() {
      return state
    },
    updateState(updater) {
      state = updater(state)
    },
  }
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name]
  } else {
    process.env[name] = value
  }
}


describe('completed turn checkpoint persistence', () => {
  test('preserves successful frozen copies and leaves failed paths absent without retrying live bytes', async () => {
    const target = randomUUID() as UUID
    const first = join(getOriginalCwd(), 'first.txt')
    const second = join(getOriginalCwd(), 'second.txt')
    await writeFile(first, 'before first')
    await writeFile(second, 'before second')
    const { getState, updateState } = createHistoryState(target)
    await fileHistoryTrackEdit(updateState, first, target)
    await fileHistoryTrackEdit(updateState, second, target)
    await writeFile(first, 'frozen first')
    await unlink(second)
    await symlink(first, second)
    await fileHistoryCompleteSnapshot(updateState, target)
    const completed = getState().snapshots[0]!
    expect(Object.keys(completed.trackedFileBackups)).toHaveLength(2)
    expect(Object.keys(completed.completedFileBackups!)).toEqual(['first.txt'])
    const backup = completed.completedFileBackups!['first.txt']!
    expect((await readBackupFileSafely(backup.backupFileName!)).content.toString()).toBe('frozen first')
    await unlink(second)
    await writeFile(second, 'later live second')
    await writeFile(first, 'later live first')
    await fileHistoryCompleteSnapshot(updateState, target)
    expect(getState().snapshots[0]?.completedFileBackups).toEqual(completed.completedFileBackups)
    expect((await readBackupFileSafely(backup.backupFileName!)).content.toString()).toBe('frozen first')
  })

  test('freezes post-turn bytes once and keeps them across next-turn backups', async () => {
    const target = randomUUID() as UUID
    const trackedPath = join(getOriginalCwd(), 'tracked.txt')
    await writeFile(trackedPath, 'before\r\n')
    const { getState, updateState } = createHistoryState(target)
    await fileHistoryTrackEdit(updateState, trackedPath, target)
    await writeFile(trackedPath, 'first turn without LF')
    await fileHistoryCompleteSnapshot(updateState, target)
    const completed = getState().snapshots.find(snapshot => snapshot.messageId === target)!
    const backup = Object.values(completed.completedFileBackups!)[0]!
    expect(completed.schemaVersion).toBe(2)
    expect((await readBackupFileSafely(backup.backupFileName!)).content.toString()).toBe('first turn without LF')
    await writeFile(trackedPath, 'unrelated later work\n')
    await fileHistoryCompleteSnapshot(updateState, target)
    await fileHistoryMakeSnapshot(updateState, randomUUID() as UUID)
    expect((await readBackupFileSafely(backup.backupFileName!)).content.toString()).toBe('first turn without LF')
    expect(getState().snapshots.find(snapshot => snapshot.messageId === target)?.completedFileBackups).toEqual(completed.completedFileBackups)
  })

  test('migrates old before-only fixtures without fabricating completed bytes and preserves unknown fields', () => {
    const legacy = { messageId: randomUUID() as UUID, trackedFileBackups: {}, timestamp: new Date(), futureField: { preserved: true } }
    const migrated = migrateFileHistorySnapshot(legacy)
    expect(migrated).toMatchObject({ schemaVersion: 2, futureField: { preserved: true } })
    expect(migrated.completedFileBackups).toBeUndefined()
    expect(migrateFileHistorySnapshot(migrated)).toEqual(migrated)
  })

  test('does not mark another turn complete when the requested checkpoint no longer exists', async () => {
    const { getState, updateState } = createHistoryState(randomUUID() as UUID)
    await fileHistoryCompleteSnapshot(updateState, randomUUID() as UUID)
    expect(getState().snapshots[0]?.completedFileBackups).toBeUndefined()
  })
})


for (const termination of ['error', 'cancel'] as const) {
  test(`persists partial turn edits before ${termination} escapes the query`, async () => {
    const messageId = randomUUID() as UUID
    const trackedPath = join(getOriginalCwd(), 'partial.txt')
    await writeFile(trackedPath, 'before')
    const { getState, updateState } = createHistoryState(messageId)
    await fileHistoryTrackEdit(updateState, trackedPath, messageId)
    async function* query() {
      await writeFile(trackedPath, 'partial edit')
      yield 'tool finished'
      throw new Error('query failed')
    }
    const stream = withFileHistoryCompletion(query(), () => fileHistoryCompleteSnapshot(updateState, messageId))
    expect((await stream.next()).value).toBe('tool finished')
    if (termination === 'error') await expect(stream.next()).rejects.toThrow('query failed')
    else await stream.return(undefined)
    await writeFile(trackedPath, 'later unrelated edits')
    const completed = getState().snapshots.find(snapshot => snapshot.messageId === messageId)!
    const backup = Object.values(completed.completedFileBackups!)[0]!
    expect((await readBackupFileSafely(backup.backupFileName!)).content.toString()).toBe('partial edit')
  })
}
