/**
 * Skills REST API
 *
 * GET /api/skills              — List all installed skills (metadata only)
 * GET /api/skills/detail       — Full skill data (tree + files)
 *       ?source=user&name=xxx
 */

import * as path from 'path'
import * as fs from 'fs/promises'
import { parseFrontmatter } from '../../utils/frontmatterParser.js'
import { getCwd } from '../../utils/cwd.js'
import {
  getProjectSkillRoots,
  getUserSkillRoots,
  outranksClaimedSkill,
  type SkillRoot,
  type SkillRootFlavor,
} from '../../skills/skillRoots.js'
import { clearInstalledPluginsCache } from '../../utils/plugins/installedPluginsManager.js'
import { clearPluginCache, loadAllPlugins, loadAllPluginsCacheOnly } from '../../utils/plugins/pluginLoader.js'
import { getSkillDirCommands } from '../../skills/loadSkillsDir.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import type { LoadedPlugin } from '../../types/plugin.js'
import { ApiError, errorResponse } from '../middleware/errorHandler.js'
import { readMarketMeta } from '../services/market/marketService.js'

// ─── Types ───────────────────────────────────────────────────────────────────

type SkillMeta = {
  name: string
  displayName?: string
  description: string
  source: 'user' | 'project' | 'plugin'
  /**
   * Which directory convention the skill was found in — `.claude/skills` or the
   * cross-client `.agents/skills`. Absent for plugin skills.
   */
  rootFlavor?: SkillRootFlavor
  userInvocable: boolean
  version?: string
  contentLength: number
  hasDirectory: boolean
  pluginName?: string
}

type SkillSource = SkillMeta['source']

type FileTreeNode = {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: FileTreeNode[]
}

type SkillFile = {
  path: string
  content: string
  language: string
  frontmatter?: Record<string, unknown>
  body?: string
  isEntry?: boolean
}

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_FILES = 50
const MAX_FILE_SIZE = 100 * 1024 // 100 KB
const SKIP_ENTRIES = new Set(['node_modules', '.git', '__pycache__', '.DS_Store'])

const LANG_MAP: Record<string, string> = {
  md: 'markdown', ts: 'typescript', tsx: 'typescript',
  js: 'javascript', jsx: 'javascript', json: 'json',
  yaml: 'yaml', yml: 'yaml', sh: 'bash', bash: 'bash',
  py: 'python', toml: 'toml', css: 'css', html: 'html',
  txt: 'text', xml: 'xml', sql: 'sql', rs: 'rust', go: 'go',
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function detectLanguage(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || ''
  return LANG_MAP[ext] || 'text'
}

function normalizeFrontmatter(content: string, sourcePath?: string): {
  frontmatter: Record<string, unknown>
  body: string
} {
  const parsed = parseFrontmatter(content, sourcePath)
  return {
    frontmatter: parsed.frontmatter as Record<string, unknown>,
    body: parsed.content,
  }
}

function getRequestedCwd(url: URL): string {
  return url.searchParams.get('cwd') || getCwd()
}

async function loadSkillMeta(
  skillDir: string,
  skillName: string,
  source: SkillSource,
  pluginName?: string,
  rootFlavor?: SkillRootFlavor,
): Promise<SkillMeta | null> {
  const skillFile = path.join(skillDir, 'SKILL.md')
  try {
    const raw = await fs.readFile(skillFile, 'utf-8')
    const { frontmatter, body } = normalizeFrontmatter(raw, skillFile)

    const description =
      (frontmatter.description as string) ||
      body
        .split('\n')
        .find((l) => l.trim().length > 0)
        ?.trim() ||
      'No description'

    return {
      name: skillName,
      displayName: (frontmatter.name as string) || undefined,
      description,
      source,
      rootFlavor,
      userInvocable: frontmatter['user-invocable'] !== false,
      version: frontmatter.version != null ? String(frontmatter.version) : undefined,
      contentLength: raw.length,
      hasDirectory: true,
      pluginName,
    }
  } catch {
    return null
  }
}

async function buildFileTree(
  dirPath: string,
): Promise<{ tree: FileTreeNode[]; files: SkillFile[] }> {
  const tree: FileTreeNode[] = []
  const files: SkillFile[] = []
  let fileCount = 0

  async function walk(currentPath: string, nodes: FileTreeNode[]) {
    if (fileCount >= MAX_FILES) return

    let entries: import('fs').Dirent[]
    try {
      entries = await fs.readdir(currentPath, { withFileTypes: true })
    } catch {
      return
    }

    // directories first, then alphabetical
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
      return a.name.localeCompare(b.name)
    })

    for (const entry of entries) {
      if (fileCount >= MAX_FILES) break
      if (SKIP_ENTRIES.has(entry.name) || entry.name.startsWith('.')) continue

      const fullPath = path.join(currentPath, entry.name)
      const relPath = path.relative(dirPath, fullPath)

      if (entry.isDirectory()) {
        const node: FileTreeNode = {
          name: entry.name,
          path: relPath,
          type: 'directory',
          children: [],
        }
        nodes.push(node)
        await walk(fullPath, node.children!)
        if (node.children!.length === 0) delete node.children
      } else if (entry.isFile()) {
        nodes.push({ name: entry.name, path: relPath, type: 'file' })

        try {
          const stat = await fs.stat(fullPath)
          if (stat.size <= MAX_FILE_SIZE) {
            const content = await fs.readFile(fullPath, 'utf-8')
            const language = detectLanguage(entry.name)
            const isEntry = relPath === 'SKILL.md'

            if (isEntry && language === 'markdown') {
              const { frontmatter, body } = normalizeFrontmatter(content, fullPath)
              files.push({
                path: relPath,
                content: body,
                body,
                frontmatter,
                language,
                isEntry: true,
              })
            } else {
              files.push({
                path: relPath,
                content,
                language,
                isEntry: false,
              })
            }
            fileCount++
          }
        } catch {
          // skip unreadable files
        }
      }
    }
  }

  await walk(dirPath, tree)
  return { tree, files }
}

