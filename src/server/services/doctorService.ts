import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Dirent } from 'node:fs'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { diagnosticsService } from './diagnosticsService.js'

export type DoctorItemKind = 'json' | 'jsonl' | 'directory'
export type DoctorItemStatus = 'ok' | 'missing' | 'invalid_json' | 'invalid_jsonl' | 'unreadable'
export type DoctorSkipReason = 'protected'

export type DoctorReportItem = {
  id: string
  label: string
  kind: DoctorItemKind
  scope: 'user' | 'project'
  path: string
  protected: boolean
  exists: boolean
  status: DoctorItemStatus
  bytes: number
  entryCount?: number
  lineCount?: number
  invalidLineCount?: number
  error?: string
}

export type DoctorProtectedSkip = {
  id: string
  path: string
  reason: DoctorSkipReason
}

export type DoctorReport = {
  generatedAt: string
  items: DoctorReportItem[]
  protectedSkips: DoctorProtectedSkip[]
  summary: {
    total: number
    protectedCount: number
    missingCount: number
    invalidCount: number
  }
}

export type DoctorRepairOperation = {
  id: string
  path: string
  action: 'would_repair'
}

export type DoctorRepairSkip = {
  id: string
  path: string
  reason: DoctorSkipReason
}

export type DoctorRepairResult = {
  dryRun: true
  mutated: false
  operations: DoctorRepairOperation[]
  skips: DoctorRepairSkip[]
  summary: {
    operationCount: number
    skipCount: number
  }
}

type DoctorServiceOptions = {
  configDir?: string
  homeDir?: string
  projectRoot?: string
}

type DoctorTarget = {
  id: string
  label: string
  kind: DoctorItemKind
  scope: 'user' | 'project'
  filePath: string
  protected: true
}

export class DoctorService {
  private readonly configDir: string
  private readonly homeDir: string
  private readonly projectRoot?: string
  private readonly usesConfigDirOverride: boolean

  constructor(options: DoctorServiceOptions = {}) {
    this.configDir = options.configDir || getClaudeConfigHomeDir()
    this.homeDir = options.homeDir || inferHomeDir(this.configDir)
    this.projectRoot = options.projectRoot
    this.usesConfigDirOverride = Boolean(options.configDir || process.env.CLAUDE_CONFIG_DIR)
  }

  async getReport(): Promise<DoctorReport> {
    const targets = await this.buildTargets()
    const items = await Promise.all(targets.map((target) => this.inspectTarget(target)))
    const protectedSkips = items
      .filter((item) => item.protected)
      .map((item) => ({
        id: item.id,
        path: item.path,
        reason: 'protected' as const,
      }))

    return {
      generatedAt: new Date().toISOString(),
      items,
      protectedSkips,
      summary: {
        total: items.length,
        protectedCount: protectedSkips.length,
        missingCount: items.filter((item) => item.status === 'missing').length,
        invalidCount: items.filter((item) =>
          item.status === 'invalid_json' ||
          item.status === 'invalid_jsonl' ||
          item.status === 'unreadable'
        ).length,
      },
    }
  }

  async repair(targetIds?: string[]): Promise<DoctorRepairResult> {
    const report = await this.getReport()
    const selectedIds = targetIds?.length ? new Set(targetIds) : null
    const selectedItems = selectedIds
      ? report.items.filter((item) => selectedIds.has(item.id))
      : report.items

    const operations: DoctorRepairOperation[] = []
    const skips = selectedItems.map((item) => {
      if (!item.protected && item.status !== 'ok') {
        operations.push({
          id: item.id,
          path: item.path,
          action: 'would_repair',
        })
      }
      return {
        id: item.id,
        path: item.path,
        reason: 'protected' as const,
      }
    })

    return {
      dryRun: true,
      mutated: false,
      operations,
      skips,
      summary: {
        operationCount: operations.length,
        skipCount: skips.length,
      },
    }
  }

