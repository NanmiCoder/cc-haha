/**
 * SearchService — 工作区文件搜索 & 会话历史搜索
 *
 * 优先使用 ripgrep (rg)，不可用时降级到 grep。
 */

import { spawn } from 'child_process'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { ApiError } from '../middleware/errorHandler.js'
import { sessionService } from './sessionService.js'

export type SearchResult = {
  file: string
  line: number
  text: string
  context?: string[]
}

export type SessionMatchRole = 'user' | 'assistant'

export type SessionMatch = {
  /** Who produced the matched text. */
  role: SessionMatchRole
  /** Transcript entry uuid (for future "jump to message"); null on legacy rows. */
  messageId: string | null
  /** 1-based line number inside the .jsonl file. */
  lineNumber: number
  /** Whitespace-collapsed, window-trimmed readable excerpt. */
  snippet: string
  /** Match ranges relative to `snippet`, for highlighting. */
  highlights: Array<{ start: number; end: number }>
  timestamp?: string
}

export type SessionSearchResult = {
  sessionId: string
  title: string
  projectPath: string
  workDir: string | null
  modifiedAt: string
  /** Total readable matches in the session (may exceed matches.length). */
  matchCount: number
  matches: SessionMatch[]
}

export type SessionSearchOptions = {
  limit?: number
  matchesPerSession?: number
  caseSensitive?: boolean
}

export type SessionSearchOutput = {
  results: SessionSearchResult[]
  truncated: boolean
}

/** Minimal transcript-entry shape needed for search (mirrors sessionService's RawEntry). */
type RawSearchEntry = {
  type?: string
  uuid?: string
  timestamp?: string
  message?: { role?: string; content?: unknown }
  [key: string]: unknown
}

/** Cap files parsed in phase B so a broad query can't read hundreds of large files. */
const SESSION_SEARCH_MAX_FILES = 60
const SESSION_SEARCH_DEFAULT_LIMIT = 50
const SESSION_SEARCH_DEFAULT_MATCHES_PER_SESSION = 5
/** Characters of context kept on each side of a match inside a snippet. */
const SESSION_SNIPPET_WINDOW = 120
/** Guard ripgrep output against multi-MB single lines (base64 / big tool results). */
const RG_MAX_COLUMNS = 500

export class SearchService {
  // ---------------------------------------------------------------------------
  // 工作区搜索
  // ---------------------------------------------------------------------------

  /** 使用 ripgrep 搜索工作目录 */
  async searchWorkspace(
    query: string,
    options?: {
      cwd?: string
      maxResults?: number
      glob?: string
      caseSensitive?: boolean
    },
  ): Promise<SearchResult[]> {
    if (!query) {
      throw ApiError.badRequest('Search query is required')
    }

    const cwd = options?.cwd || process.cwd()
    const maxResults = options?.maxResults || 200

    // 尝试 rg，降级到 grep
    const hasRg = await this.commandExists('rg')
    if (hasRg) {
      try {
        return await this.searchWithRipgrep(query, cwd, maxResults, options)
      } catch {
        // rg 执行失败，降级到 grep
      }
    }

    const hasGrep = await this.commandExists('grep')
    if (hasGrep) {
      try {
        return await this.searchWithGrep(query, cwd, maxResults, options)
      } catch {
        // grep failed or is not available; fall back to a portable search.
      }
    }

    return this.searchWithFilesystem(query, cwd, maxResults, options)
  }

  // ---------------------------------------------------------------------------
  // 会话历史搜索
  // ---------------------------------------------------------------------------

