import { describe, expect, test } from 'bun:test'
import {
  breadcrumbs,
  changesCardLabel,
  checkpointPrompt,
  checkpointSignature,
  checkpointsNewestFirst,
  defaultRewindMode,
  diffBadge,
  diffTotals,
  formatBytes,
  isImagePath,
  latestCheckpoint,
  parentDir,
  previewFallback,
  projectName,
  rewindChoices,
  rewindRisks,
  splitPath,
  stepPath,
  translateReason,
  turnNumber,
  turnTimeLabel,
  visibleDiffLines,
  workspaceBadge,
  workspaceDiffProblem,
  workspaceStatusLabel,
} from './changesView'
import { parseDiff, type Checkpoint } from './operations'
import type { HistoryEntry } from './types'

const checkpoint = (
  index: number,
  overrides: Partial<Checkpoint> & { files?: string[] } = {}
): Checkpoint => ({
  target: {
    targetUserMessageId: `user-${index}`,
    userMessageIndex: index,
    userMessageCount: 3,
  },
  conversation: { messagesRemoved: 6 },
  code: {
    available: true,
    filesChanged: overrides.files ?? ['src/a.ts', 'src/b.ts', 'c.ts'],
    insertions: 46,
    deletions: 12,
  },
  restoreAvailable: true,
  unverifiedChangeSources: [],
  ...overrides,
})

describe('turn selection', () => {
  test('latest is the highest user message index regardless of order', () => {
    const list = [checkpoint(1), checkpoint(2), checkpoint(0)]
    expect(latestCheckpoint(list)?.target.targetUserMessageId).toBe('user-2')
    expect(latestCheckpoint([])).toBeUndefined()
    expect(checkpointsNewestFirst(list).map(turnNumber)).toEqual([3, 2, 1])
    expect(list.map(turnNumber)).toEqual([2, 3, 1])
  })

  test('signature changes when the checkpoint content changes', () => {
    const base = checkpoint(1)
    const edited = checkpoint(1, {
      code: { ...base.code, insertions: 47 },
    })
    expect(checkpointSignature(base)).toBe(checkpointSignature(checkpoint(1)))
    expect(checkpointSignature(edited)).not.toBe(checkpointSignature(base))
  })

  test('time label shows HH:mm today, date otherwise, and marks the latest turn', () => {
    const now = new Date(2026, 9, 25, 15, 0)
    expect(turnTimeLabel(new Date(2026, 9, 25, 14, 6).getTime(), true, now)).toBe('14:06 · Latest')
    expect(turnTimeLabel(new Date(2026, 9, 24, 9, 30).getTime(), false, now)).toBe('10/24 09:30')
    expect(turnTimeLabel(undefined, true, now)).toBe('Latest')
    expect(turnTimeLabel(undefined, false, now)).toBe('')
  })

  test('prompt quote comes only from the exact target user record, flattened to one line', () => {
    const entries: HistoryEntry[] = [
      { id: 'user-1', type: 'user', content: 'After reconnecting\nthe same reply shows up twice', timestamp: '' },
      { id: 'a-1', type: 'assistant', content: [{ type: 'text', text: 'OK' }], timestamp: '' },
      {
        id: 'user-2',
        type: 'user',
        content: [{ type: 'text', text: '  Second turn  ' }],
        timestamp: '',
      },
    ]
    expect(checkpointPrompt(entries, 'user-1')).toBe('After reconnecting the same reply shows up twice')
    expect(checkpointPrompt(entries, 'user-2')).toBe('Second turn')
    expect(checkpointPrompt(entries, 'a-1')).toBeUndefined()
    expect(checkpointPrompt(entries, 'missing')).toBeUndefined()
  })
})