async function collectSkillsFromRoots(
  skillRoots: SkillRoot[],
  source: SkillSource,
): Promise<SkillMeta[]> {
  const skills: SkillMeta[] = []
  const seenNames = new Set<string>()

  for (const root of skillRoots) {
    let entries: import('fs').Dirent[]
    try {
      entries = await fs.readdir(root.path, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (
        (!entry.isDirectory() && !entry.isSymbolicLink()) ||
        entry.name.startsWith('.') ||
        // First root wins. Roots are ordered `.claude` before `.agents`, so a
        // skill present in both conventions is reported once, as `.claude`.
        seenNames.has(entry.name)
      ) {
        continue
      }

      const meta = await loadSkillMeta(
        path.join(root.path, entry.name),
        entry.name,
        source,
        undefined,
        root.flavor,
      )
      if (!meta) continue

      seenNames.add(entry.name)
      skills.push(meta)
    }
  }

  return skills
}

async function resolveSkillDir(
  source: SkillSource,
  name: string,
  cwd: string,
): Promise<{ skillDir: string; rootFlavor: SkillRootFlavor } | null> {
  const skillRoots =
    source === 'user'
      ? getUserSkillRoots()
      : source === 'project'
        ? getProjectSkillRoots(cwd)
        : []

  for (const root of skillRoots) {
    const skillDir = path.join(root.path, name)
    try {
      const stat = await fs.stat(skillDir)
      if (stat.isDirectory()) {
        // Same first-wins order as the listing, so detail and list agree on
        // which copy of a colliding name they describe.
        return { skillDir, rootFlavor: root.flavor }
      }
    } catch {
      // Try the next candidate root.
    }
  }

  return null
}

type PluginSkillLocation = {
  skillDir: string
  pluginName: string
}

export type SkillSlashCommand = {
  name: string
  description: string
  argumentHint?: string
  kind: 'command' | 'skill'
  source?: SkillSource
}

async function collectLegacySlashCommands(cwd: string): Promise<SkillSlashCommand[]> {
  const commands = await getSkillDirCommands(cwd)
  return commands
    .filter((command) =>
      command.type === 'prompt' &&
      command.loadedFrom === 'commands_DEPRECATED' &&
      command.userInvocable !== false &&
      !command.isHidden)
    .map((command) => ({
      name: command.name,
      description: command.description || '',
      ...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
      kind: 'command' as const,
    }))
}

function buildPluginSkillName(pluginName: string, skillDir: string): string {
  return `${pluginName}:${path.basename(skillDir)}`
}

async function collectPluginSkillDirectories(): Promise<Map<string, PluginSkillLocation>> {
  const locations = new Map<string, PluginSkillLocation>()

  let enabledPlugins: LoadedPlugin[]
  try {
    resetSettingsCache()
    clearInstalledPluginsCache()
    clearPluginCache('skills-api-external-plugin-state')

    const result = await loadAllPluginsCacheOnly()
    if (result.errors.some((error) => error.type === 'plugin-cache-miss')) {
      enabledPlugins = (await loadAllPlugins()).enabled
    } else {
      enabledPlugins = result.enabled
    }
  } catch {
    return locations
  }

  for (const plugin of enabledPlugins) {
    const candidateRoots = [plugin.skillsPath, ...(plugin.skillsPaths ?? [])]

    for (const root of candidateRoots) {
      if (!root) continue

      const directSkillFile = path.join(root, 'SKILL.md')
      try {
        const stat = await fs.stat(directSkillFile)
        if (stat.isFile()) {
          const name = buildPluginSkillName(plugin.name, root)
          if (!locations.has(name)) {
            locations.set(name, { skillDir: root, pluginName: plugin.name })
          }
          continue
        }
      } catch {
        // Fall through and inspect as a skills root.
      }

      let entries: import('fs').Dirent[]
      try {
        entries = await fs.readdir(root, { withFileTypes: true })
      } catch {
        continue
      }

      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue

        const skillDir = path.join(root, entry.name)
        const skillFile = path.join(skillDir, 'SKILL.md')
        try {
          const stat = await fs.stat(skillFile)
          if (!stat.isFile()) continue
        } catch {
          continue
        }

        const name = buildPluginSkillName(plugin.name, skillDir)
        if (!locations.has(name)) {
          locations.set(name, { skillDir, pluginName: plugin.name })
        }
      }
    }
  }

  return locations
}