  private async buildTargets(): Promise<DoctorTarget[]> {
    const targets: DoctorTarget[] = [
      this.jsonTarget('user-settings', 'User settings', 'user', path.join(this.configDir, 'settings.json')),
      this.jsonTarget(
        'cc-haha-providers',
        'Managed providers',
        'user',
        path.join(this.configDir, 'cc-haha', 'providers.json'),
      ),
      this.jsonTarget(
        'cc-haha-settings',
        'Managed provider settings',
        'user',
        path.join(this.configDir, 'cc-haha', 'settings.json'),
      ),
      this.jsonTarget('adapters', 'Adapters config', 'user', path.join(this.configDir, 'adapters.json')),
      this.jsonTarget(
        'adapter-sessions',
        'Adapter sessions',
        'user',
        path.join(this.configDir, 'adapter-sessions.json'),
      ),
      this.directoryTarget('user-skills', 'User skills', 'user', path.join(this.configDir, 'skills')),
      this.directoryTarget('teams', 'Teams', 'user', path.join(this.configDir, 'teams')),
      this.directoryTarget('plugins', 'Plugins', 'user', path.join(this.configDir, 'plugins')),
      this.directoryTarget(
        'cowork-plugins',
        'Cowork plugins',
        'user',
        path.join(this.configDir, 'cowork_plugins'),
      ),
      this.jsonTarget('user-mcp', 'User MCP config', 'user', this.getUserMcpConfigPath()),
      this.jsonTarget('oauth', 'OAuth tokens', 'user', path.join(this.configDir, 'cc-haha', 'oauth.json')),
      this.jsonTarget(
        'openai-oauth',
        'OpenAI OAuth tokens',
        'user',
        path.join(this.configDir, 'cc-haha', 'openai-oauth.json'),
      ),
    ]

    if (this.projectRoot) {
      targets.push(
        this.jsonTarget(
          'project-settings',
          'Project settings',
          'project',
          path.join(this.projectRoot, '.claude', 'settings.json'),
        ),
        this.directoryTarget(
          'project-skills',
          'Project skills',
          'project',
          path.join(this.projectRoot, '.claude', 'skills'),
        ),
        this.jsonTarget(
          'project-mcp',
          'Project MCP config',
          'project',
          path.join(this.projectRoot, '.mcp.json'),
        ),
      )
    }

    const sessionFiles = await this.listJsonlFiles(path.join(this.configDir, 'projects'))
    for (const filePath of sessionFiles) {
      const relativePath = toPosix(path.relative(this.configDir, filePath))
      targets.push(
        this.jsonlTarget(
          `session-jsonl:${relativePath}`,
          'Session transcript',
          'user',
          filePath,
        ),
      )
    }

    return targets
  }

  private async inspectTarget(target: DoctorTarget): Promise<DoctorReportItem> {
    switch (target.kind) {
      case 'json':
        return this.inspectJsonTarget(target)
      case 'jsonl':
        return this.inspectJsonlTarget(target)
      case 'directory':
        return this.inspectDirectoryTarget(target)
      default:
        return this.inspectMissingTarget(target)
    }
  }

  private async inspectJsonTarget(target: DoctorTarget): Promise<DoctorReportItem> {
    const exists = await this.pathExists(target.filePath)
    if (!exists) return this.inspectMissingTarget(target)

    let raw: string
    try {
      raw = await fs.readFile(target.filePath, 'utf-8')
    } catch (error) {
      return this.inspectUnreadableTarget(target, error)
    }
    const bytes = Buffer.byteLength(raw, 'utf-8')
    if (!raw.trim()) {
      return {
        ...this.baseItem(target),
        exists: true,
        status: 'invalid_json',
        bytes,
        error: 'Empty JSON file',
      }
    }

    try {
      const parsed = JSON.parse(raw)
      return {
        ...this.baseItem(target),
        exists: true,
        status: 'ok',
        bytes,
        entryCount: countJsonEntries(parsed),
      }
    } catch (error) {
      return {
        ...this.baseItem(target),
        exists: true,
        status: 'invalid_json',
        bytes,
        error: this.sanitizeText(error instanceof Error ? error.message : String(error)),
      }
    }
  }

  private async inspectJsonlTarget(target: DoctorTarget): Promise<DoctorReportItem> {
    const exists = await this.pathExists(target.filePath)
    if (!exists) return this.inspectMissingTarget(target)

    let raw: string
    try {
      raw = await fs.readFile(target.filePath, 'utf-8')
    } catch (error) {
      return this.inspectUnreadableTarget(target, error)
    }
    const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0)
    let invalidLineCount = 0

    for (const line of lines) {
      try {
        JSON.parse(line)
      } catch {
        invalidLineCount += 1
      }
    }