describe('paths and sizes', () => {
  test('split keeps a trailing slash on the directory', () => {
    expect(splitPath('src/core/sessionTransport.ts')).toEqual({
      name: 'sessionTransport.ts',
      dir: 'src/core/',
    })
    expect(splitPath('README.md')).toEqual({ name: 'README.md', dir: '' })
    expect(splitPath('C:\\repo\\a.ts')).toEqual({ name: 'a.ts', dir: 'C:/repo/' })
    expect(parentDir('mobile/src/core/connection.ts')).toBe('mobile/src/core')
    expect(parentDir('a.ts')).toBe('')
  })

  test('breadcrumbs make every level addressable', () => {
    expect(breadcrumbs('cc-haha', 'mobile/src/core')).toEqual([
      { label: 'cc-haha', path: '' },
      { label: 'mobile', path: 'mobile' },
      { label: 'src', path: 'mobile/src' },
      { label: 'core', path: 'mobile/src/core' },
    ])
    expect(breadcrumbs('root', '')).toEqual([{ label: 'root', path: '' }])
  })

  test('bytes format like the design (KB without decimals)', () => {
    expect(formatBytes(820)).toBe('820 B')
    expect(formatBytes(1024)).toBe('1 KB')
    expect(formatBytes(7 * 1024 + 300)).toBe('7 KB')
    expect(formatBytes(212 * 1024)).toBe('212 KB')
    expect(formatBytes(1.25 * 1024 * 1024)).toBe('1.3 MB')
    expect(formatBytes(2 * 1024 * 1024)).toBe('2 MB')
    expect(formatBytes(undefined)).toBe('')
  })

  test('image detection and project name', () => {
    expect(isImagePath('docs/pairing-flow.PNG')).toBe(true)
    expect(isImagePath('a.ts')).toBe(false)
    expect(isImagePath('Makefile')).toBe(false)
    expect(projectName({ repoName: 'cc-haha', workDir: '/x/y' })).toBe('cc-haha')
    expect(projectName({ repoName: null, workDir: '/Users/me/demo/' })).toBe('demo')
    expect(projectName(null)).toBe('')
  })

  test('stepping between files does not wrap around', () => {
    const paths = ['a', 'b', 'c']
    expect(stepPath(paths, 'a', -1)).toBeUndefined()
    expect(stepPath(paths, 'a', 1)).toBe('b')
    expect(stepPath(paths, 'c', 1)).toBeUndefined()
    expect(stepPath(paths, 'x', 1)).toBeUndefined()
  })
})

describe('diff presentation', () => {
  const patch =
    'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,3 +1,4 @@\n same\n-old\n+new\n+extra\n tail\n'

  test('file headers are dropped, hunks and content kept', () => {
    const lines = visibleDiffLines(parseDiff(patch))
    expect(lines[0]?.kind).toBe('hunk')
    expect(lines.map((line) => line.kind)).toEqual([
      'hunk',
      'context',
      'remove',
      'add',
      'add',
      'context',
    ])
    expect(diffTotals(lines)).toEqual({ added: 2, removed: 1 })
    expect(visibleDiffLines(parseDiff('Binary files differ'))).toEqual([])
  })

  test('badge is read from the diff itself', () => {
    expect(diffBadge(patch)).toBe('M')
    expect(diffBadge('--- /dev/null\n+++ b/n.ts\n@@ -0,0 +1,2 @@\n+a\n+b')).toBe('A')
    expect(diffBadge('Index: n.ts\n===\n--- n.ts\n+++ n.ts\n@@ -0,0 +1,2 @@\n+a\n+b')).toBe('A')
    expect(diffBadge('--- a/d.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b')).toBe('D')
    expect(diffBadge('--- d.ts\n+++ d.ts\n@@ -1,2 +0,0 @@\n-a\n-b')).toBe('D')
    expect(diffBadge('diff --git a/x b/y\nrename from x\nrename to y\n')).toBe('R')
    expect(diffBadge(undefined)).toBe('M')
  })

  test('workspace status maps to badges and labels', () => {
    expect(workspaceBadge('modified')).toBe('M')
    expect(workspaceBadge('added')).toBe('A')
    expect(workspaceBadge('deleted')).toBe('D')
    expect(workspaceBadge('renamed')).toBe('R')
    expect(workspaceBadge('untracked')).toBe('?')
    expect(workspaceBadge('anything')).toBe('M')
    expect(workspaceStatusLabel('untracked')).toBe('Untracked')
    expect(workspaceStatusLabel('weird')).toBe('Changed')
  })

  test('workspace diff problems are explained', () => {
    expect(workspaceDiffProblem({ state: 'ok' })).toBeUndefined()
    expect(workspaceDiffProblem({ state: 'not_git_repo' })).toContain('Git')
    expect(workspaceDiffProblem({ state: 'error', error: 'boom' })).toBe('boom')
    expect(workspaceDiffProblem({ state: 'error' })).toBe('Cannot compare this file right now.')
  })
})