async function collectPluginSkills(): Promise<SkillMeta[]> {
  const locations = await collectPluginSkillDirectories()
  const skills: SkillMeta[] = []

  for (const [name, location] of locations) {
    const meta = await loadSkillMeta(
      location.skillDir,
      name,
      'plugin',
      location.pluginName,
    )
    if (meta) {
      skills.push(meta)
    }
  }

  return skills
}

async function collectAllSkills(cwd?: string): Promise<SkillMeta[]> {
  const [userSkills, projectSkills, pluginSkills] = await Promise.all([
    collectSkillsFromRoots(getUserSkillRoots(), 'user'),
    collectSkillsFromRoots(getProjectSkillRoots(cwd ?? getCwd()), 'project'),
    collectPluginSkills(),
  ])

  const skills = [...userSkills, ...projectSkills, ...pluginSkills]
  skills.sort((a, b) => a.name.localeCompare(b.name))
  return skills
}

export async function collectUserSkillNames(): Promise<Set<string>> {
  const skills = await collectSkillsFromRoots(getUserSkillRoots(), 'user')
  return new Set(skills.map((skill) => skill.name))
}

/**
 * Built-ins and bundled skills, shaped like the slash-command list.
 *
 * These exist only inside the binary, so no amount of directory scanning finds
 * them. Loaded on first use rather than at module scope: pulling in the command
 * graph costs a few hundred milliseconds, and a server that never serves a
 * slash-command request should not pay it.
 */
