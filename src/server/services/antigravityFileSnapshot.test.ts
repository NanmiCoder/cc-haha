import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { link, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment } from '../../../scripts/pr/test-environment.js'
import { ANTIGRAVITY_PROVIDER_ID } from './antigravityAcp.js'
import { AntigravityTurnFileTracker, parseGitPorcelainZ } from './antigravityFileSnapshot.js'

const originalEnvironment = { ...process.env }
let sandbox: string
let configDir: string
let listSessionTurnCheckpoints: typeof import('./sessionRewindService.js').listSessionTurnCheckpoints
let getSessionTurnCheckpointDiff: typeof import('./sessionRewindService.js').getSessionTurnCheckpointDiff

async function git(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(['git', ...args], {
    cwd,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test Author',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test Author',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  })
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text()
    throw new Error(`git ${args.join(' ')} failed (${exitCode}): ${stderr}`)
  }
}

async function writeAntigravityTranscript(
  sessionId: string,
  workDir: string,
  rows: Record<string, unknown>[],
): Promise<void> {
  const projectDir = join(configDir, 'projects', `-agy-snapshot-${sessionId.slice(0, 8)}`)
  await mkdir(projectDir, { recursive: true })
  const header = {
    type: 'session-meta',
    isMeta: true,
    workDir,
    runtimeProviderId: ANTIGRAVITY_PROVIDER_ID,
    nativeSessionId: `native-${sessionId}`,
    timestamp: '2026-11-28T00:00:00.000Z',
  }
  const lines = [header, ...rows].map(row => JSON.stringify({ sessionId, cwd: workDir, ...row })).join('\n') + '\n'
  await writeFile(join(projectDir, `${sessionId}.jsonl`), lines, 'utf8')
}

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'agy-file-snapshot-'))
  const environment = createSandboxedTestEnvironment(sandbox, {
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    DISABLE_AUTOUPDATER: '1',
  })
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, environment)
  configDir = environment.CLAUDE_CONFIG_DIR!
  const rewindMod = await import('./sessionRewindService.js')
  listSessionTurnCheckpoints = rewindMod.listSessionTurnCheckpoints
  getSessionTurnCheckpointDiff = rewindMod.getSessionTurnCheckpointDiff
})

afterAll(async () => {
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, originalEnvironment)
  await rm(sandbox, { recursive: true, force: true })
})