    return {
      ...this.baseItem(target),
      exists: true,
      status: invalidLineCount > 0 ? 'invalid_jsonl' : 'ok',
      bytes: Buffer.byteLength(raw, 'utf-8'),
      lineCount: lines.length,
      invalidLineCount,
    }
  }

  private async inspectDirectoryTarget(target: DoctorTarget): Promise<DoctorReportItem> {
    const exists = await this.pathExists(target.filePath)
    if (!exists) return this.inspectMissingTarget(target)

    let entries: Dirent[]
    try {
      entries = await fs.readdir(target.filePath, { withFileTypes: true })
    } catch (error) {
      return this.inspectUnreadableTarget(target, error)
    }
    return {
      ...this.baseItem(target),
      exists: true,
      status: 'ok',
      bytes: 0,
      entryCount: countVisibleEntries(entries),
    }
  }

  private inspectMissingTarget(target: DoctorTarget): DoctorReportItem {
    return {
      ...this.baseItem(target),
      exists: false,
      status: 'missing',
      bytes: 0,
    }
  }

  private inspectUnreadableTarget(target: DoctorTarget, error: unknown): DoctorReportItem {
    return {
      ...this.baseItem(target),
      exists: true,
      status: 'unreadable',
      bytes: 0,
      error: this.sanitizeText(error instanceof Error ? error.message : String(error)),
    }
  }

  private baseItem(target: DoctorTarget): Omit<DoctorReportItem, 'exists' | 'status' | 'bytes'> {
    return {
      id: target.id,
      label: target.label,
      kind: target.kind,
      scope: target.scope,
      path: this.sanitizePath(target.filePath),
      protected: target.protected,
    }
  }

  private sanitizePath(filePath: string): string {
    if (this.projectRoot && isWithinRoot(filePath, this.projectRoot)) {
      return this.withAlias('<project>', filePath, this.projectRoot)
    }
    if (isWithinRoot(filePath, this.configDir)) {
      return this.withAlias('~/.claude', filePath, this.configDir)
    }
    if (isWithinRoot(filePath, this.homeDir)) {
      return this.withAlias('~', filePath, this.homeDir)
    }
    return this.sanitizeText(filePath)
  }

  private sanitizeText(value: string): string {
    let sanitized = diagnosticsService.sanitizeString(value)
    const replacements: Array<[string | undefined, string]> = [
      [this.projectRoot, '<project>'],
      [this.configDir, '~/.claude'],
      [this.homeDir, '~'],
    ]

    for (const [from, to] of replacements) {
      if (!from) continue
      sanitized = sanitized.split(from).join(to)
    }
    return sanitized
  }

  private getUserMcpConfigPath(): string {
    if (this.usesConfigDirOverride) {
      return path.join(this.configDir, '.claude.json')
    }
    return path.join(this.homeDir, '.claude.json')
  }

  private async listJsonlFiles(rootDir: string): Promise<string[]> {
    const exists = await this.pathExists(rootDir)
    if (!exists) return []

    const results: string[] = []
    const stack = [rootDir]

    while (stack.length > 0) {
      const current = stack.pop()
      if (!current) continue
      let entries: Dirent[]
      try {
        entries = await fs.readdir(current, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        const fullPath = path.join(current, entry.name)
        if (entry.isDirectory()) {
          stack.push(fullPath)
          continue
        }
        if (entry.isFile() && fullPath.endsWith('.jsonl')) {
          results.push(fullPath)
        }
      }
    }

    results.sort((left, right) => left.localeCompare(right))
    return results
  }

  private async pathExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath)
      return true
    } catch {
      return false
    }
  }

  private jsonTarget(
    id: string,
    label: string,
    scope: 'user' | 'project',
    filePath: string,
  ): DoctorTarget {
    return { id, label, kind: 'json', scope, filePath, protected: true }
  }

  private jsonlTarget(
    id: string,
    label: string,
    scope: 'user' | 'project',
    filePath: string,
  ): DoctorTarget {
    return { id, label, kind: 'jsonl', scope, filePath, protected: true }
  }

  private directoryTarget(
    id: string,
    label: string,
    scope: 'user' | 'project',
    filePath: string,
  ): DoctorTarget {
    return { id, label, kind: 'directory', scope, filePath, protected: true }
  }

  private withAlias(alias: string, filePath: string, root: string): string {
    const relativePath = path.relative(root, filePath)
    if (!relativePath) return alias
    return `${alias}/${toPosix(relativePath)}`
  }
}

function countJsonEntries(value: unknown): number {
  if (Array.isArray(value)) return value.length
  if (value && typeof value === 'object') return Object.keys(value as Record<string, unknown>).length
  if (value === null || value === undefined) return 0
  return 1
}

function countVisibleEntries(entries: Dirent[]): number {
  return entries.filter((entry) => entry.name !== '.DS_Store').length
}

function inferHomeDir(configDir: string): string {
  if (path.basename(configDir) === '.claude') {
    return path.dirname(configDir)
  }
  return os.homedir()
}

function isWithinRoot(filePath: string, root: string): boolean {
  const relativePath = path.relative(root, filePath)
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/')
}
