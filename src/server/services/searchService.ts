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

export type SearchResult = {
  file: string
  line: number
  text: string
  context?: string[]
}

export type SessionSearchResult = {
  sessionId: string
  title: string
  matchCount: number
  matches: Array<{ line: number; text: string }>
}

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

    return this.searchWithGrep(query, cwd, maxResults, options)
  }

  // ---------------------------------------------------------------------------
  // 会话历史搜索
  // ---------------------------------------------------------------------------

  /** 搜索会话历史文件 */
  async searchSessions(query: string): Promise<SessionSearchResult[]> {
    if (!query) {
      throw ApiError.badRequest('Search query is required')
    }

    const configDir =
      process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
    const projectsDir = path.join(configDir, 'projects')

    const results: SessionSearchResult[] = []

    try {
      await fs.access(projectsDir)
    } catch {
      // 目录不存在，返回空
      return results
    }

    // 遍历 projects/ 下的 JSONL 会话文件
    const entries = await this.walkJsonlFiles(projectsDir)
    const lowerQuery = query.toLowerCase()

    for (const filePath of entries) {
      try {
        const raw = await fs.readFile(filePath, 'utf-8')
        const lines = raw.split('\n').filter(Boolean)

        const matches: Array<{ line: number; text: string }> = []
        let title = path.basename(filePath, '.jsonl')

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]
          if (line.toLowerCase().includes(lowerQuery)) {
            // 尝试提取可读文本
            try {
              const obj = JSON.parse(line) as Record<string, unknown>
              const text =
                typeof obj.message === 'string'
                  ? obj.message
                  : typeof obj.content === 'string'
                    ? obj.content
                    : line.slice(0, 200)

              // 提取 title
              if (i === 0 && typeof obj.title === 'string') {
                title = obj.title
              }

              matches.push({ line: i + 1, text: text.slice(0, 300) })
            } catch {
              matches.push({ line: i + 1, text: line.slice(0, 200) })
            }
          }
        }

        if (matches.length > 0) {
          const sessionId = path.basename(filePath, '.jsonl')
          results.push({
            sessionId,
            title,
            matchCount: matches.length,
            matches: matches.slice(0, 20), // 每个会话最多 20 条匹配
          })
        }
      } catch {
        // 跳过无法读取的文件
      }
    }

    return results
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
      const proc = spawn('which', [cmd], { stdio: 'ignore' })
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