async function collectCompiledInSlashCommands(): Promise<SkillSlashCommand[]> {
  try {
    const [{ getCompiledInCommands }, { supportsHeadlessSlashCommand }] =
      await Promise.all([
        import('../../commands.js'),
        import('../../commands/headless.js'),
      ])
    return getCompiledInCommands()
      .filter(
        command =>
          command.userInvocable !== false &&
          // The session this list stands in for runs the CLI headlessly, so a
          // command it could not execute must not be offered.
          supportsHeadlessSlashCommand(command),
      )
      .map(command => ({
        name: command.name,
        description: command.description || '',
        ...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
      }))
  } catch (error) {
    // A fallback that throws would blank the whole slash menu, so degrade to
    // disk-only skills — the behaviour this function was added to improve on.
    // It must be loud, though: the failure mode is a menu that is quietly
    // missing entries, which reads as "that command does not exist".
    console.warn(
      `[skills] built-in slash commands unavailable, listing disk skills only: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    return []
  }
}

export async function listSkillSlashCommands(
  cwd?: string,
  options: {
    /**
     * Include the commands compiled into the binary. Only correct while no CLI
     * has spoken for the session: this process evaluates each command's
     * availability against its own state, which is close to the CLI's but not
     * identical, so once the real list arrives it must win outright rather than
     * be topped up with guesses.
     */
    includeCompiledIn?: boolean
  } = {},
): Promise<SkillSlashCommand[]> {
  const requestedCwd = cwd || getCwd()
  const [skills, legacyCommands, compiledInCommands] = await Promise.all([
    collectAllSkills(requestedCwd),
    collectLegacySlashCommands(requestedCwd),
    options.includeCompiledIn === false
      ? Promise.resolve([])
      : collectCompiledInSlashCommands(),
  ])

  // Same precedence the CLI loader applies, so the composer menu and the
  // command it runs always come from one file. See outranksClaimedSkill.
  const byName = new Map<
    string,
    { command: SkillSlashCommand; flavor: SkillRootFlavor | undefined }
  >()

  for (const skill of skills) {
    if (!skill.userInvocable) continue
    const claimed = byName.get(skill.name)
    if (
      claimed !== undefined &&
      !outranksClaimedSkill(claimed.flavor, skill.rootFlavor)
    ) {
      continue
    }
    byName.set(skill.name, {
      command: {
        name: skill.name,
        description: skill.description || '',
        kind: 'skill',
        source: skill.source,
      },
      flavor: skill.rootFlavor,
    })
  }

  for (const command of legacyCommands) {
    if (!byName.has(command.name)) {
      byName.set(command.name, { command, flavor: undefined })
    }
  }

  // Last, and only to fill gaps: a same-named skill on disk is what the CLI
  // would actually run, so it keeps the entry.
  for (const command of compiledInCommands) {
    if (!byName.has(command.name)) {
      byName.set(command.name, { command, flavor: undefined })
    }
  }

  return [...byName.values()]
    .map(claim => claim.command)
    .sort((a, b) => a.name.localeCompare(b.name))
}

// ─── Router ──────────────────────────────────────────────────────────────────

export async function handleSkillsApi(
  req: Request,
  url: URL,
  segments: string[],
): Promise<Response> {
  try {
    if (req.method !== 'GET') {
      throw new ApiError(405, `Method ${req.method} not allowed`, 'METHOD_NOT_ALLOWED')
    }

    const sub = segments[2]

    switch (sub) {
      case undefined:
        return await listSkills(url)
      case 'mentions': {
        const { listCapabilityMentions } = await import('../services/capabilityMentionService.js')
        return Response.json(await listCapabilityMentions(url.searchParams.get('cwd') || getCwd()))
      }
      case 'detail':
        return await getSkillDetail(url)
      default:
        throw ApiError.notFound(`Unknown skills endpoint: ${sub}`)
    }
  } catch (error) {
    return errorResponse(error)
  }
}

// ─── Handlers ────────────────────────────────────────────────────────────────

async function listSkills(url: URL): Promise<Response> {
  const cwd = getRequestedCwd(url)
  const skills = await collectAllSkills(cwd)
  return Response.json({ skills })
}

async function getSkillDetail(url: URL): Promise<Response> {
  const source = url.searchParams.get('source')
  const name = url.searchParams.get('name')

  if (!source || !name) {
    throw ApiError.badRequest('Missing required query parameters: source, name')
  }

  // Prevent path traversal
  if (name.includes('..') || name.includes('/') || name.includes('\\')) {
    throw ApiError.badRequest('Invalid skill name')
  }

  if (source !== 'user' && source !== 'project' && source !== 'plugin') {
    throw ApiError.badRequest(`Unsupported source: ${source}`)
  }

  const cwd = getRequestedCwd(url)
  const pluginLocations =
    source === 'plugin' ? await collectPluginSkillDirectories() : null

  const pluginLocation = pluginLocations?.get(name)
  const resolved =
    source === 'plugin'
      ? pluginLocation?.skillDir
        ? { skillDir: pluginLocation.skillDir, rootFlavor: undefined }
        : null
      : await resolveSkillDir(source, name, cwd)

  if (!resolved) {
    throw ApiError.notFound(`Skill not found: ${name}`)
  }

  const { skillDir, rootFlavor } = resolved

  const meta = await loadSkillMeta(
    skillDir,
    name,
    source,
    pluginLocation?.pluginName,
    rootFlavor,
  )
  if (!meta) {
    throw ApiError.notFound(`Skill missing SKILL.md: ${name}`)
  }

  const { tree, files } = await buildFileTree(skillDir)
  const marketMeta = source === 'user'
    ? await readMarketMeta(name) ?? undefined
    : undefined

  return Response.json({
    detail: { meta, tree, files, skillRoot: skillDir, marketMeta },
  })
}
