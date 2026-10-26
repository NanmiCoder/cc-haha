import { splitPath, type BadgeStatus } from '../../core/changesView'

/* 文件页（会话「…」菜单 → 文件）的纯逻辑：已修改列表、目录树展开、搜索。 */

export type FilesTab = 'changed' | 'all'

/** 路由参数 tab：只有 `all` 进「所有文件」，其余（含缺省）进「已修改」。 */
export const parseFilesTab = (value?: string): FilesTab => (value === 'all' ? 'all' : 'changed')

/* ───────────── 已修改 ───────────── */

export type ChangedRow = {
  path: string
  name: string
  /** 目录部分，保留结尾斜杠；根目录下的文件为空串。 */
  dir: string
  /** 差异还没读到时为空，不先猜成「已修改」。 */
  badge?: BadgeStatus
  added?: number
  removed?: number
}

/** 检查点只给路径；M/A/D 和增删行数来自逐文件差异，读到多少用多少。 */
export function changedRows(
  paths: readonly string[],
  summary: (path: string) => { badge: BadgeStatus; added: number; removed: number } | undefined
): ChangedRow[] {
  return paths.map((path) => {
    const { name, dir } = splitPath(path)
    const known = summary(path)
    return { path, name, dir, badge: known?.badge, added: known?.added, removed: known?.removed }
  })
}

/** 空格分隔的每个词都出现在路径里（不分大小写）才算匹配；空查询匹配全部。 */
export function matchesFile(path: string, query: string) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return true
  const haystack = path.toLowerCase()
  return terms.every((term) => haystack.includes(term))
}

export const filterChanged = (rows: readonly ChangedRow[], query: string) =>
  rows.filter((row) => matchesFile(row.path, query))

/** 行的读屏文案：文件名、状态、增删。 */
export function changedRowLabel(row: ChangedRow) {
  const status = row.badge
    ? { M: '已修改', A: '新增', D: '已删除', R: '已重命名', '?': '未跟踪' }[row.badge]
    : ''
  const stats = [row.added ? `增加 ${row.added} 行` : '', row.removed ? `删除 ${row.removed} 行` : '']
    .filter(Boolean)
    .join('，')
  return [row.path, status, stats].filter(Boolean).join('，')
}

/* ───────────── 所有文件 ───────────── */

export type DirEntry = { name: string; path: string; isDirectory: boolean }

/** 一个目录的读取结果：读取中、读到了（可能是空目录）、或出错。 */
export type DirState = 'loading' | { entries: DirEntry[] } | { error: string }

/** 把 `/workspace/tree` 的响应归一成 DirState；state 不是 ok 一律当错误。 */
export function dirState(response: {
  state?: string
  entries?: DirEntry[]
  error?: string
}): DirState {
  if (response.state !== 'ok' || !Array.isArray(response.entries))
    return { error: response.error || '目录无法读取' }
  return { entries: response.entries }
}

/** 文件夹在前，各自按名字排（不分大小写、数字按数值）。 */
export function sortEntries(entries: readonly DirEntry[]) {
  return [...entries].sort(
    (a, b) =>
      Number(b.isDirectory) - Number(a.isDirectory) ||
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })
  )
}

export type TreeItem =
  | { kind: 'entry'; key: string; entry: DirEntry; depth: number; open: boolean }
  | {
      kind: 'note'
      key: string
      depth: number
      text: string
      tone: 'ink3' | 'err'
      /** 出错行点一下重试读取的目录。 */
      retry?: string
    }

/**
 * 把已读到的目录按展开状态摊成一列：展开的文件夹后面紧跟它的内容，
 * 读取中 / 出错 / 空文件夹各占一行说明，缩进随层级加深。
 */
export function treeItems(
  dirs: Readonly<Record<string, DirState>>,
  open: ReadonlySet<string>,
  root = ''
): TreeItem[] {
  const items: TreeItem[] = []
  const walk = (path: string, depth: number) => {
    const state = dirs[path]
    if (!state || state === 'loading') {
      items.push({ kind: 'note', key: `${path}\u0000loading`, depth, text: '读取中…', tone: 'ink3' })
      return
    }
    if ('error' in state) {
      items.push({
        kind: 'note',
        key: `${path}\u0000error`,
        depth,
        text: `${state.error}，点按重试`,
        tone: 'err',
        retry: path,
      })
      return
    }
    if (!state.entries.length) {
      items.push({ kind: 'note', key: `${path}\u0000empty`, depth, text: '空文件夹', tone: 'ink3' })
      return
    }
    for (const entry of sortEntries(state.entries)) {
      const expanded = entry.isDirectory && open.has(entry.path)
      items.push({ kind: 'entry', key: entry.path, entry, depth, open: expanded })
      if (expanded) walk(entry.path, depth + 1)
    }
  }
  walk(root, 0)
  return items
}

/* ───────────── 搜索结果 ───────────── */

export type SearchRow = { path: string; name: string; dir: string }

/** 服务端搜索只返回文件；整理成文件名 + 目录。 */
export function searchRows(entries: readonly DirEntry[]): SearchRow[] {
  return entries
    .filter((entry) => !entry.isDirectory)
    .map((entry) => ({ path: entry.path, ...splitPath(entry.path) }))
}

/** 搜索请求前先去掉首尾空白；空查询不发请求。 */
export const searchQuery = (value: string) => value.trim()
