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
    expect(turnTimeLabel(new Date(2026, 9, 25, 14, 6).getTime(), true, now)).toBe('14:06 · 最新')
    expect(turnTimeLabel(new Date(2026, 9, 24, 9, 30).getTime(), false, now)).toBe('10月24日 09:30')
    expect(turnTimeLabel(undefined, true, now)).toBe('最新')
    expect(turnTimeLabel(undefined, false, now)).toBe('')
  })

  test('prompt quote comes only from the exact target user record, flattened to one line', () => {
    const entries: HistoryEntry[] = [
      { id: 'user-1', type: 'user', content: '重连之后\n同一条回复会出现两次', timestamp: '' },
      { id: 'a-1', type: 'assistant', content: [{ type: 'text', text: '好的' }], timestamp: '' },
      {
        id: 'user-2',
        type: 'user',
        content: [{ type: 'text', text: '  第二轮  ' }],
        timestamp: '',
      },
    ]
    expect(checkpointPrompt(entries, 'user-1')).toBe('重连之后 同一条回复会出现两次')
    expect(checkpointPrompt(entries, 'user-2')).toBe('第二轮')
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
    expect(workspaceStatusLabel('untracked')).toBe('未跟踪')
    expect(workspaceStatusLabel('weird')).toBe('有改动')
  })

  test('workspace diff problems are explained', () => {
    expect(workspaceDiffProblem({ state: 'ok' })).toBeUndefined()
    expect(workspaceDiffProblem({ state: 'not_git_repo' })).toContain('Git')
    expect(workspaceDiffProblem({ state: 'error', error: 'boom' })).toBe('boom')
    expect(workspaceDiffProblem({ state: 'error' })).toBe('暂时无法比较此文件。')
  })
})

describe('rewind sheet', () => {
  test('three choices with dry-run numbers when code is restorable', () => {
    const preview = checkpoint(2)
    expect(rewindChoices(preview)).toEqual([
      {
        mode: 'both',
        title: '代码和对话一起',
        description: '恢复 3 个文件，删掉之后的 6 条消息',
        disabled: false,
      },
      {
        mode: 'code',
        title: '只回退代码',
        description: '恢复 3 个文件，聊天记录留着',
        disabled: false,
      },
      {
        mode: 'conversation',
        title: '只回退对话',
        description: '删掉之后的 6 条消息，文件不动',
        disabled: false,
      },
    ])
    expect(defaultRewindMode(preview)).toBe('both')
    expect(rewindRisks(preview, 'both')).toEqual([
      '恢复代码会覆盖这 3 个文件在检查点之后的修改。你在电脑上也在改的话，先存好。',
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
      '文件检查点不完整，只能回退对话。这些文件的历史记录不完整：a.ts',
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
      '这些工具的改动未被完整验证：Bash、mcp__fs。回退只恢复检查点中可恢复的文件，其他改动可能保留。'
    )
  })

  test('known server reasons are translated, unknown kept', () => {
    expect(translateReason('Some changed files cannot be compared as UTF-8 text.')).toBe(
      '有的文件不是 UTF-8 文本，无法比较。'
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
      title: '请在电脑上打开',
      detail: '当前 App 支持文本、图片和代码差异预览；此文件格式尚未接入。',
    })
    expect(previewFallback({ state: 'binary' })?.detail).toBe('此文件暂不支持预览 (二进制文件)')
    expect(previewFallback({ state: 'error', error: 'EACCES' })?.detail).toBe('EACCES')
  })
})

test('the changes card reads files first and only mentions non-zero line counts', () => {
  expect(changesCardLabel(3, 18, 4)).toBe('3 个文件，新增 18 行，删除 4 行')
  expect(changesCardLabel(1, 0, 2)).toBe('1 个文件，删除 2 行')
  expect(changesCardLabel(2, 5, 0)).toBe('2 个文件，新增 5 行')
  expect(changesCardLabel(2, 0, 0)).toBe('2 个文件')
})