describe('rewind sheet', () => {
  test('three choices with dry-run numbers when code is restorable', () => {
    const preview = checkpoint(2)
    expect(rewindChoices(preview)).toEqual([
      {
        mode: 'both',
        title: 'Code and conversation',
        description: 'Restore 3 files, delete the 6 messages after',
        disabled: false,
      },
      {
        mode: 'code',
        title: 'Rewind code only',
        description: 'Restore 3 files, keep chat history',
        disabled: false,
      },
      {
        mode: 'conversation',
        title: 'Rewind conversation only',
        description: 'Delete the 6 messages after, files untouched',
        disabled: false,
      },
    ])
    expect(defaultRewindMode(preview)).toBe('both')
    expect(rewindRisks(preview, 'both')).toEqual([
      'Restoring code overwrites changes to these 3 files after the checkpoint. If you are also editing on the computer, save first.',
    ])
    expect(rewindRisks(preview, 'conversation')).toEqual([])
  })

  test('incomplete checkpoint disables code options and says why', () => {
    const preview = checkpoint(1, {
      restoreAvailable: false,
      code: {
        available: false,
        reason: 'Recorded file history is incomplete for: a.ts',
        filesChanged: ['a.ts'],
        insertions: 1,
        deletions: 0,
      },
    })
    const choices = rewindChoices(preview)
    expect(choices.map((choice) => [choice.mode, choice.disabled])).toEqual([
      ['both', true],
      ['code', true],
      ['conversation', false],
    ])
    expect(defaultRewindMode(preview)).toBe('conversation')
    expect(rewindRisks(preview, 'conversation')).toEqual([
      'File checkpoint is incomplete; only the conversation can be rewound. History for these files is incomplete: a.ts',
    ])
  })

  test('turn without files keeps only the conversation option', () => {
    const preview = checkpoint(1, { files: [] })
    expect(rewindChoices(preview).map((choice) => choice.mode)).toEqual(['conversation'])
    expect(defaultRewindMode(preview)).toBe('conversation')
  })

  test('unverified tool changes are surfaced for code rewinds', () => {
    const preview = checkpoint(1, { unverifiedChangeSources: ['Bash', 'mcp__fs'] })
    expect(rewindRisks(preview, 'code')[1]).toBe(
      'Changes by these tools were not fully verified: Bash, mcp__fs. Rewind only restores files recoverable from the checkpoint; other changes may remain.'
    )
  })

  test('known server reasons are translated, unknown kept', () => {
    expect(translateReason('Some changed files cannot be compared as UTF-8 text.')).toBe(
      'Some files are not UTF-8 text and cannot be compared.'
    )
    expect(translateReason('custom')).toBe('custom')
    expect(translateReason(undefined)).toBeUndefined()
  })
})

describe('file preview fallback', () => {
  test('text and images render, documents and failures explain', () => {
    expect(previewFallback({ state: 'ok', previewType: 'text', content: '' })).toBeNull()
    expect(previewFallback({ state: 'ok', previewType: 'image', dataUrl: 'data:' })).toBeNull()
    expect(previewFallback({ state: 'ok', previewType: 'pdf' })).toEqual({
      title: 'Open on the computer',
      detail: 'This app supports previewing text, images and code diffs; this file format is not supported yet.',
    })
    expect(previewFallback({ state: 'binary' })?.detail).toBe('This file cannot be previewed yet (binary file)')
    expect(previewFallback({ state: 'error', error: 'EACCES' })?.detail).toBe('EACCES')
  })
})

test('the changes card reads files first and only mentions non-zero line counts', () => {
  expect(changesCardLabel(3, 18, 4)).toBe('3 files, 18 lines added, 4 lines deleted')
  expect(changesCardLabel(1, 0, 2)).toBe('1 file, 2 lines deleted')
  expect(changesCardLabel(2, 5, 0)).toBe('2 files, 5 lines added')
  expect(changesCardLabel(2, 0, 0)).toBe('2 files')
})
