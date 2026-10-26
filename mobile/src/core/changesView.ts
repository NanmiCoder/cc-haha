import { normalizeHistory } from './chat'
import {
  canRestoreCode,
  type Checkpoint,
  type DiffLine,
  type RewindMode,
} from './operations'
import type { HistoryEntry } from './types'

/** 与 kit 的 FileBadge 一致：M 修改、A 新增、D 删除、R 重命名、? 未跟踪。 */
export type BadgeStatus = 'M' | 'A' | 'D' | 'R' | '?'

export const turnNumber = (checkpoint: Checkpoint) =>
  checkpoint.target.userMessageIndex + 1

export function latestCheckpoint(checkpoints: readonly Checkpoint[]) {
  return checkpoints.reduce<Checkpoint | undefined>(
    (result, item) =>
      !result || item.target.userMessageIndex > result.target.userMessageIndex
        ? item
        : result,
    undefined
  )
}

export function checkpointsNewestFirst(checkpoints: readonly Checkpoint[]) {
  return [...checkpoints].sort(
    (a, b) => b.target.userMessageIndex - a.target.userMessageIndex
  )
}

/** 同一检查点的文件、统计都没变时，按文件缓存的差异仍然可用。 */
export const checkpointSignature = (checkpoint: Checkpoint) =>
  [
    checkpoint.target.targetUserMessageId,
    checkpoint.code.insertions,
    checkpoint.code.deletions,
    checkpoint.code.filesChanged.join('\u0000'),
  ].join('|')

/** `src/core/a.ts` → 名字 `a.ts`、目录 `src/core/`（目录保留结尾斜杠）。 */
export function splitPath(path: string) {
  const normalized = path.replace(/\\/g, '/')
  const index = normalized.replace(/\/+$/, '').lastIndexOf('/')
  if (index < 0) return { name: normalized, dir: '' }
  return { name: normalized.slice(index + 1), dir: normalized.slice(0, index + 1) }
}

/** 文件预览副标题用的目录，不带结尾斜杠。 */
export const parentDir = (path: string) => splitPath(path).dir.replace(/\/$/, '')

export function diffTotals(lines: readonly DiffLine[]) {
  let added = 0
  let removed = 0
  for (const line of lines) {
    if (line.kind === 'add') added++
    else if (line.kind === 'remove') removed++
  }
  return { added, removed }
}

/** 文件头（diff --git / --- / +++ / Index:）在页面标题里已有，只保留 hunk 起的内容。 */
export function visibleDiffLines(lines: readonly DiffLine[]) {
  const first = lines.findIndex((line) => line.kind === 'hunk')
  const body = first < 0 ? lines.filter((line) => line.kind !== 'meta') : lines.slice(first)
  let end = body.length
  while (end > 0 && body[end - 1]!.kind === 'meta' && !body[end - 1]!.text) end--
  return body.slice(0, end)
}

/** 检查点只给文件列表；新增、删除、重命名从这份差异本身读出。 */
export function diffBadge(diff: string | undefined): BadgeStatus {
  if (!diff) return 'M'
  if (/^rename (from|to) /m.test(diff)) return 'R'
  if (/^new file mode /m.test(diff) || /^--- \/dev\/null$/m.test(diff)) return 'A'
  if (/^deleted file mode /m.test(diff) || /^\+\+\+ \/dev\/null$/m.test(diff))
    return 'D'
  const hunks = [...diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)]
  if (hunks.length === 1) {
    const [, beforeStart, beforeCount, afterStart, afterCount] = hunks[0]!
    if (beforeStart === '0' && beforeCount === '0' && afterStart !== '0') return 'A'
    if (afterStart === '0' && afterCount === '0' && beforeStart !== '0') return 'D'
  }
  return 'M'
}

const workspaceBadges: Record<string, BadgeStatus> = {
  modified: 'M',
  type_changed: 'M',
  unknown: 'M',
  added: 'A',
  copied: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: '?',
}
export const workspaceBadge = (status: string): BadgeStatus =>
  workspaceBadges[status] ?? 'M'