  /**
   * Full-text search across all session transcripts.
   *
   * Two-phase: (A) ripgrep scans `~/.claude/projects` for candidate files +
   * matched line numbers (fast — tens of ms over hundreds of MB; falls back to a
   * pure-JS scan when rg is unavailable). (B) for the most-recently-modified
   * candidate files we parse only the matched lines, keep just user/assistant
   * text blocks, re-confirm the query against the cleaned text (dropping
   * ripgrep's false positives on JSON keys / UUIDs / base64), and build
   * highlighted snippets with real session titles.
   */
  async searchSessions(
    query: string,
    options?: SessionSearchOptions,
  ): Promise<SessionSearchOutput> {
    const trimmedQuery = query.trim()
    if (!trimmedQuery) {
      throw ApiError.badRequest('Search query is required')
    }

    const caseSensitive = options?.caseSensitive ?? false
    const limit = options?.limit ?? SESSION_SEARCH_DEFAULT_LIMIT
    const matchesPerSession =
      options?.matchesPerSession ?? SESSION_SEARCH_DEFAULT_MATCHES_PER_SESSION

    const configDir =
      process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
    const projectsDir = path.join(configDir, 'projects')

    try {
      await fs.access(projectsDir)
    } catch {
      return { results: [], truncated: false }
    }

    // ── Phase A: candidate files + matched line numbers ──────────────────────
    const candidates = await this.findSessionCandidateLines(
      trimmedQuery,
      projectsDir,
      { caseSensitive },
    )
    if (candidates.size === 0) {
      return { results: [], truncated: false }
    }

    // Prefer the most recently modified sessions; cap how many we parse.
    const ranked = await Promise.all(
      [...candidates.keys()].map(async (filePath) => {
        let mtimeMs = 0
        try {
          mtimeMs = (await fs.stat(filePath)).mtimeMs
        } catch {
          // unreadable — sinks to the bottom
        }
        return { filePath, mtimeMs }
      }),
    )
    ranked.sort((a, b) => b.mtimeMs - a.mtimeMs)

    let truncated = false
    let filesToParse = ranked
    if (filesToParse.length > SESSION_SEARCH_MAX_FILES) {
      filesToParse = filesToParse.slice(0, SESSION_SEARCH_MAX_FILES)
      truncated = true
    }

    // ── Phase B: parse matched lines serially (avoid concurrent big-file reads)
    const results: SessionSearchResult[] = []
    for (const { filePath } of filesToParse) {
      const lineNumbers = candidates.get(filePath)
      if (!lineNumbers || lineNumbers.size === 0) continue

      const { matches, matchCount } = await this.extractSessionMatches(
        filePath,
        lineNumbers,
        trimmedQuery,
        { caseSensitive, matchesPerSession },
      )
      // All ripgrep hits were JSON noise (no readable user/assistant text).
      if (matchCount === 0) continue

      const sessionId = path.basename(filePath, '.jsonl')
      let title = sessionId
      let projectPath = path.basename(path.dirname(filePath))
      let workDir: string | null = null
      let modifiedAt = new Date(0).toISOString()
      try {
        const meta = await sessionService.getSessionTitleAndMeta(filePath)
        title = meta.title
        projectPath = meta.projectPath
        workDir = meta.workDir
        modifiedAt = meta.modifiedAt
      } catch {
        // keep fallbacks
      }

      results.push({
        sessionId,
        title,
        projectPath,
        workDir,
        modifiedAt,
        matchCount,
        matches,
      })
    }

    // Most recently modified first.
    results.sort((a, b) =>
      a.modifiedAt < b.modifiedAt ? 1 : a.modifiedAt > b.modifiedAt ? -1 : 0,
    )

    if (results.length > limit) {
      return { results: results.slice(0, limit), truncated: true }
    }
    return { results, truncated }
  }

  // ---------------------------------------------------------------------------
  // 会话搜索 — Phase A: 候选文件 + 命中行号
  // ---------------------------------------------------------------------------

  private async findSessionCandidateLines(
    query: string,
    projectsDir: string,
    opts: { caseSensitive: boolean },
  ): Promise<Map<string, Set<number>>> {
    if (await this.commandExists('rg')) {
      try {
        return await this.findSessionCandidatesWithRipgrep(query, projectsDir, opts)
      } catch {
        // rg failed — fall back to a portable scan
      }
    }
    return this.findSessionCandidatesWithFilesystem(query, projectsDir, opts)
  }

  private async findSessionCandidatesWithRipgrep(
    query: string,
    projectsDir: string,
    opts: { caseSensitive: boolean },
  ): Promise<Map<string, Set<number>>> {
    const args = ['--json', '--max-columns', String(RG_MAX_COLUMNS), '--glob', '*.jsonl']
    if (!opts.caseSensitive) args.push('--ignore-case')
    args.push('--', query, projectsDir)

    const output = await this.runCommand('rg', args)
    const map = new Map<string, Set<number>>()

    for (const line of output.split('\n')) {
      if (!line) continue
      try {
        const obj = JSON.parse(line) as Record<string, unknown>
        if (obj.type !== 'match') continue
        const data = obj.data as { path?: { text?: string }; line_number?: number }
        const file = data.path?.text
        const lineNum = data.line_number
        if (!file || !lineNum) continue
        let set = map.get(file)
        if (!set) {
          set = new Set<number>()
          map.set(file, set)
        }
        set.add(lineNum)
      } catch {
        // skip unparseable rg rows
      }
    }
    return map
  }

