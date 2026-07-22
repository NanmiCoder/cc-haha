/**
 * AgentService — safe CRUD for official Markdown agent definitions.
 *
 * User agents live under CLAUDE_CONFIG_DIR/agents. Project agents live under
 * the current project's .claude/agents directory. Existing agents may carry an
 * exact loader-discovered target path so nested files and files whose basename
 * differs from the frontmatter name remain editable without broad path access.
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import YAML from 'yaml'
import { getCwd } from '../../utils/cwd.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { findCanonicalGitRoot, findGitRoot } from '../../utils/git.js'
import { getAgentDefinitionsWithOverrides } from '../../tools/AgentTool/loadAgentsDir.js'
import { ApiError } from '../middleware/errorHandler.js'

export type AgentScope = 'user' | 'project'

export type AgentDefinition = {
  name: string
  description?: string
  model?: string
  effort?: string | number
  tools?: string[]
  systemPrompt?: string
  color?: string
}

export type AgentUpdate = Omit<
  Partial<AgentDefinition>,
  'model' | 'effort' | 'tools' | 'color'
> & {
  model?: string | null
  effort?: string | number | null
  tools?: string[] | null
  color?: string | null
}

export type AgentMutationContext = {
  scope: AgentScope
  cwd?: string
  target?: string
}

export type AgentMutationResult = {
  agent: AgentDefinition
  agentsDir: string
  target: string
}

type ParsedAgentFile = {
  document: ReturnType<typeof YAML.parseDocument>
  body: string
  identity: FileIdentity
}

type FileIdentity = Pick<
  Awaited<ReturnType<typeof fs.lstat>>,
  'dev' | 'ino' | 'size' | 'mtimeMs'
>

type ResolvedAgentTarget = {
  agentsDir: string
  filePath: string
}

const AGENT_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/
const FRONTMATTER_PATTERN =
  /^---[\t ]*\r?\n([\s\S]*?)\r?\n---[\t ]*(?:\r?\n|$)/
const agentMutationTails = new Map<string, Promise<void>>()

export class AgentService {
  async resolveAgentsDir(context: AgentMutationContext): Promise<string> {
    if (context.scope === 'user') {
      return this.resolveUserAgentsDir(false)
    }
    if (context.scope !== 'project') {
      throw ApiError.badRequest('Agent scope must be "user" or "project"')
    }
    return this.resolveProjectAgentsDir(context, false)
  }

  async getAgent(
    name: string,
    context: AgentMutationContext,
  ): Promise<AgentMutationResult | null> {
    this.assertValidName(name)
    const { agentsDir, filePath } = await this.resolveMutationTarget(name, context)
    const parsed = await this.readAgentFile(filePath, true)
    if (!parsed) return null
    this.assertTargetIdentity(parsed, name)
    return {
      agent: this.toAgentDefinition(parsed, name),
      agentsDir,
      target: filePath,
    }
  }

  async createAgent(
    agent: AgentDefinition,
    context: AgentMutationContext,
  ): Promise<AgentMutationResult> {
    this.assertValidName(agent.name)
    this.assertRequiredText(agent.description, 'description')
    this.assertRequiredText(agent.systemPrompt, 'systemPrompt')

    const agentsDir = await this.resolveAgentsDirForCreate(context)
    const filePath = this.resolveAgentPath(agentsDir, agent.name)

    const document = new YAML.Document()
    document.contents = document.createNode({ name: agent.name })
    this.applyAgentFields(document, agent, true)
    const content = this.renderAgentFile(
      document,
      `\n${agent.systemPrompt!.trim()}\n`,
    )

    return withAgentMutationLock(filePath, async () => {
      await this.assertSafeMutationDirectory(agentsDir)
      await this.atomicCreate(filePath, content)
      return { agent: { ...agent }, agentsDir, target: filePath }
    })
  }

  async updateAgent(
    name: string,
    updates: AgentUpdate,
    context: AgentMutationContext,
  ): Promise<AgentMutationResult> {
    this.assertValidName(name)
    if (updates.name !== undefined && updates.name !== name) {
      throw ApiError.badRequest('Agent name cannot be changed')
    }
    if (Object.hasOwn(updates, 'description')) {
      this.assertRequiredText(updates.description, 'description')
    }
    if (Object.hasOwn(updates, 'systemPrompt')) {
      if (typeof updates.systemPrompt !== 'string') {
        throw ApiError.badRequest('Agent systemPrompt must be a string')
      }
    }

    const initialTarget = await this.resolveMutationTarget(name, context)
    return withAgentMutationLock(initialTarget.filePath, async () => {
      const { agentsDir, filePath } = await this.resolveMutationTarget(
        name,
        context,
      )
      if (filePath !== initialTarget.filePath) {
        throw ApiError.conflict('Agent target changed before the update started')
      }
      const parsed = await this.readAgentFile(filePath, true)
      if (!parsed) {
        throw ApiError.notFound(
          `Agent not found in ${context.scope} scope: ${name}`,
        )
      }
      this.assertTargetIdentity(parsed, name)

      // Keep the persisted identity fixed to the URL slug. Unknown frontmatter
      // keys remain on the Document.
      parsed.document.set('name', name)
      this.applyAgentFields(parsed.document, updates, false)
      const body = Object.hasOwn(updates, 'systemPrompt')
        ? `\n${updates.systemPrompt!.trim()}\n`
        : parsed.body
      await this.atomicReplace(
        filePath,
        this.renderAgentFile(parsed.document, body),
        parsed.identity,
      )

      const updated = await this.readAgentFile(filePath, true)
      if (!updated) {
        throw ApiError.internal(`Failed to read updated agent: ${name}`)
      }
      return {
        agent: this.toAgentDefinition(updated, name),
        agentsDir,
        target: filePath,
      }
    })
  }

  async deleteAgent(
    name: string,
    context: AgentMutationContext,
  ): Promise<{ agentsDir: string }> {
    this.assertValidName(name)
    const initialTarget = await this.resolveMutationTarget(name, context)
    return withAgentMutationLock(initialTarget.filePath, async () => {
      const { agentsDir, filePath } = await this.resolveMutationTarget(
        name,
        context,
      )
      if (filePath !== initialTarget.filePath) {
        throw ApiError.conflict('Agent target changed before deletion started')
      }
      const parsed = await this.readAgentFile(filePath, true)
      if (!parsed) {
        throw ApiError.notFound(
          `Agent not found in ${context.scope} scope: ${name}`,
        )
      }
      this.assertTargetIdentity(parsed, name)
      await this.assertFileIdentity(filePath, parsed.identity)

      const tombstone = path.join(
        path.dirname(filePath),
        `.${name}.${process.pid}.${randomUUID()}.deleted`,
      )
      await fs.rename(filePath, tombstone)
      await fs.unlink(tombstone)
      return { agentsDir }
    })
  }

  assertValidName(name: string): void {
    if (!AGENT_SLUG_PATTERN.test(name)) {
      throw ApiError.badRequest(
        'Agent name must be a lowercase slug using only letters, numbers, "-", or "_" (max 64 characters)',
      )
    }
  }

  private async resolveAgentsDirForCreate(
    context: AgentMutationContext,
  ): Promise<string> {
    if (context.scope === 'user') {
      return this.resolveUserAgentsDir(true)
    }
    if (context.scope !== 'project') {
      throw ApiError.badRequest('Agent scope must be "user" or "project"')
    }
    return this.resolveProjectAgentsDir(context, true)
  }

  private async resolveUserAgentsDir(create: boolean): Promise<string> {
    const configuredRoot = path.resolve(getClaudeConfigHomeDir())
    if (create) {
      await fs.mkdir(configuredRoot, { recursive: true })
    }

    let configuredStat: Awaited<ReturnType<typeof fs.lstat>>
    try {
      configuredStat = await fs.lstat(configuredRoot)
    } catch (error) {
      if (!create && isNodeError(error, 'ENOENT')) {
        return path.join(configuredRoot, 'agents')
      }
      throw error
    }

    // CLAUDE_CONFIG_DIR itself is an explicit trust anchor and may be a
    // deliberate symlink. Its agents child must still be a real directory.
    const rootStat = configuredStat.isSymbolicLink()
      ? await fs.stat(configuredRoot)
      : configuredStat
    if (!rootStat.isDirectory()) {
      throw unsafeAgentDirectory('Claude config root must be a directory')
    }
    const realConfiguredRoot = await fs.realpath(configuredRoot)
    return this.resolveDirectoryChain(realConfiguredRoot, ['agents'], create)
  }

  private async resolveProjectAgentsDir(
    context: AgentMutationContext,
    create: boolean,
  ): Promise<string> {
    const requestedCwd = context.cwd?.trim() || getCwd()
    let realCwd: string
    try {
      realCwd = await fs.realpath(path.resolve(requestedCwd))
      if (!(await fs.stat(realCwd)).isDirectory()) {
        throw new Error('not a directory')
      }
    } catch {
      throw ApiError.badRequest('Agent project cwd must be an existing directory')
    }

    // Agent CRUD must observe repository boundaries as they exist now. A
    // long-running desktop session may have resolved this directory before a
    // nested repository was initialized, leaving findGitRoot's LRU entry
    // pointing at an ancestor repository.
    findGitRoot.cache.delete(realCwd)
    const projectRoot = findGitRoot(realCwd) ?? realCwd
    const realProjectRoot = await fs.realpath(projectRoot)
    const worktreeAgentsCandidate = path.join(
      realProjectRoot,
      '.claude',
      'agents',
    )
    await this.assertDisjointProjectAgentsRoot(worktreeAgentsCandidate)
    if (create) {
      const canonicalRoot = findCanonicalGitRoot(realCwd)
      if (canonicalRoot) {
        const realCanonicalRoot = await fs.realpath(canonicalRoot)
        if (realCanonicalRoot !== realProjectRoot) {
          const mainAgentsCandidate = path.join(
            realCanonicalRoot,
            '.claude',
            'agents',
          )
          await this.assertDisjointProjectAgentsRoot(mainAgentsCandidate)
          const worktreeAgentsDir = await this.resolveDirectoryChain(
            realProjectRoot,
            ['.claude', 'agents'],
            false,
          )
          if (!(await isDirectoryWithoutSymlink(worktreeAgentsDir))) {
            const mainAgentsDir = await this.resolveDirectoryChain(
              realCanonicalRoot,
              ['.claude', 'agents'],
              false,
            )
            if (await isDirectoryWithoutSymlink(mainAgentsDir)) {
              await this.assertDisjointProjectAgentsRoot(mainAgentsDir)
              return mainAgentsDir
            }
          }
        }
      }
    }
    const resolvedAgentsDir = await this.resolveDirectoryChain(
      realProjectRoot,
      ['.claude', 'agents'],
      create,
    )
    await this.assertDisjointProjectAgentsRoot(resolvedAgentsDir)
    return resolvedAgentsDir
  }

  private async resolveDirectoryChain(
    realAnchor: string,
    segments: string[],
    create: boolean,
  ): Promise<string> {
    let current = realAnchor
    for (const [index, segment] of segments.entries()) {
      const candidate = path.join(current, segment)
      let candidateStat: Awaited<ReturnType<typeof fs.lstat>>
      try {
        candidateStat = await fs.lstat(candidate)
      } catch (error) {
        if (!isNodeError(error, 'ENOENT')) throw error
        if (!create) {
          return path.join(current, ...segments.slice(index))
        }
        try {
          await fs.mkdir(candidate)
        } catch (mkdirError) {
          if (!isNodeError(mkdirError, 'EEXIST')) throw mkdirError
        }
        candidateStat = await fs.lstat(candidate)
      }

      if (candidateStat.isSymbolicLink() || !candidateStat.isDirectory()) {
        throw unsafeAgentDirectory(
          `Agent directory component must be a real directory: ${segment}`,
        )
      }
      const realCandidate = await fs.realpath(candidate)
      if (
        realCandidate !== realAnchor &&
        !isPathWithin(realAnchor, realCandidate)
      ) {
        throw unsafeAgentDirectory('Agent directory escapes its trusted root')
      }
      current = realCandidate
    }
    return current
  }

  private async assertSafeMutationDirectory(agentsDir: string): Promise<void> {
    const directoryStat = await fs.lstat(agentsDir)
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      throw unsafeAgentDirectory('Agent directory must be a real directory')
    }
    if ((await fs.realpath(agentsDir)) !== agentsDir) {
      throw unsafeAgentDirectory('Agent directory changed before mutation')
    }
  }

  private async assertDisjointProjectAgentsRoot(
    projectAgentsDir: string,
  ): Promise<void> {
    const [canonicalProjectRoot, canonicalUserRoot] = await Promise.all([
      canonicalizePotentialPath(projectAgentsDir),
      canonicalizePotentialPath(
        path.resolve(getClaudeConfigHomeDir(), 'agents'),
      ),
    ])
    if (pathsOverlap(canonicalProjectRoot, canonicalUserRoot)) {
      throw new ApiError(
        403,
        'Project and user agent roots must not overlap',
        'AGENT_SCOPE_COLLISION',
      )
    }
  }

  private resolveAgentPath(agentsDir: string, name: string): string {
    const filePath = path.join(agentsDir, `${name}.md`)
    if (path.dirname(filePath) !== agentsDir) {
      throw ApiError.badRequest('Invalid agent name')
    }
    return filePath
  }

  private async resolveMutationTarget(
    name: string,
    context: AgentMutationContext,
  ): Promise<ResolvedAgentTarget> {
    if (!context.target) {
      const agentsDir = await this.resolveAgentsDir(context)
      return {
        agentsDir,
        filePath: this.resolveAgentPath(agentsDir, name),
      }
    }

    if (!path.isAbsolute(context.target) || !context.target.endsWith('.md')) {
      throw ApiError.badRequest('Agent target must be an absolute Markdown file path')
    }

    const requestedStat = await this.safeAgentFileStat(context.target)
    if (!requestedStat) {
      throw ApiError.notFound(`Agent target not found: ${name}`)
    }

    let realTarget: string
    try {
      realTarget = await fs.realpath(context.target)
    } catch {
      throw ApiError.notFound(`Agent target not found: ${name}`)
    }

    const realTargetStat = await this.safeAgentFileStat(realTarget)
    if (!realTargetStat) {
      throw ApiError.notFound(`Agent target not found: ${name}`)
    }
    this.assertMatchingIdentity(
      toFileIdentity(realTargetStat),
      toFileIdentity(requestedStat),
    )

    const allowedRoots = await this.resolveAllowedTargetRoots(context)
    await this.assertLoadedTargetIdentity(name, context, realTarget)
    for (const agentsDir of allowedRoots) {
      let realRoot: string
      try {
        realRoot = await fs.realpath(agentsDir)
      } catch {
        continue
      }
      if (isPathWithin(realRoot, realTarget)) {
        return { agentsDir, filePath: realTarget }
      }
    }

    throw new ApiError(
      403,
      'Agent target does not belong to the requested scope',
      'AGENT_SCOPE_MISMATCH',
    )
  }

  private async resolveAllowedTargetRoots(
    context: AgentMutationContext,
  ): Promise<string[]> {
    if (context.scope === 'user') {
      return [await this.resolveUserAgentsDir(false)]
    }
    if (context.scope !== 'project') {
      throw ApiError.badRequest('Agent scope must be "user" or "project"')
    }

    const requestedCwd = context.cwd?.trim() || getCwd()
    let realCwd: string
    try {
      realCwd = await fs.realpath(path.resolve(requestedCwd))
      if (!(await fs.stat(realCwd)).isDirectory()) {
        throw new Error('not a directory')
      }
    } catch {
      throw ApiError.badRequest('Agent project cwd must be an existing directory')
    }

    const projectRoot = findGitRoot(realCwd) ?? realCwd
    const realProjectRoot = await fs.realpath(projectRoot)
    await this.assertDisjointProjectAgentsRoot(
      path.join(realProjectRoot, '.claude', 'agents'),
    )
    const canonicalRoot = findCanonicalGitRoot(realCwd)
    if (canonicalRoot) {
      const realCanonicalRoot = await fs.realpath(canonicalRoot)
      if (realCanonicalRoot !== realProjectRoot) {
        await this.assertDisjointProjectAgentsRoot(
          path.join(realCanonicalRoot, '.claude', 'agents'),
        )
      }
    }

    const { allAgents } = await getAgentDefinitionsWithOverrides(realCwd)
    const roots = new Set<string>()
    for (const agent of allAgents) {
      if (agent.source !== 'projectSettings' || !agent.baseDir) continue
      const safeRoot = await this.resolveLoadedProjectAgentsDir(agent.baseDir)
      if (safeRoot) roots.add(safeRoot)
    }
    return Array.from(roots)
  }

  private async resolveLoadedProjectAgentsDir(
    baseDir: string,
  ): Promise<string | null> {
    const absoluteBaseDir = path.resolve(baseDir)
    if (
      path.basename(absoluteBaseDir) !== 'agents' ||
      path.basename(path.dirname(absoluteBaseDir)) !== '.claude'
    ) {
      return null
    }

    const owningRoot = path.dirname(path.dirname(absoluteBaseDir))
    let realOwningRoot: string
    try {
      realOwningRoot = await fs.realpath(owningRoot)
      if (!(await fs.stat(realOwningRoot)).isDirectory()) return null
      const safeRoot = await this.resolveDirectoryChain(
        realOwningRoot,
        ['.claude', 'agents'],
        false,
      )
      await this.assertDisjointProjectAgentsRoot(safeRoot)
      return safeRoot
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.code === 'UNSAFE_AGENT_DIRECTORY'
      ) {
        return null
      }
      if (isNodeError(error, 'ENOENT')) return null
      throw error
    }
  }

  private async assertLoadedTargetIdentity(
    name: string,
    context: AgentMutationContext,
    realTarget: string,
  ): Promise<void> {
    const cwd = context.cwd?.trim() || getCwd()
    const expectedSource =
      context.scope === 'user' ? 'userSettings' : 'projectSettings'
    const { allAgents } = await getAgentDefinitionsWithOverrides(cwd)
    for (const agent of allAgents) {
      if (agent.source !== expectedSource || !agent.sourceFilePath) {
        continue
      }
      let sourceTarget: string
      try {
        sourceTarget = await fs.realpath(agent.sourceFilePath)
      } catch {
        continue
      }
      if (sourceTarget !== realTarget) continue
      if (agent.agentType === name) return
      throw ApiError.conflict(
        `Agent target identity does not match requested agent: ${name}`,
      )
    }
    throw new ApiError(
      403,
      'Agent target does not belong to the requested scope',
      'AGENT_SCOPE_MISMATCH',
    )
  }

  private async readAgentFile(
    filePath: string,
    failIfInvalid: boolean,
  ): Promise<ParsedAgentFile | null> {
    const fileStat = await this.safeAgentFileStat(filePath)
    if (!fileStat) return null

    const raw = await fs.readFile(filePath, 'utf-8')
    await this.assertFileIdentity(filePath, toFileIdentity(fileStat))
    const match = raw.match(FRONTMATTER_PATTERN)
    if (!match) {
      if (failIfInvalid) {
        throw ApiError.badRequest('Agent file must contain YAML frontmatter')
      }
      return null
    }

    const document = YAML.parseDocument(match[1] ?? '')
    if (document.errors.length > 0 || !document.contents) {
      if (failIfInvalid) {
        throw ApiError.badRequest('Agent file contains invalid YAML frontmatter')
      }
      return null
    }
    const value = document.toJS()
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      if (failIfInvalid) {
        throw ApiError.badRequest('Agent frontmatter must be a YAML mapping')
      }
      return null
    }

    return {
      document,
      body: raw.slice(match[0].length),
      identity: toFileIdentity(fileStat),
    }
  }

  private assertTargetIdentity(parsed: ParsedAgentFile, expectedName: string): void {
    const data = parsed.document.toJS() as Record<string, unknown>
    if (data.name !== expectedName) {
      throw ApiError.conflict(
        `Agent target identity does not match requested agent: ${expectedName}`,
      )
    }
  }

  private async safeAgentFileStat(
    filePath: string,
  ): Promise<Awaited<ReturnType<typeof fs.lstat>> | null> {
    try {
      const fileStat = await fs.lstat(filePath)
      if (!fileStat.isFile()) {
        throw new ApiError(
          403,
          'Only regular Markdown agent files are editable',
          'READ_ONLY_AGENT',
        )
      }
      return fileStat
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return null
      throw error
    }
  }

  private applyAgentFields(
    document: ReturnType<typeof YAML.parseDocument>,
    fields: AgentUpdate,
    includeAll: boolean,
  ): void {
    const setIfPresent = (key: keyof AgentDefinition) => {
      if (includeAll ? fields[key] !== undefined : Object.hasOwn(fields, key)) {
        const value = fields[key]
        if (value === null) {
          document.delete(key)
        } else {
          document.set(key, value as string | number | string[])
        }
      }
    }

    setIfPresent('description')
    setIfPresent('model')
    setIfPresent('effort')
    setIfPresent('tools')
    setIfPresent('color')
  }

  private toAgentDefinition(
    parsed: ParsedAgentFile,
    fallbackName: string,
  ): AgentDefinition {
    const data = parsed.document.toJS() as Record<string, unknown>
    return {
      name: typeof data.name === 'string' ? data.name : fallbackName,
      description:
        typeof data.description === 'string' ? data.description : undefined,
      model: typeof data.model === 'string' ? data.model : undefined,
      effort:
        typeof data.effort === 'string' || typeof data.effort === 'number'
          ? data.effort
          : undefined,
      tools: Array.isArray(data.tools)
        ? data.tools.filter((tool): tool is string => typeof tool === 'string')
        : undefined,
      systemPrompt: parsed.body.trim() || undefined,
      color: typeof data.color === 'string' ? data.color : undefined,
    }
  }

  private renderAgentFile(
    document: ReturnType<typeof YAML.parseDocument>,
    body: string,
  ): string {
    const frontmatter = document.toString({ lineWidth: 0 }).trimEnd()
    return `---\n${frontmatter}\n---\n${body}`
  }

  private async atomicCreate(filePath: string, content: string): Promise<void> {
    const tempPath = this.getTempPath(filePath)
    try {
      await this.writeTempFile(tempPath, content, 0o600)
      try {
        // A hard link publishes a complete same-directory temp file without
        // overwriting a concurrently-created agent.
        await fs.link(tempPath, filePath)
      } catch (error) {
        if (isNodeError(error, 'EEXIST')) {
          throw ApiError.conflict(
            `Agent already exists: ${path.basename(filePath, '.md')}`,
          )
        }
        throw error
      }
    } finally {
      await fs.rm(tempPath, { force: true }).catch(() => undefined)
    }
  }

  private async atomicReplace(
    filePath: string,
    content: string,
    expectedIdentity: FileIdentity,
  ): Promise<void> {
    const currentStat = await this.safeAgentFileStat(filePath)
    if (!currentStat) {
      throw ApiError.notFound(
        `Agent not found: ${path.basename(filePath, '.md')}`,
      )
    }
    this.assertMatchingIdentity(toFileIdentity(currentStat), expectedIdentity)

    const tempPath = this.getTempPath(filePath)
    try {
      await this.writeTempFile(tempPath, content, currentStat.mode)
      await this.assertFileIdentity(filePath, expectedIdentity)
      await fs.rename(tempPath, filePath)
    } finally {
      await fs.rm(tempPath, { force: true }).catch(() => undefined)
    }
  }

  private async assertFileIdentity(
    filePath: string,
    expectedIdentity: FileIdentity,
  ): Promise<void> {
    const currentStat = await this.safeAgentFileStat(filePath)
    if (!currentStat) {
      throw ApiError.notFound(
        `Agent not found: ${path.basename(filePath, '.md')}`,
      )
    }
    this.assertMatchingIdentity(toFileIdentity(currentStat), expectedIdentity)
  }

  private assertMatchingIdentity(
    current: FileIdentity,
    expected: FileIdentity,
  ): void {
    if (
      current.dev !== expected.dev ||
      current.ino !== expected.ino ||
      current.size !== expected.size ||
      current.mtimeMs !== expected.mtimeMs
    ) {
      throw ApiError.conflict('Agent target changed while the update was in progress')
    }
  }

  private async writeTempFile(
    tempPath: string,
    content: string,
    mode: number,
  ): Promise<void> {
    const handle = await fs.open(tempPath, 'wx', mode)
    try {
      await handle.writeFile(content, 'utf-8')
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  private getTempPath(filePath: string): string {
    return path.join(
      path.dirname(filePath),
      `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
    )
  }

  private assertRequiredText(
    value: string | undefined,
    field: string,
  ): asserts value is string {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw ApiError.badRequest(`Agent ${field} must be a non-empty string`)
    }
  }
}

async function withAgentMutationLock<T>(
  canonicalTarget: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = path.normalize(canonicalTarget)
  const previous = agentMutationTails.get(key)
  let release!: () => void
  const current = new Promise<void>(resolve => {
    release = resolve
  })
  agentMutationTails.set(key, current)

  if (previous) await previous
  try {
    return await operation()
  } finally {
    release()
    if (agentMutationTails.get(key) === current) {
      agentMutationTails.delete(key)
    }
  }
}

function unsafeAgentDirectory(message: string): ApiError {
  return new ApiError(403, message, 'UNSAFE_AGENT_DIRECTORY')
}

async function isDirectoryWithoutSymlink(directory: string): Promise<boolean> {
  try {
    const directoryStat = await fs.lstat(directory)
    return !directoryStat.isSymbolicLink() && directoryStat.isDirectory()
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false
    throw error
  }
}

async function canonicalizePotentialPath(filePath: string): Promise<string> {
  let existingAncestor = path.resolve(filePath)
  const missingSegments: string[] = []
  while (true) {
    try {
      return path.join(await fs.realpath(existingAncestor), ...missingSegments)
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error
      const parent = path.dirname(existingAncestor)
      if (parent === existingAncestor) throw error
      missingSegments.unshift(path.basename(existingAncestor))
      existingAncestor = parent
    }
  }
}

function pathsOverlap(first: string, second: string): boolean {
  return (
    first === second ||
    isPathWithin(first, second) ||
    isPathWithin(second, first)
  )
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === code
  )
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return (
    relative.length > 0 &&
    !path.isAbsolute(relative) &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`)
  )
}

function toFileIdentity(
  fileStat: Awaited<ReturnType<typeof fs.lstat>>,
): FileIdentity {
  return {
    dev: fileStat.dev,
    ino: fileStat.ino,
    size: fileStat.size,
    mtimeMs: fileStat.mtimeMs,
  }
}