const workspaceLabels: Record<string, string> = {
  modified: '已修改',
  type_changed: '类型改变',
  added: '新增',
  copied: '复制',
  deleted: '已删除',
  renamed: '已重命名',
  untracked: '未跟踪',
  unknown: '有改动',
}
export const workspaceStatusLabel = (status: string) =>
  workspaceLabels[status] ?? '有改动'

export function formatBytes(size: number | undefined) {
  if (size === undefined || !Number.isFinite(size) || size < 0) return ''
  if (size < 1024) return `${Math.round(size)} B`
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`
  const mb = size / (1024 * 1024)
  return `${mb >= 100 ? Math.round(mb) : mb.toFixed(1).replace(/\.0$/, '')} MB`
}

/** 面包屑：根（项目名）+ 每一级目录，每段都带可跳转的相对路径。 */
export function breadcrumbs(root: string, path: string) {
  const parts = path.split('/').filter(Boolean)
  return [
    { label: root, path: '' },
    ...parts.map((label, index) => ({
      label,
      path: parts.slice(0, index + 1).join('/'),
    })),
  ]
}

const pad = (value: number) => String(value).padStart(2, '0')

/** 今天只显示 HH:mm，更早带上日期；最新一轮加“最新”。 */
export function turnTimeLabel(
  startedAt: number | undefined,
  latest: boolean,
  now = new Date()
) {
  const parts: string[] = []
  if (startedAt !== undefined && Number.isFinite(startedAt)) {
    const date = new Date(startedAt)
    const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`
    const sameDay =
      date.getFullYear() === now.getFullYear() &&
      date.getMonth() === now.getMonth() &&
      date.getDate() === now.getDate()
    parts.push(
      sameDay ? time : `${date.getMonth() + 1}月${date.getDate()}日 ${time}`
    )
  }
  if (latest) parts.push('最新')
  return parts.join(' · ')
}

/** 这一轮开头那条用户消息的文字，压成一行；没有文字（只有图片等）时返回 undefined。 */
export function checkpointPrompt(
  entries: readonly HistoryEntry[],
  targetUserMessageId: string
) {
  const owned = entries.filter((entry) => entry.id === targetUserMessageId)
  if (!owned.length) return undefined
  const text = normalizeHistory(owned)
    .filter((item) => item.type === 'user')
    .map((item) => item.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text || undefined
}

const knownReasons: [RegExp, (match: RegExpExecArray) => string][] = [
  [/^Some changed files cannot be compared as UTF-8 text\.?$/, () => '有的文件不是 UTF-8 文本，无法比较。'],
  [/^No transcript file changes were recorded for this turn\.?$/, () => '这一轮没有记录到文件改动。'],
  [/^No file checkpoints were recorded for this session\.?$/, () => '这个会话没有记录文件检查点。'],
  [/^No file checkpoint is available for the selected message\.?$/, () => '这一轮没有可用的文件检查点。'],
  [/^The checkpoint could not be prepared safely\.?$/, () => '检查点无法安全地准备好。'],
  [/^Recorded file history is incomplete for: (.+)$/, (m) => `这些文件的历史记录不完整：${m[1]}`],
  [/^Recorded restore points are incomplete for: (.+)$/, (m) => `这些文件的恢复点不完整：${m[1]}`],
]

/** 电脑返回的检查点原因翻成中文；未知原因原样保留。 */
export function translateReason(reason: string | undefined) {
  const text = reason?.trim()
  if (!text) return undefined
  for (const [pattern, render] of knownReasons) {
    const match = pattern.exec(text)
    if (match) return render(match)
  }
  return text
}

export type RewindChoice = {
  mode: RewindMode
  title: string
  description: string
  disabled: boolean
}

const fileCount = (checkpoint: Checkpoint) => checkpoint.code.filesChanged.length
const messageCount = (checkpoint: Checkpoint) =>
  checkpoint.conversation?.messagesRemoved ?? 0

/** 回退范围三选一；没有可恢复文件时只留“只回退对话”，代码不可恢复时禁用前两项。 */
export function rewindChoices(preview: Checkpoint): RewindChoice[] {
  const files = fileCount(preview)
  const messages = messageCount(preview)
  const conversation: RewindChoice = {
    mode: 'conversation',
    title: '只回退对话',
    description: `删掉之后的 ${messages} 条消息，文件不动`,
    disabled: false,
  }
  if (!files) return [conversation]
  const disabled = !canRestoreCode(preview)
  return [
    {
      mode: 'both',
      title: '代码和对话一起',
      description: `恢复 ${files} 个文件，删掉之后的 ${messages} 条消息`,
      disabled,
    },
    {
      mode: 'code',
      title: '只回退代码',
      description: `恢复 ${files} 个文件，聊天记录留着`,
      disabled,
    },
    conversation,
  ]
}

export const defaultRewindMode = (preview: Checkpoint): RewindMode =>
  fileCount(preview) && canRestoreCode(preview) ? 'both' : 'conversation'

/** 所选范围下需要提前说清楚的风险。 */
export function rewindRisks(preview: Checkpoint, mode: RewindMode) {
  const files = fileCount(preview)
  const risks: string[] = []
  if (!files) {
    risks.push('这一轮没有可恢复的文件，只能回退对话。')
    return risks
  }
  if (!canRestoreCode(preview)) {
    const reason = translateReason(preview.code.reason)
    risks.push(
      `文件检查点不完整，只能回退对话。${reason ? reason : ''}`
    )
    return risks
  }
  if (mode === 'conversation') return risks
  risks.push(
    `恢复代码会覆盖这 ${files} 个文件在检查点之后的修改。你在电脑上也在改的话，先存好。`
  )
  const sources = preview.unverifiedChangeSources ?? []
  if (sources.length)
    risks.push(
      `这些工具的改动未被完整验证：${sources.join('、')}。回退只恢复检查点中可恢复的文件，其他改动可能保留。`
    )
  return risks
}

const imageExtensions = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'heic', 'avif'])
export function isImagePath(path: string) {
  const extension = /\.([^./\\]+)$/.exec(path)?.[1]?.toLowerCase()
  return extension ? imageExtensions.has(extension) : false
}