  private async findSessionCandidatesWithFilesystem(
    query: string,
    projectsDir: string,
    opts: { caseSensitive: boolean },
  ): Promise<Map<string, Set<number>>> {
    const files = await this.walkJsonlFiles(projectsDir)
    const needle = opts.caseSensitive ? query : query.toLowerCase()
    const map = new Map<string, Set<number>>()

    for (const filePath of files) {
      let raw: string
      try {
        raw = await fs.readFile(filePath, 'utf-8')
      } catch {
        continue
      }
      const lines = raw.split('\n')
      const set = new Set<number>()
      for (let i = 0; i < lines.length; i++) {
        const haystack = opts.caseSensitive ? lines[i] : lines[i].toLowerCase()
        if (haystack.includes(needle)) set.add(i + 1)
      }
      if (set.size > 0) map.set(filePath, set)
    }
    return map
  }

  // ---------------------------------------------------------------------------
  // 会话搜索 — Phase B: 解析命中行 → 清洗 → 提取片段
  // ---------------------------------------------------------------------------

  private async extractSessionMatches(
    filePath: string,
    lineNumbers: Set<number>,
    query: string,
    opts: { caseSensitive: boolean; matchesPerSession: number },
  ): Promise<{ matches: SessionMatch[]; matchCount: number }> {
    let raw: string
    try {
      raw = await fs.readFile(filePath, 'utf-8')
    } catch {
      return { matches: [], matchCount: 0 }
    }

    const lines = raw.split('\n')
    const needle = opts.caseSensitive ? query : query.toLowerCase()
    const matches: SessionMatch[] = []
    let matchCount = 0

    for (const lineNo of [...lineNumbers].sort((a, b) => a - b)) {
      const line = lines[lineNo - 1]
      if (!line) continue

      let entry: RawSearchEntry
      try {
        entry = JSON.parse(line) as RawSearchEntry
      } catch {
        continue // half-written / malformed line
      }

      for (const segment of this.extractUserAssistantSegments(entry)) {
        const haystack = opts.caseSensitive ? segment.text : segment.text.toLowerCase()
        if (!haystack.includes(needle)) continue // ripgrep false positive (JSON noise)

        matchCount += 1
        if (matches.length < opts.matchesPerSession) {
          const { snippet, highlights } = this.buildSnippet(
            segment.text,
            query,
            opts.caseSensitive,
          )
          matches.push({
            role: segment.role,
            messageId: typeof entry.uuid === 'string' ? entry.uuid : null,
            lineNumber: lineNo,
            snippet,
            highlights,
            ...(typeof entry.timestamp === 'string' ? { timestamp: entry.timestamp } : {}),
          })
        }
      }
    }

    return { matches, matchCount }
  }

  /**
   * Extract only the user/assistant natural-language text from a transcript
   * entry. Tool calls (tool_use) and tool results (tool_result) are skipped, as
   * are internal command breadcrumbs — keeping search results clean.
   */
  private extractUserAssistantSegments(
    entry: RawSearchEntry,
  ): Array<{ role: SessionMatchRole; text: string }> {
    if (entry.type !== 'user' && entry.type !== 'assistant') return []

    const content = entry.message?.content
    if (this.isInternalCommandBreadcrumb(content)) return []

    const role: SessionMatchRole =
      entry.type === 'assistant' || entry.message?.role === 'assistant'
        ? 'assistant'
        : 'user'

    return this.extractPlainTextBlocks(content).map((text) => ({ role, text }))
  }

  /** Plain text from message content (string, or `text` blocks only). */
  private extractPlainTextBlocks(content: unknown): string[] {
    if (typeof content === 'string') {
      const trimmed = content.trim()
      return trimmed ? [trimmed] : []
    }
    if (!Array.isArray(content)) return []

    const out: string[] = []
    for (const block of content) {
      if (block && typeof block === 'object') {
        const record = block as Record<string, unknown>
        if (record.type === 'text' && typeof record.text === 'string') {
          const trimmed = record.text.trim()
          if (trimmed) out.push(trimmed)
        }
      }
    }
    return out
  }