describe('AntigravityTurnFileTracker', () => {
  test('parses git status --porcelain=v1 -z preserving XY status codes including renames and untracked paths', () => {
    const raw = Buffer.from(' M src/a.ts\0R  src/new.ts\0src/old.ts\0?? src/created.ts\0', 'utf8')
    const parsed = parseGitPorcelainZ(raw)
    expect(parsed).toEqual(new Map([
      ['src/a.ts', ' M'],
      ['src/new.ts', 'R '],
      ['src/old.ts', 'R '],
      ['src/created.ts', '??'],
    ]))
  })

  test('captures exact per-turn diffs across 3 turns in a Git workspace (modify, create, delete, pre-dirty, shell, commit, no-op)', async () => {
    const sessionId = crypto.randomUUID()
    const repoDir = join(sandbox, `repo-${sessionId}`)
    await mkdir(join(repoDir, 'src'), { recursive: true })
    await git(repoDir, ['init', '-b', 'main'])
    await writeFile(join(repoDir, 'src/a.ts'), 'line 1\nline 2\nline 3\n', 'utf8')
    await writeFile(join(repoDir, 'src/dirty.txt'), 'committed dirty\n', 'utf8')
    await git(repoDir, ['add', '.'])
    await git(repoDir, ['commit', '-m', 'initial'])

    // Pre-existing dirty file before session starts: must NOT show up in Turn 1 if untouched.
    await writeFile(join(repoDir, 'src/dirty.txt'), 'pre-turn dirty\n', 'utf8')

    const tracker = new AntigravityTurnFileTracker(sessionId, repoDir)
    const rows: Record<string, unknown>[] = []

    // Turn 1: modify src/a.ts (2 edits in one turn -> net +1 -1) + create src/b.ts
    const u1 = crypto.randomUUID()
    await tracker.beginTurn(u1)
    await writeFile(join(repoDir, 'src/a.ts'), 'line 1\nline 2 temp\nline 3\n', 'utf8')
    await writeFile(join(repoDir, 'src/a.ts'), 'line 1\nline 2 updated\nline 3\n', 'utf8')
    await writeFile(join(repoDir, 'src/b.ts'), 'export const b = 1\nexport const b2 = 2\n', 'utf8')
    tracker.recordCompletedToolPath(join(repoDir, 'src/a.ts'))
    tracker.recordCompletedToolPath(join(repoDir, 'src/b.ts'))
    const snap1 = await tracker.completeTurn()
    expect(snap1).not.toBeNull()
    expect(snap1!.filesChanged).toBe(2)
    expect(snap1!.insertions).toBe(3) // 1 in a.ts + 2 in b.ts
    expect(snap1!.deletions).toBe(1) // 1 in a.ts
    rows.push(
      { type: 'user', uuid: u1, timestamp: '2026-11-28T00:01:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'Turn 1' }] } },
      { type: 'assistant', uuid: crypto.randomUUID(), timestamp: '2026-11-28T00:01:10.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Done 1' }] } },
      snap1!.snapshotEntry,
    )

    // Turn 2: modify pre-dirty src/dirty.txt, delete src/b.ts, modify src/a.ts again
    const u2 = crypto.randomUUID()
    await tracker.beginTurn(u2)
    await writeFile(join(repoDir, 'src/dirty.txt'), 'pre-turn dirty\nturn 2 line\n', 'utf8')
    await unlink(join(repoDir, 'src/b.ts'))
    await writeFile(join(repoDir, 'src/a.ts'), 'line 1\nline 2 updated\nline 3\nline 4\n', 'utf8')
    const snap2 = await tracker.completeTurn()
    expect(snap2).not.toBeNull()
    expect(snap2!.filesChanged).toBe(3)
    expect(snap2!.insertions).toBe(2) // +1 in dirty.txt, +1 in a.ts
    expect(snap2!.deletions).toBe(2) // -2 in b.ts
    rows.push(
      { type: 'user', uuid: u2, timestamp: '2026-11-28T00:02:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'Turn 2' }] } },
      { type: 'assistant', uuid: crypto.randomUUID(), timestamp: '2026-11-28T00:02:10.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Done 2' }] } },
      snap2!.snapshotEntry,
    )

    // Turn 3: edit src/a.ts then revert to Turn 2 state (no-op!), create src/c.ts, AND git commit mid-turn
    const u3 = crypto.randomUUID()
    await tracker.beginTurn(u3)
    await writeFile(join(repoDir, 'src/a.ts'), 'temporary change\n', 'utf8')
    await writeFile(join(repoDir, 'src/a.ts'), 'line 1\nline 2 updated\nline 3\nline 4\n', 'utf8')
    await writeFile(join(repoDir, 'src/c.ts'), 'export const c = true\n', 'utf8')
    await git(repoDir, ['add', 'src/c.ts'])
    await git(repoDir, ['commit', '-m', 'add c.ts'])
    const snap3 = await tracker.completeTurn()
    expect(snap3).not.toBeNull()
    expect(snap3!.filesChanged).toBe(1)
    expect(snap3!.insertions).toBe(1)
    expect(snap3!.deletions).toBe(0)
    rows.push(
      { type: 'user', uuid: u3, timestamp: '2026-11-28T00:03:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'Turn 3' }] } },
      { type: 'assistant', uuid: crypto.randomUUID(), timestamp: '2026-11-28T00:03:10.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Done 3' }] } },
      snap3!.snapshotEntry,
    )

    // Turn 4: pure Q&A turn with no file changes
    const u4 = crypto.randomUUID()
    await tracker.beginTurn(u4)
    const snap4 = await tracker.completeTurn()
    expect(snap4).toBeNull()
    rows.push(
      { type: 'user', uuid: u4, timestamp: '2026-11-28T00:04:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'Turn 4' }] } },
      { type: 'assistant', uuid: crypto.randomUUID(), timestamp: '2026-11-28T00:04:10.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Done 4' }] } },
    )

    await writeAntigravityTranscript(sessionId, repoDir, rows)

    // Live turn checkpoints (used by MessageList) and frozen checkpoints (used by WorkspaceReviewTab) must agree!
    for (const frozen of [false, true]) {
      const checkpoints = await listSessionTurnCheckpoints(sessionId, undefined, frozen)
      expect(checkpoints).toHaveLength(4)

      // All Antigravity turns report restoreAvailable: false (read-only change cards)
      expect(checkpoints.map(cp => cp.restoreAvailable)).toEqual([false, false, false, false])

      // Turn 1: src/a.ts + src/b.ts (src/dirty.txt excluded!)
      expect(checkpoints[0]!.code.available).toBe(true)
      expect(checkpoints[0]!.code.filesChanged.sort()).toEqual([
        join(repoDir, 'src/a.ts'),
        join(repoDir, 'src/b.ts'),
      ].sort())
      expect(checkpoints[0]!.code.insertions).toBe(3)
      expect(checkpoints[0]!.code.deletions).toBe(1)

      // Turn 2: src/a.ts + src/b.ts (deleted) + src/dirty.txt
      expect(checkpoints[1]!.code.available).toBe(true)
      expect(checkpoints[1]!.code.filesChanged.sort()).toEqual([
        join(repoDir, 'src/a.ts'),
        join(repoDir, 'src/b.ts'),
        join(repoDir, 'src/dirty.txt'),
      ].sort())
      expect(checkpoints[1]!.code.insertions).toBe(2)
      expect(checkpoints[1]!.code.deletions).toBe(2)

      // Turn 3: ONLY src/c.ts (no-op edit to src/a.ts excluded!)
      expect(checkpoints[2]!.code.available).toBe(true)
      expect(checkpoints[2]!.code.filesChanged).toEqual([join(repoDir, 'src/c.ts')])
      expect(checkpoints[2]!.code.insertions).toBe(1)
      expect(checkpoints[2]!.code.deletions).toBe(0)

      // Turn 4: no file changes
      expect(checkpoints[3]!.code.available).toBe(false)
      expect(checkpoints[3]!.code.filesChanged).toEqual([])
    }

    // Per-turn frozen diffs remain independently accurate for every turn!
    const diff1A = await getSessionTurnCheckpointDiff(sessionId, { targetUserMessageId: u1 }, 'src/a.ts', true)
    expect(diff1A.state).toBe('ok')
    expect(diff1A.diff).toContain('-line 2')
    expect(diff1A.diff).toContain('+line 2 updated')
    expect(diff1A.diff).not.toContain('line 4')

    const diff2Dirty = await getSessionTurnCheckpointDiff(sessionId, { targetUserMessageId: u2 }, 'src/dirty.txt', true)
    expect(diff2Dirty.state).toBe('ok')
    expect(diff2Dirty.diff).toContain(' pre-turn dirty')
    expect(diff2Dirty.diff).toContain('+turn 2 line')
    expect(diff2Dirty.diff).not.toContain('committed dirty')

    const diff2DeletedB = await getSessionTurnCheckpointDiff(sessionId, { targetUserMessageId: u2 }, 'src/b.ts', true)
    expect(diff2DeletedB.state).toBe('ok')
    expect(diff2DeletedB.diff).toContain('+++ /dev/null')
    expect(diff2DeletedB.diff).toContain('-export const b = 1')

    const diff3C = await getSessionTurnCheckpointDiff(sessionId, { targetUserMessageId: u3 }, 'src/c.ts', true)
    expect(diff3C.state).toBe('ok')
    expect(diff3C.diff).toContain('--- /dev/null')
    expect(diff3C.diff).toContain('+export const c = true')
  })

  test('captures non-Git pending-permission file edits and ignores unsafe symlinks/hardlinks', async () => {
    const sessionId = crypto.randomUUID()
    const nonGitDir = join(sandbox, `nongit-${sessionId}`)
    await mkdir(nonGitDir, { recursive: true })
    const notePath = join(nonGitDir, 'notes.md')
    const targetPath = join(nonGitDir, 'target.txt')
    const symlinkPath = join(nonGitDir, 'link.txt')
    const hardlinkPath = join(nonGitDir, 'hard.txt')
    await writeFile(notePath, 'hello\nworld\n', 'utf8')
    await writeFile(targetPath, 'orig\n', 'utf8')
    await symlink(targetPath, symlinkPath)
    await link(targetPath, hardlinkPath)

    const tracker = new AntigravityTurnFileTracker(sessionId, nonGitDir)
    const u1 = crypto.randomUUID()
    await tracker.beginTurn(u1)
    tracker.recordPendingToolPath(notePath)
    tracker.recordPendingToolPath(symlinkPath)
    tracker.recordPendingToolPath(hardlinkPath)

    // Simulate edits after permission approval
    await writeFile(notePath, 'hello\nantigravity\n', 'utf8')
    await writeFile(targetPath, 'mutated\n', 'utf8')

    const snap = await tracker.completeTurn()
    expect(snap).not.toBeNull()
    expect(snap!.filesChanged).toBe(1)
    expect(snap!.insertions).toBe(1)
    expect(snap!.deletions).toBe(1)

    await writeAntigravityTranscript(sessionId, nonGitDir, [
      { type: 'user', uuid: u1, timestamp: '2026-11-28T00:05:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'Update notes' }] } },
      { type: 'assistant', uuid: crypto.randomUUID(), timestamp: '2026-11-28T00:05:10.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Updated' }] } },
      snap!.snapshotEntry,
    ])

    const checkpoints = await listSessionTurnCheckpoints(sessionId)
    expect(checkpoints).toHaveLength(1)
    expect(checkpoints[0]!.restoreAvailable).toBe(false)
    expect(checkpoints[0]!.code).toMatchObject({
      available: true,
      filesChanged: [notePath],
      insertions: 1,
      deletions: 1,
    })

    const diff = await getSessionTurnCheckpointDiff(sessionId, { targetUserMessageId: u1 }, 'notes.md', true)
    expect(diff.state).toBe('ok')
    expect(diff.diff).toContain('-world')
    expect(diff.diff).toContain('+antigravity')
  })

  test('falls back to recorded Edit/Write transcript changes for Antigravity turns without snapshots', async () => {
    const sessionId = crypto.randomUUID()
    const nonGitDir = join(sandbox, `legacy-${sessionId}`)
    await mkdir(nonGitDir, { recursive: true })
    const filePath = join(nonGitDir, 'legacy.ts')
    const u1 = crypto.randomUUID()
    const toolId = 'call_legacy_edit_1'

    await writeAntigravityTranscript(sessionId, nonGitDir, [
      { type: 'user', uuid: u1, timestamp: '2026-11-28T00:06:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'Edit legacy' }] } },
      {
        type: 'assistant',
        uuid: crypto.randomUUID(),
        timestamp: '2026-11-28T00:06:05.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: toolId, name: 'Edit', input: { file_path: filePath, old_string: 'oldVal', new_string: 'newVal' } }],
        },
      },
      {
        type: 'user',
        uuid: crypto.randomUUID(),
        timestamp: '2026-11-28T00:06:06.000Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: toolId, content: filePath, is_error: false }],
        },
      },
      { type: 'assistant', uuid: crypto.randomUUID(), timestamp: '2026-11-28T00:06:10.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Done' }] } },
    ])

    const checkpoints = await listSessionTurnCheckpoints(sessionId)
    expect(checkpoints).toHaveLength(1)
    expect(checkpoints[0]!.restoreAvailable).toBe(false)
    expect(checkpoints[0]!.code).toMatchObject({
      available: true,
      filesChanged: [filePath],
      insertions: 1,
      deletions: 1,
    })

    const diff = await getSessionTurnCheckpointDiff(sessionId, { targetUserMessageId: u1 }, 'legacy.ts', true)
    expect(diff.state).toBe('ok')
    expect(diff.diff).toContain('-oldVal')
    expect(diff.diff).toContain('+newVal')
  })

  test('keeps frozen Workspace Review available for text files when a turn also writes binary files (review P1 #1)', async () => {
    const sessionId = crypto.randomUUID()
    const repoDir = join(sandbox, `repo-binary-${sessionId}`)
    await mkdir(join(repoDir, 'src'), { recursive: true })
    await mkdir(join(repoDir, 'assets'), { recursive: true })
    await git(repoDir, ['init', '-b', 'main'])
    await writeFile(join(repoDir, 'src/app.ts'), 'export const ok = false\n', 'utf8')
    await git(repoDir, ['add', '.'])
    await git(repoDir, ['commit', '-m', 'init'])

    const tracker = new AntigravityTurnFileTracker(sessionId, repoDir)
    const u1 = crypto.randomUUID()
    await tracker.beginTurn(u1)
    await writeFile(join(repoDir, 'src/app.ts'), 'export const ok = true\n', 'utf8')
    // Binary PNG header + NUL + invalid UTF-8 bytes
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe])
    await writeFile(join(repoDir, 'assets/shot.png'), pngBytes)
    const snap = await tracker.completeTurn()
    expect(snap).not.toBeNull()
    expect(snap!.filesChanged).toBe(1)

    await writeAntigravityTranscript(sessionId, repoDir, [
      { type: 'user', uuid: u1, timestamp: '2026-11-28T00:10:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'Update app and capture screenshot' }] } },
      {
        type: 'assistant',
        uuid: crypto.randomUUID(),
        timestamp: '2026-11-28T00:10:05.000Z',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'call_bash_bin', name: 'Bash', input: { command: 'capture-shot' } }] },
      },
      {
        type: 'user',
        uuid: crypto.randomUUID(),
        timestamp: '2026-11-28T00:10:06.000Z',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_bash_bin', content: 'saved', is_error: false }] },
      },
      { type: 'assistant', uuid: crypto.randomUUID(), timestamp: '2026-11-28T00:10:10.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Done' }] } },
      snap!.snapshotEntry,
    ])

    for (const frozen of [false, true]) {
      const checkpoints = await listSessionTurnCheckpoints(sessionId, undefined, frozen)
      expect(checkpoints).toHaveLength(1)
      expect(checkpoints[0]!.code.available).toBe(true)
      expect(checkpoints[0]!.code.filesChanged).toEqual([join(repoDir, 'src/app.ts')])
    }

    const appDiff = await getSessionTurnCheckpointDiff(sessionId, { targetUserMessageId: u1 }, 'src/app.ts', true)
    expect(appDiff.state).toBe('ok')
    expect(appDiff.diff).toContain('-export const ok = false')
    expect(appDiff.diff).toContain('+export const ok = true')
  })

  test('refuses leaf symlinks created mid-turn and parent-directory symlinks on pendingToolBefore (review P1 #2)', async () => {
    const sessionId = crypto.randomUUID()
    const nonGitDir = join(sandbox, `nongit-sym-${sessionId}`)
    const outsideDir = join(sandbox, `outside-${sessionId}`)
    await mkdir(nonGitDir, { recursive: true })
    await mkdir(outsideDir, { recursive: true })

    const secretFile = join(outsideDir, 'secret.txt')
    await writeFile(secretFile, 'TOP_SECRET_TOKEN=12345\n', 'utf8')
    await symlink(outsideDir, join(nonGitDir, 'linked-dir'))

    const leafPath = join(nonGitDir, 'becomes-link.txt')
    const parentLinkedPath = join(nonGitDir, 'linked-dir', 'secret.txt')

    const tracker = new AntigravityTurnFileTracker(sessionId, nonGitDir)
    const u1 = crypto.randomUUID()
    await tracker.beginTurn(u1)

    // Leaf doesn't exist before turn -> beforeBytes = null; parentLinked traverses symlink -> rejected immediately
    tracker.recordPendingToolPath(leafPath)
    tracker.recordPendingToolPath(parentLinkedPath)

    // Mid-turn: leafPath becomes a symlink to outside secret, and secret is edited through parent symlink
    await symlink(secretFile, leafPath)
    await writeFile(secretFile, 'TOP_SECRET_TOKEN=67890\n', 'utf8')

    const snap = await tracker.completeTurn()
    expect(snap).toBeNull()
  })

  test('respects core.autocrlf=true via git cat-file --filters and skips HEAD symlinks and >4MB blobs (review P1 #3)', async () => {
    const sessionId = crypto.randomUUID()
    const repoDir = join(sandbox, `repo-git-edge-${sessionId}`)
    await mkdir(repoDir, { recursive: true })
    await git(repoDir, ['init', '-b', 'main'])
    await git(repoDir, ['config', 'core.autocrlf', 'true'])

    // Multi-line file checked in with LF, checked out with CRLF on disk
    await writeFile(join(repoDir, 'crlf.txt'), 'line1\r\nline2\r\nline3\r\nline4\r\n', 'utf8')
    await writeFile(join(repoDir, 'real-target.txt'), 'target\n', 'utf8')
    await symlink('real-target.txt', join(repoDir, 'head-symlink'))
    // > 4 MiB tracked file to verify MAX_SNAPSHOT_FILE_BYTES is enforced on HEAD blobs too
    await writeFile(join(repoDir, 'oversized.bin'), Buffer.alloc(4 * 1024 * 1024 + 64, 0x41))
    await git(repoDir, ['add', '.'])
    await git(repoDir, ['commit', '-m', 'init'])

    const tracker = new AntigravityTurnFileTracker(sessionId, repoDir)
    const u1 = crypto.randomUUID()
    await tracker.beginTurn(u1)

    // Edit only 1 line of CRLF file -> must be +1 -1, NOT +4 -4
    await writeFile(join(repoDir, 'crlf.txt'), 'line1\r\nline2-edited\r\nline3\r\nline4\r\n', 'utf8')
    // Replace HEAD symlink with a regular file -> must be skipped safely
    await unlink(join(repoDir, 'head-symlink'))
    await writeFile(join(repoDir, 'head-symlink'), 'regular now\n', 'utf8')
    // Delete >4 MiB file -> must be skipped safely (not misreported as created or bypassing size cap)
    await unlink(join(repoDir, 'oversized.bin'))

    const snap = await tracker.completeTurn()
    expect(snap).not.toBeNull()
    expect(snap!.filesChanged).toBe(1)
    expect(snap!.insertions).toBe(1)
    expect(snap!.deletions).toBe(1)

    const snapshot = (snap!.snapshotEntry as { snapshot: { trackedFileBackups: Record<string, unknown> } }).snapshot
    expect(Object.keys(snapshot.trackedFileBackups)).toEqual(['crlf.txt'])
  })

  test('serializes rapid consecutive steer transitions in FIFO order without overwriting active turn (review P1 #4)', async () => {
    const sessionId = crypto.randomUUID()
    const repoDir = join(sandbox, `repo-steer-${sessionId}`)
    await mkdir(repoDir, { recursive: true })
    await git(repoDir, ['init', '-b', 'main'])
    await writeFile(join(repoDir, 'a.ts'), 'v0\n', 'utf8')
    await git(repoDir, ['add', '.'])
    await git(repoDir, ['commit', '-m', 'init'])

    const tracker = new AntigravityTurnFileTracker(sessionId, repoDir)
    const u1 = crypto.randomUUID()
    const u2 = crypto.randomUUID()
    const u3 = crypto.randomUUID()
    const persistedSnapshots: Array<{ messageId: string; filesChanged: number }> = []

    await tracker.beginTurn(u1)
    await writeFile(join(repoDir, 'a.ts'), 'v1\n', 'utf8')

    // Fire two steer transitions back-to-back without awaiting the first
    const t2 = tracker.transitionTurn(u2, async (snap) => {
      persistedSnapshots.push({
        messageId: String((snap.snapshotEntry as { messageId: string }).messageId),
        filesChanged: snap.filesChanged,
      })
    })
    const t3 = tracker.transitionTurn(u3, async (snap) => {
      persistedSnapshots.push({
        messageId: String((snap.snapshotEntry as { messageId: string }).messageId),
        filesChanged: snap.filesChanged,
      })
    })
    await Promise.all([t2, t3])

    // Now edit during u3 and finish -> must be attributed to u3, NEVER overwritten by u2
    await writeFile(join(repoDir, 'a.ts'), 'v3\n', 'utf8')
    const finalSnap = await tracker.completeTurn()
    expect(finalSnap).not.toBeNull()
    expect((finalSnap!.snapshotEntry as { messageId: string }).messageId).toBe(u3)
    expect(persistedSnapshots).toEqual([{ messageId: u1, filesChanged: 1 }])
  })

  test('suppresses transcript fallback for structured edits that revert to a net no-op within a turn (review P2 #5)', async () => {
    const sessionId = crypto.randomUUID()
    const repoDir = join(sandbox, `repo-noop-${sessionId}`)
    await mkdir(join(repoDir, 'src'), { recursive: true })
    await git(repoDir, ['init', '-b', 'main'])
    const aPath = join(repoDir, 'src/a.ts')
    const bPath = join(repoDir, 'src/b.ts')
    await writeFile(aPath, 'const a = 1\n', 'utf8')
    await writeFile(bPath, 'const b = 1\n', 'utf8')
    await git(repoDir, ['add', '.'])
    await git(repoDir, ['commit', '-m', 'init'])

    const tracker = new AntigravityTurnFileTracker(sessionId, repoDir)

    // Turn 1: edit src/a.ts then revert it (net no-op), recorded as two Edit calls in transcript
    const u1 = crypto.randomUUID()
    await tracker.beginTurn(u1)
    await writeFile(aPath, 'const a = 2\n', 'utf8')
    tracker.recordCompletedToolPath(aPath)
    await writeFile(aPath, 'const a = 1\n', 'utf8')
    tracker.recordCompletedToolPath(aPath)
    const snap1 = await tracker.completeTurn()
    expect(snap1).not.toBeNull()
    expect(snap1!.filesChanged).toBe(0)

    // Turn 2: edit+revert src/a.ts AND genuinely modify src/b.ts
    const u2 = crypto.randomUUID()
    await tracker.beginTurn(u2)
    await writeFile(aPath, 'const a = 99\n', 'utf8')
    tracker.recordCompletedToolPath(aPath)
    await writeFile(aPath, 'const a = 1\n', 'utf8')
    tracker.recordCompletedToolPath(aPath)
    await writeFile(bPath, 'const b = 2\n', 'utf8')
    tracker.recordCompletedToolPath(bPath)
    const snap2 = await tracker.completeTurn()
    expect(snap2).not.toBeNull()
    expect(snap2!.filesChanged).toBe(1)

    await writeAntigravityTranscript(sessionId, repoDir, [
      { type: 'user', uuid: u1, timestamp: '2026-11-28T00:20:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'Try and revert a.ts' }] } },
      { type: 'assistant', uuid: crypto.randomUUID(), timestamp: '2026-11-28T00:20:01.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: aPath, old_string: 'const a = 1', new_string: 'const a = 2' } }] } },
      { type: 'user', uuid: crypto.randomUUID(), timestamp: '2026-11-28T00:20:02.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'e1', content: aPath, is_error: false }] } },
      { type: 'assistant', uuid: crypto.randomUUID(), timestamp: '2026-11-28T00:20:03.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'e2', name: 'Edit', input: { file_path: aPath, old_string: 'const a = 2', new_string: 'const a = 1' } }] } },
      { type: 'user', uuid: crypto.randomUUID(), timestamp: '2026-11-28T00:20:04.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'e2', content: aPath, is_error: false }] } },
      { type: 'assistant', uuid: crypto.randomUUID(), timestamp: '2026-11-28T00:20:05.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Reverted a.ts' }] } },
      snap1!.snapshotEntry,
      { type: 'user', uuid: u2, timestamp: '2026-11-28T00:21:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'Revert a.ts and edit b.ts' }] } },
      { type: 'assistant', uuid: crypto.randomUUID(), timestamp: '2026-11-28T00:21:01.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'e3', name: 'Edit', input: { file_path: aPath, old_string: 'const a = 1', new_string: 'const a = 99' } }] } },
      { type: 'user', uuid: crypto.randomUUID(), timestamp: '2026-11-28T00:21:02.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'e3', content: aPath, is_error: false }] } },
      { type: 'assistant', uuid: crypto.randomUUID(), timestamp: '2026-11-28T00:21:03.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'e4', name: 'Edit', input: { file_path: aPath, old_string: 'const a = 99', new_string: 'const a = 1' } }] } },
      { type: 'user', uuid: crypto.randomUUID(), timestamp: '2026-11-28T00:21:04.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'e4', content: aPath, is_error: false }] } },
      { type: 'assistant', uuid: crypto.randomUUID(), timestamp: '2026-11-28T00:21:05.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'e5', name: 'Edit', input: { file_path: bPath, old_string: 'const b = 1', new_string: 'const b = 2' } }] } },
      { type: 'user', uuid: crypto.randomUUID(), timestamp: '2026-11-28T00:21:06.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'e5', content: bPath, is_error: false }] } },
      { type: 'assistant', uuid: crypto.randomUUID(), timestamp: '2026-11-28T00:21:07.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Updated b.ts only' }] } },
      snap2!.snapshotEntry,
    ])

    for (const frozen of [false, true]) {
      const checkpoints = await listSessionTurnCheckpoints(sessionId, undefined, frozen)
      expect(checkpoints).toHaveLength(2)
      // Turn 1: available=true with 0 changed files -> MessageList hides the card cleanly
      expect(checkpoints[0]!.code).toMatchObject({ available: true, filesChanged: [], insertions: 0, deletions: 0 })
      // Turn 2: ONLY b.ts appears; a.ts does NOT leak back from transcript Edit
      expect(checkpoints[1]!.code).toMatchObject({ available: true, filesChanged: [bPath], insertions: 1, deletions: 1 })
    }
  })

  test('scopes git status to workDir subdirectory in monorepos despite >500 untracked files in sibling packages (review P2 #6)', async () => {
    const sessionId = crypto.randomUUID()
    const repoDir = join(sandbox, `monorepo-${sessionId}`)
    const appDir = join(repoDir, 'packages', 'app')
    const noisySibling = join(repoDir, 'packages', 'noisy')
    await mkdir(appDir, { recursive: true })
    await mkdir(noisySibling, { recursive: true })
    await git(repoDir, ['init', '-b', 'main'])
    await writeFile(join(appDir, 'index.ts'), 'export const x = 1\n', 'utf8')
    await git(repoDir, ['add', '.'])
    await git(repoDir, ['commit', '-m', 'init'])

    // Create 520 untracked files in sibling package (exceeds MAX_DIRTY_BASELINE_FILES=500 if unscoped!)
    await Promise.all(
      Array.from({ length: 520 }, (_, i) => writeFile(join(noisySibling, `u${i}.txt`), `n${i}\n`, 'utf8')),
    )

    const tracker = new AntigravityTurnFileTracker(sessionId, appDir)
    const u1 = crypto.randomUUID()
    await tracker.beginTurn(u1)
    await writeFile(join(appDir, 'index.ts'), 'export const x = 2\n', 'utf8')
    const snap = await tracker.completeTurn()
    expect(snap).not.toBeNull()
    expect(snap!.filesChanged).toBe(1)
    expect(snap!.insertions).toBe(1)
    expect(snap!.deletions).toBe(1)
  })
})