/** 上一个 / 下一个文件；到头不循环。 */
export function stepPath(paths: readonly string[], current: string, delta: number) {
  const index = paths.indexOf(current)
  if (index < 0) return undefined
  return paths[index + delta]
}

export type PreviewFile = {
  state: string
  content?: string
  dataUrl?: string
  previewType?: string
  error?: string
}

/** 无法在手机上显示时的说明；能显示时返回 null。 */
export function previewFallback(file: PreviewFile) {
  if (file.state === 'ok') {
    if (file.previewType === 'image' && file.dataUrl) return null
    if (file.content !== undefined && file.previewType !== 'image') return null
    return {
      title: '请在电脑上打开',
      detail: '当前 App 支持文本、图片和代码差异预览；此文件格式尚未接入。',
    }
  }
  const named: Record<string, string> = {
    binary: '二进制文件',
    too_large: '文件过大',
    missing: '文件不存在',
  }
  return {
    title: '请在电脑上打开',
    detail:
      file.error ||
      `此文件暂不支持预览 (${named[file.state] ?? file.state})`,
  }
}

/** 工作区差异读取失败时的说明。 */
export function workspaceDiffProblem(result: { state: string; error?: string }) {
  if (result.state === 'ok') return undefined
  if (result.state === 'not_git_repo') return '这个工作区没有 Git 仓库，无法比较改动。'
  if (result.state === 'missing') return '这个文件已经不在工作区里了。'
  return result.error || '暂时无法比较此文件。'
}

export const errorMessage = (error: unknown) =>
  error instanceof Error && error.message ? error.message : '操作未完成，请重试'

/** 项目名：仓库名优先，否则用工作目录的最后一段。 */
export function projectName(status: { repoName?: string | null; workDir?: string } | null) {
  if (status?.repoName) return status.repoName
  const dir = status?.workDir?.replace(/[\\/]+$/, '')
  return dir ? (dir.split(/[\\/]/).pop() ?? '') : ''
}

/** 会话里变更卡的读屏文案：`3 个文件，新增 18 行，删除 4 行`；没有增删统计时只说文件数。 */
export function changesCardLabel(files: number, insertions: number, deletions: number) {
  return [
    `${files} 个文件`,
    insertions ? `新增 ${insertions} 行` : '',
    deletions ? `删除 ${deletions} 行` : '',
  ]
    .filter(Boolean)
    .join('，')
}