  private isInternalCommandBreadcrumb(content: unknown): boolean {
    const textBlocks = this.extractPlainTextBlocks(content)
    return (
      textBlocks.length > 0 &&
      textBlocks.every((text) =>
        text.includes('<command-name>') ||
        text.includes('<command-message>') ||
        text.includes('<command-args>') ||
        text.includes('<local-command-caveat>'),
      )
    )
  }

  /** Window a single match into a one-line, highlighted snippet. */
  private buildSnippet(
    text: string,
    query: string,
    caseSensitive: boolean,
  ): { snippet: string; highlights: Array<{ start: number; end: number }> } {
    const normalized = text.replace(/\s+/g, ' ').trim()
    const haystack = caseSensitive ? normalized : normalized.toLowerCase()
    const needle = caseSensitive ? query : query.toLowerCase()

    const idx = haystack.indexOf(needle)
    if (idx < 0) {
      const head = normalized.slice(0, SESSION_SNIPPET_WINDOW * 2)
      return {
        snippet: head + (normalized.length > head.length ? '…' : ''),
        highlights: [],
      }
    }

    const start = Math.max(0, idx - SESSION_SNIPPET_WINDOW)
    const end = Math.min(normalized.length, idx + needle.length + SESSION_SNIPPET_WINDOW)
    const prefix = start > 0 ? '…' : ''
    const suffix = end < normalized.length ? '…' : ''
    const snippet = prefix + normalized.slice(start, end) + suffix
    const highlightStart = prefix.length + (idx - start)

    return {
      snippet,
      highlights: [{ start: highlightStart, end: highlightStart + needle.length }],
    }
  }

  // ---------------------------------------------------------------------------
  // ripgrep 搜索
  // ---------------------------------------------------------------------------

  private async searchWithRipgrep(
    query: string,
    cwd: string,
    maxResults: number,
    options?: {
      glob?: string
      caseSensitive?: boolean
    },
  ): Promise<SearchResult[]> {
    const args = ['--json', '--max-count', String(maxResults)]

    if (options?.caseSensitive === false) {
      args.push('--ignore-case')
    }

    // 添加上下文行
    args.push('-C', '4')

    if (options?.glob) {
      args.push('--glob', options.glob)
    }

    args.push('--', query, cwd)

    const output = await this.runCommand('rg', args)
    return this.parseRipgrepJson(output, maxResults)
  }

  /** 解析 ripgrep JSON 输出 */
  private parseRipgrepJson(
    output: string,
    maxResults: number,
  ): SearchResult[] {
    const results: SearchResult[] = []
    const lines = output.split('\n').filter(Boolean)

    // 收集上下文：key = `${file}:${matchLine}`
    const contextMap = new Map<
      string,
      { file: string; line: number; text: string; context: string[] }
    >()

    for (const line of lines) {
      try {
        const obj = JSON.parse(line) as Record<string, unknown>
        if (obj.type === 'match') {
          const data = obj.data as {
            path?: { text?: string }
            line_number?: number
            lines?: { text?: string }
            submatches?: unknown[]
          }

          const file = data.path?.text || ''
          const lineNum = data.line_number || 0
          const text = (data.lines?.text || '').replace(/\n$/, '')
          const key = `${file}:${lineNum}`

          contextMap.set(key, { file, line: lineNum, text, context: [] })
        } else if (obj.type === 'context') {
          // 上下文行归属到最近的 match
          const data = obj.data as {
            path?: { text?: string }
            line_number?: number
            lines?: { text?: string }
          }
          const text = (data.lines?.text || '').replace(/\n$/, '')

          // 附加到最后一个相同文件的 match
          const file = data.path?.text || ''
          for (const [key, entry] of contextMap) {
            if (key.startsWith(file + ':')) {
              entry.context.push(text)
            }
          }
        }
      } catch {
        // 跳过无法解析的行
      }
    }

    for (const entry of contextMap.values()) {
      if (results.length >= maxResults) break
      results.push({
        file: entry.file,
        line: entry.line,
        text: entry.text,
        context: entry.context.length > 0 ? entry.context : undefined,
      })
    }

    return results
  }

  // ---------------------------------------------------------------------------
  // grep 降级
  // ---------------------------------------------------------------------------

  private async searchWithGrep(
    query: string,
    cwd: string,
    maxResults: number,
    options?: {
      glob?: string
      caseSensitive?: boolean
    },
  ): Promise<SearchResult[]> {
    const args = ['-rn', '--max-count', String(maxResults)]

    if (options?.caseSensitive === false) {
      args.push('-i')
    }

    if (options?.glob) {
      args.push('--include', options.glob)
    }

    args.push('--', query, cwd)

    const output = await this.runCommand('grep', args)
    return this.parseGrepOutput(output, maxResults)
  }

  /** 解析 grep 输出 (file:line:text) */
  private parseGrepOutput(output: string, maxResults: number): SearchResult[] {
    const results: SearchResult[] = []
    const lines = output.split('\n').filter(Boolean)

    for (const line of lines) {
      if (results.length >= maxResults) break

      // grep -n 输出格式: file:line:text
      const match = line.match(/^(.+?):(\d+):(.*)$/)
      if (match) {
        results.push({
          file: match[1],
          line: parseInt(match[2], 10),
          text: match[3],
        })
      }
    }

    return results
  }

  // ---------------------------------------------------------------------------
  // Portable filesystem fallback
  // ---------------------------------------------------------------------------

  private async searchWithFilesystem(
    query: string,
    cwd: string,
    maxResults: number,
    options?: {
      glob?: string
      caseSensitive?: boolean
    },
  ): Promise<SearchResult[]> {
    const results: SearchResult[] = []
    const needle = options?.caseSensitive === false ? query.toLowerCase() : query

    await this.searchDirectory(cwd, needle, results, maxResults, {
      caseSensitive: options?.caseSensitive !== false,
      glob: options?.glob,
    })

    return results
  }

  private async searchDirectory(
    dir: string,
    needle: string,
    results: SearchResult[],
    maxResults: number,
    options: {
      caseSensitive: boolean
      glob?: string
    },
  ): Promise<void> {
    if (results.length >= maxResults) return

    let entries: import('fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (results.length >= maxResults) return
      if (entry.name === 'node_modules' || entry.name === '.git') continue

      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await this.searchDirectory(fullPath, needle, results, maxResults, options)
        continue
      }

      if (!entry.isFile()) continue
      if (options.glob && !this.matchesSimpleGlob(entry.name, options.glob)) continue

      await this.searchFile(fullPath, needle, results, maxResults, options.caseSensitive)
    }
  }

  private async searchFile(
    filePath: string,
    needle: string,
    results: SearchResult[],
    maxResults: number,
    caseSensitive: boolean,
  ): Promise<void> {
    let content: string
    try {
      const buffer = await fs.readFile(filePath)
      if (buffer.includes(0)) return
      content = buffer.toString('utf8')
    } catch {
      return
    }

    const lines = content.split(/\r?\n/)
    for (let index = 0; index < lines.length && results.length < maxResults; index++) {
      const haystack = caseSensitive ? lines[index] : lines[index].toLowerCase()
      if (!haystack.includes(needle)) continue

      results.push({
        file: filePath,
        line: index + 1,
        text: lines[index],
      })
    }
  }

  private matchesSimpleGlob(fileName: string, glob: string): boolean {
    if (!glob.includes('*')) return fileName === glob
    const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
    return new RegExp(`^${escaped}$`).test(fileName)
  }

  // ---------------------------------------------------------------------------
  // 工具方法
  // ---------------------------------------------------------------------------

  /** 运行外部命令，返回 stdout */
  private runCommand(cmd: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      const chunks: Buffer[] = []

      proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))

      proc.on('close', (code) => {
        const output = Buffer.concat(chunks).toString('utf-8')
        // rg/grep 返回 1 表示无匹配，不视为错误
        if (code === 0 || code === 1) {
          resolve(output)
        } else {
          reject(
            new Error(`Command "${cmd}" exited with code ${code}: ${output}`),
          )
        }
      })

      proc.on('error', (err) => {
        reject(err)
      })
    })
  }

  /** 检测命令是否存在 */
  private commandExists(cmd: string): Promise<boolean> {
    return new Promise((resolve) => {
      const lookup = process.platform === 'win32' ? 'where' : 'which'
      const proc = spawn(lookup, [cmd], { stdio: 'ignore' })
      proc.on('close', (code) => resolve(code === 0))
      proc.on('error', () => resolve(false))
    })
  }

  /** 递归查找 .jsonl 文件 */
  private async walkJsonlFiles(dir: string): Promise<string[]> {
    const results: string[] = []

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          const sub = await this.walkJsonlFiles(fullPath)
          results.push(...sub)
        } else if (entry.name.endsWith('.jsonl')) {
          results.push(fullPath)
        }
      }
    } catch {
      // 跳过不可访问的目录
    }

    return results
  }
}
