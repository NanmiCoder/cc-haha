import { getAgentProfile } from '../utils/agentProfile.js'
import { realpath } from 'fs/promises'
import ignore from 'ignore'
import memoize from 'lodash-es/memoize.js'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  sep as pathSep,
  relative,
} from 'path'
import {
  getAdditionalDirectoriesForClaudeMd,
  getSessionId,
} from '../bootstrap/state.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import { roughTokenCountEstimation } from '../services/tokenEstimation.js'
import type { Command, PromptCommand } from '../types/command.js'
import {
  parseArgumentNames,
  substituteArguments,
} from '../utils/argumentSubstitution.js'
import { logForDebugging } from '../utils/debug.js'
import {
  EFFORT_LEVELS,
  type EffortValue,
  parseEffortValue,
} from '../utils/effort.js'
import {
  getClaudeConfigHomeDir,
  isBareMode,
  isEnvTruthy,
} from '../utils/envUtils.js'
import { isENOENT, isFsInaccessible } from '../utils/errors.js'
import {
  coerceDescriptionToString,
  type FrontmatterData,
  type FrontmatterShell,
  parseBooleanFrontmatter,
  parseFrontmatter,
  parseShellFrontmatter,
  splitPathInFrontmatter,
} from '../utils/frontmatterParser.js'
import { getFsImplementation } from '../utils/fsOperations.js'
import { isPathGitignored } from '../utils/git/gitignore.js'
import { logError } from '../utils/log.js'
import {
  extractDescriptionFromMarkdown,
  loadMarkdownFilesForSubdir,
  type MarkdownFile,
  parseSlashCommandToolsFromFrontmatter,
} from '../utils/markdownConfigLoader.js'
import {
  getAddDirSkillRoots,
  getNestedSkillDirCandidates,
  getProjectSkillRoots,
  getUserSkillRoots,
  outranksClaimedSkill,
  type SkillRoot,
  type SkillRootFlavor,
} from './skillRoots.js'
import { parseUserSpecifiedModel } from '../utils/model/model.js'
import { executeShellCommandsInPrompt } from '../utils/promptShellExecution.js'
import type { SettingSource } from '../utils/settings/constants.js'
import { isSettingSourceEnabled } from '../utils/settings/constants.js'
import { getManagedFilePath } from '../utils/settings/managedPath.js'
import { isRestrictedToPluginOnly } from '../utils/settings/pluginOnlyPolicy.js'
import { HooksSchema, type HooksSettings } from '../utils/settings/types.js'
import { createSignal } from '../utils/signal.js'
import { registerMCPSkillBuilders } from './mcpSkillBuilders.js'

export type LoadedFrom =
  | 'commands_DEPRECATED'
  | 'skills'
  | 'plugin'
  | 'managed'
  | 'bundled'
  | 'mcp'

/**
 * Returns a claude config directory path for a given source.
 */
export function getSkillsPath(
  source: SettingSource | 'plugin',
  dir: 'skills' | 'commands',
): string {
  switch (source) {
    case 'policySettings':
      return join(getManagedFilePath(), '.claude', dir)
    case 'userSettings':
      return join(getClaudeConfigHomeDir(), dir)
    case 'projectSettings':
      return `.claude/${dir}`
    case 'plugin':
      return 'plugin'
    default:
      return ''
  }
}

/**
 * Estimates token count for a skill based on frontmatter only
 * (name, description, whenToUse) since full content is only loaded on invocation.
 */
export function estimateSkillFrontmatterTokens(skill: Command): number {
  const frontmatterText = [skill.name, skill.description, skill.whenToUse]
    .filter(Boolean)
    .join(' ')
  return roughTokenCountEstimation(frontmatterText)
}

/**
 * Gets a unique identifier for a file by resolving symlinks to a canonical path.
 * This allows detection of duplicate files accessed through different paths
 * (e.g., via symlinks or overlapping parent directories).
 * Returns null if the file doesn't exist or can't be resolved.
 *
 * Uses realpath to resolve symlinks, which is filesystem-agnostic and avoids
 * issues with filesystems that report unreliable inode values (e.g., inode 0 on
 * some virtual/container/NFS filesystems, or precision loss on ExFAT).
 * See: https://github.com/anthropics/claude-code/issues/13893
 */
async function getFileIdentity(filePath: string): Promise<string | null> {
  try {
    return await realpath(filePath)
  } catch {
    return null
  }
}

// Internal type to track skill with its file path for deduplication
type SkillWithPath = {
  skill: Command
  filePath: string
  /**
   * Which directory convention this skill came from, and which scope that
   * directory represents. Present only for skills loaded from a /skills/ dir;
   * legacy /commands/ entries leave them undefined and skip name-collision
   * dedup entirely.
   */
  rootFlavor?: SkillRootFlavor
  scopeKey?: string
}

/**
 * Parse and validate hooks from frontmatter.
 * Returns undefined if hooks are not defined or invalid.
 */
function parseHooksFromFrontmatter(
  frontmatter: FrontmatterData,
  skillName: string,
): HooksSettings | undefined {
  if (!frontmatter.hooks) {
    return undefined
  }

  const result = HooksSchema().safeParse(frontmatter.hooks)
  if (!result.success) {
    logForDebugging(
      `Invalid hooks in skill '${skillName}': ${result.error.message}`,
    )
    return undefined
  }

  return result.data
}

/**
 * Parse paths frontmatter from a skill, using the same format as CLAUDE.md rules.
 * Returns undefined if no paths are specified or if all patterns are match-all.
 */
function parseSkillPaths(frontmatter: FrontmatterData): string[] | undefined {
  if (!frontmatter.paths) {
    return undefined
  }

  const patterns = splitPathInFrontmatter(frontmatter.paths)
    .map(pattern => {
      // Remove /** suffix - ignore library treats 'path' as matching both
      // the path itself and everything inside it
      return pattern.endsWith('/**') ? pattern.slice(0, -3) : pattern
    })
    .filter((p: string) => p.length > 0)

  // If all patterns are ** (match-all), treat as no paths (undefined)
  if (patterns.length === 0 || patterns.every((p: string) => p === '**')) {
    return undefined
  }

  return patterns
}

/**
 * Parses all skill frontmatter fields that are shared between file-based and
 * MCP skill loading. Caller supplies the resolved skill name and the
 * source/loadedFrom/baseDir/paths fields separately.
 */
export function parseSkillFrontmatterFields(
  frontmatter: FrontmatterData,
  markdownContent: string,
  resolvedName: string,
  descriptionFallbackLabel: 'Skill' | 'Custom command' = 'Skill',
): {
  displayName: string | undefined
  description: string
  hasUserSpecifiedDescription: boolean
  allowedTools: string[]
  argumentHint: string | undefined
  argumentNames: string[]
  whenToUse: string | undefined
  version: string | undefined
  model: ReturnType<typeof parseUserSpecifiedModel> | undefined
  disableModelInvocation: boolean
  userInvocable: boolean
  hooks: HooksSettings | undefined
  executionContext: 'fork' | undefined
  agent: string | undefined
  effort: EffortValue | undefined
  shell: FrontmatterShell | undefined
} {
  const validatedDescription = coerceDescriptionToString(
    frontmatter.description,
    resolvedName,
  )
  const description =
    validatedDescription ??
    extractDescriptionFromMarkdown(markdownContent, descriptionFallbackLabel)

  const userInvocable =
    frontmatter['user-invocable'] === undefined
      ? true
      : parseBooleanFrontmatter(frontmatter['user-invocable'])

  const model =
    frontmatter.model === 'inherit'
      ? undefined
      : frontmatter.model
        ? parseUserSpecifiedModel(frontmatter.model as string)
        : undefined

  const effortRaw = frontmatter['effort']
  const effort =
    effortRaw !== undefined ? parseEffortValue(effortRaw) : undefined
  if (effortRaw !== undefined && effort === undefined) {
    logForDebugging(
      `Skill ${resolvedName} has invalid effort '${effortRaw}'. Valid options: ${EFFORT_LEVELS.join(', ')} or an integer`,
    )
  }

  return {
    displayName:
      frontmatter.name != null ? String(frontmatter.name) : undefined,
    description,
    hasUserSpecifiedDescription: validatedDescription !== null,
    allowedTools: parseSlashCommandToolsFromFrontmatter(
      frontmatter['allowed-tools'],
    ),
    argumentHint:
      frontmatter['argument-hint'] != null
        ? String(frontmatter['argument-hint'])
        : undefined,
    argumentNames: parseArgumentNames(
      frontmatter.arguments as string | string[] | undefined,
    ),
    whenToUse: frontmatter.when_to_use as string | undefined,
    version: frontmatter.version as string | undefined,
    model,
    disableModelInvocation: parseBooleanFrontmatter(
      frontmatter['disable-model-invocation'],
    ),
    userInvocable,
    hooks: parseHooksFromFrontmatter(frontmatter, resolvedName),
    executionContext: frontmatter.context === 'fork' ? 'fork' : undefined,
    agent: frontmatter.agent as string | undefined,
    effort,
    shell: parseShellFrontmatter(frontmatter.shell, resolvedName),
  }
}

/**
 * Creates a skill command from parsed data
 */
export function createSkillCommand({
  skillName,
  displayName,
  description,
  hasUserSpecifiedDescription,
  markdownContent,
  allowedTools,
  argumentHint,
  argumentNames,
  whenToUse,
  version,
  model,
  disableModelInvocation,
  userInvocable,
  source,
  baseDir,
  loadedFrom,
  hooks,
  executionContext,
  agent,
  paths,
  effort,
  shell,
}: {
  skillName: string
  displayName: string | undefined
  description: string
  hasUserSpecifiedDescription: boolean
  markdownContent: string
  allowedTools: string[]
  argumentHint: string | undefined
  argumentNames: string[]
  whenToUse: string | undefined
  version: string | undefined
  model: string | undefined
  disableModelInvocation: boolean
  userInvocable: boolean
  source: PromptCommand['source']
  baseDir: string | undefined
  loadedFrom: LoadedFrom
  hooks: HooksSettings | undefined
  executionContext: 'inline' | 'fork' | undefined
  agent: string | undefined
  paths: string[] | undefined
  effort: EffortValue | undefined
  shell: FrontmatterShell | undefined
}): Command {
  return {
    type: 'prompt',
    name: skillName,
    description,
    hasUserSpecifiedDescription,
    allowedTools,
    argumentHint,
    argNames: argumentNames.length > 0 ? argumentNames : undefined,
    whenToUse,
    version,
    model,
    disableModelInvocation,
    userInvocable,
    context: executionContext,
    agent,
    effort,
    paths,
    contentLength: markdownContent.length,
    isHidden: !userInvocable,
    progressMessage: 'running',
    userFacingName(): string {
      return displayName || skillName
    },
    source,
    loadedFrom,
    hooks,
    skillRoot: baseDir,
    async getPromptForCommand(args, toolUseContext) {
      let finalContent = baseDir
        ? `Base directory for this skill: ${baseDir}\n\n${markdownContent}`
        : markdownContent

      finalContent = substituteArguments(
        finalContent,
        args,
        true,
        argumentNames,
      )

      // Replace ${CLAUDE_SKILL_DIR} with the skill's own directory so bash
      // injection (!`...`) can reference bundled scripts. Normalize backslashes
      // to forward slashes on Windows so shell commands don't treat them as escapes.
      if (baseDir) {
        const skillDir =
          process.platform === 'win32' ? baseDir.replace(/\\/g, '/') : baseDir
        finalContent = finalContent.replace(/\$\{CLAUDE_SKILL_DIR\}/g, skillDir)
      }

      // Replace ${CLAUDE_SESSION_ID} with the current session ID
      finalContent = finalContent.replace(
        /\$\{CLAUDE_SESSION_ID\}/g,
        getSessionId(),
      )

      // Security: MCP skills are remote and untrusted — never execute inline
      // shell commands (!`…` / ```! … ```) from their markdown body.
      // ${CLAUDE_SKILL_DIR} is meaningless for MCP skills anyway.
      if (loadedFrom !== 'mcp') {
        finalContent = await executeShellCommandsInPrompt(
          finalContent,
          {
            ...toolUseContext,
            getAppState() {
              const appState = toolUseContext.getAppState()
              return {
                ...appState,
                toolPermissionContext: {
                  ...appState.toolPermissionContext,
                  alwaysAllowRules: {
                    ...appState.toolPermissionContext.alwaysAllowRules,
                    command: getAgentProfile() === 'lean' ? appState.toolPermissionContext.alwaysAllowRules.command : allowedTools,
                  },
                },
              }
            },
          },
          `/${skillName}`,
          shell,
        )
      }

      return [{ type: 'text', text: finalContent }]
    },
  } satisfies Command
}

/**
 * Loads skills from a /skills/ directory path.
 * Only supports directory format: skill-name/SKILL.md
 */
async function loadSkillsFromSkillsDir(
  basePath: string,
  source: SettingSource,
  root?: Pick<SkillRoot, 'flavor' | 'scopeKey'>,
): Promise<SkillWithPath[]> {
  const fs = getFsImplementation()

  let entries
  try {
    entries = await fs.readdir(basePath)
  } catch (e: unknown) {
    if (!isFsInaccessible(e)) logError(e)
    return []
  }

  const results = await Promise.all(
    entries.map(async (entry): Promise<SkillWithPath | null> => {
      try {
        // Only support directory format: skill-name/SKILL.md
        if (!entry.isDirectory() && !entry.isSymbolicLink()) {
          // Single .md files are NOT supported in /skills/ directory
          return null
        }

        const skillDirPath = join(basePath, entry.name)
        const skillFilePath = join(skillDirPath, 'SKILL.md')

        let content: string
        try {
          content = await fs.readFile(skillFilePath, { encoding: 'utf-8' })
        } catch (e: unknown) {
          // SKILL.md doesn't exist, skip this entry. Log non-ENOENT errors
          // (EACCES/EPERM/EIO) so permission/IO problems are diagnosable.
          if (!isENOENT(e)) {
            logForDebugging(`[skills] failed to read ${skillFilePath}: ${e}`, {
              level: 'warn',
            })
          }
          return null
        }

        const { frontmatter, content: markdownContent } = parseFrontmatter(
          content,
          skillFilePath,
        )

        const skillName = entry.name
        if (!isRenderableSkillName(skillName)) {
          logForDebugging(
            `[skills] Skipped ${skillDirPath}: the directory name contains control characters`,
            { level: 'warn' },
          )
          return null
        }
        const parsed = parseSkillFrontmatterFields(
          frontmatter,
          markdownContent,
          skillName,
        )
        const paths = parseSkillPaths(frontmatter)

        return {
          skill: createSkillCommand({
            ...parsed,
            skillName,
            markdownContent,
            source,
            baseDir: skillDirPath,
            loadedFrom: 'skills',
            paths,
          }),
          filePath: skillFilePath,
          rootFlavor: root?.flavor,
          scopeKey: root?.scopeKey,
        }
      } catch (error) {
        logError(error)
        return null
      }
    }),
  )

  return results.filter((r): r is SkillWithPath => r !== null)
}

/**
 * Whether a skill directory name can be rendered without corrupting whatever
 * it is rendered into.
 *
 * The name reaches the model as one `- name: description` line in the skill
 * catalog, so a name carrying a line break writes extra entries of its own.
 * `.agents/skills` is a directory other clients and checked-out repositories
 * write into, which makes the name attacker-controlled rather than the user's.
 *
 * Deliberately narrower than the Agent Skills spec (lowercase alphanumerics and
 * hyphens): existing `.claude/skills` directories predate that rule, and
 * silently dropping one of those would be a worse failure than the one this
 * prevents. Only genuinely unrenderable names are rejected.
 */
export function isRenderableSkillName(name: string): boolean {
  if (name.length === 0) return false
  for (const char of name) {
    const code = char.codePointAt(0) ?? 0
    // C0 and C1 controls — the line breaks among them are what would let a
    // name write extra catalog entries.
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return false
  }
  return true
}

/**
 * Collapses skills that share a name, keeping the highest-precedence one.
 *
 * Used on paths that don't run the full realpath dedup; the main loader inlines
 * the same rule so it can interleave with file-identity dedup.
 */
function dedupeSkillNameCollisions(entries: SkillWithPath[]): SkillWithPath[] {
  const claimedByName = new Map<
    string,
    { entry: SkillWithPath; flavor: SkillRootFlavor | undefined }
  >()

  for (const entry of entries) {
    const flavor =
      entry.scopeKey === undefined ? undefined : (entry.rootFlavor ?? 'claude')
    const claimed = claimedByName.get(entry.skill.name)
    if (
      claimed !== undefined &&
      !outranksClaimedSkill(claimed.flavor, flavor)
    ) {
      logForDebugging(
        `[skills] Shadowed skill '${entry.skill.name}' in ${entry.filePath}: a skill of the same name was already loaded from a ${claimed.flavor ?? 'legacy commands'} directory`,
        { level: 'warn' },
      )
      continue
    }
    claimedByName.set(entry.skill.name, { entry, flavor })
  }

  return [...claimedByName.values()].map(claim => claim.entry)
}

// --- Legacy /commands/ loader ---

function isSkillFile(filePath: string): boolean {
  return /^skill\.md$/i.test(basename(filePath))
}

/**
 * Transforms markdown files to handle "skill" commands in legacy /commands/ folder.
 * When a SKILL.md file exists in a directory, only that file is loaded
 * and it takes the name of its parent directory.
 */
function transformSkillFiles(files: MarkdownFile[]): MarkdownFile[] {
  const filesByDir = new Map<string, MarkdownFile[]>()

  for (const file of files) {
    const dir = dirname(file.filePath)
    const dirFiles = filesByDir.get(dir) ?? []
    dirFiles.push(file)
    filesByDir.set(dir, dirFiles)
  }

  const result: MarkdownFile[] = []

  for (const [dir, dirFiles] of filesByDir) {
    const skillFiles = dirFiles.filter(f => isSkillFile(f.filePath))
    if (skillFiles.length > 0) {
      const skillFile = skillFiles[0]!
      if (skillFiles.length > 1) {
        logForDebugging(
          `Multiple skill files found in ${dir}, using ${basename(skillFile.filePath)}`,
        )
      }
      result.push(skillFile)
    } else {
      result.push(...dirFiles)
    }
  }

  return result
}

function buildNamespace(targetDir: string, baseDir: string): string {
  const normalizedBaseDir = baseDir.endsWith(pathSep)
    ? baseDir.slice(0, -1)
    : baseDir

  if (targetDir === normalizedBaseDir) {
    return ''
  }

  const relativePath = targetDir.slice(normalizedBaseDir.length + 1)
  return relativePath ? relativePath.split(pathSep).join(':') : ''
}

function getSkillCommandName(filePath: string, baseDir: string): string {
  const skillDirectory = dirname(filePath)
  const parentOfSkillDir = dirname(skillDirectory)
  const commandBaseName = basename(skillDirectory)

  const namespace = buildNamespace(parentOfSkillDir, baseDir)
  return namespace ? `${namespace}:${commandBaseName}` : commandBaseName
}

function getRegularCommandName(filePath: string, baseDir: string): string {
  const fileName = basename(filePath)
  const fileDirectory = dirname(filePath)
  const commandBaseName = fileName.replace(/\.md$/, '')

  const namespace = buildNamespace(fileDirectory, baseDir)
  return namespace ? `${namespace}:${commandBaseName}` : commandBaseName
}

function getCommandName(file: MarkdownFile): string {
  const isSkill = isSkillFile(file.filePath)
  return isSkill
    ? getSkillCommandName(file.filePath, file.baseDir)
    : getRegularCommandName(file.filePath, file.baseDir)
}

/**
 * Loads skills from legacy /commands/ directories.
 * Supports both directory format (SKILL.md) and single .md file format.
 * Commands from /commands/ default to user-invocable: true
 */
async function loadSkillsFromCommandsDir(
  cwd: string,
): Promise<SkillWithPath[]> {
  try {
    const markdownFiles = await loadMarkdownFilesForSubdir('commands', cwd)
    const processedFiles = transformSkillFiles(markdownFiles)

    const skills: SkillWithPath[] = []

    for (const {
      baseDir,
      filePath,
      frontmatter,
      content,
      source,
    } of processedFiles) {
      try {
        const isSkillFormat = isSkillFile(filePath)
        const skillDirectory = isSkillFormat ? dirname(filePath) : undefined
        const cmdName = getCommandName({
          baseDir,
          filePath,
          frontmatter,
          content,
          source,
        })

        const parsed = parseSkillFrontmatterFields(
          frontmatter,
          content,
          cmdName,
          'Custom command',
        )

        skills.push({
          skill: createSkillCommand({
            ...parsed,
            skillName: cmdName,
            displayName: undefined,
            markdownContent: content,
            source,
            baseDir: skillDirectory,
            loadedFrom: 'commands_DEPRECATED',
            paths: undefined,
          }),
          filePath,
        })
      } catch (error) {
        logError(error)
      }
    }

    return skills
  } catch (error) {
    logError(error)
    return []
  }
}

/**
 * Loads all skills from both /skills/ and legacy /commands/ directories.
 *
 * Skills from /skills/ directories:
 * - Only support directory format: skill-name/SKILL.md
 * - Default to user-invocable: true (can opt-out with user-invocable: false)
 *
 * Skills from legacy /commands/ directories:
 * - Support both directory format (SKILL.md) and single .md file format
 * - Default to user-invocable: true (user can type /cmd)
 *
 * @param cwd Current working directory for project directory traversal
 */
export const getSkillDirCommands = memoize(
  async (cwd: string): Promise<Command[]> => {
    // Each scope contributes both `.claude/skills` and the cross-client
    // `.agents/skills` convention, `.claude` first so it wins collisions.
    const userSkillRoots = getUserSkillRoots()
    const managedSkillsDir = join(getManagedFilePath(), '.claude', 'skills')
    const projectSkillRoots = getProjectSkillRoots(cwd)

    logForDebugging(
      `Loading skills from: managed=${managedSkillsDir}, user=[${userSkillRoots
        .map(r => r.path)
        .join(', ')}], project=[${projectSkillRoots.map(r => r.path).join(', ')}]`,
    )

    // Load from additional directories (--add-dir)
    const additionalDirs = getAdditionalDirectoriesForClaudeMd()
    const additionalSkillRoots = additionalDirs.flatMap(getAddDirSkillRoots)
    const skillsLocked = isRestrictedToPluginOnly('skills')
    const projectSettingsEnabled =
      isSettingSourceEnabled('projectSettings') && !skillsLocked

    // --bare: skip auto-discovery (managed/user/project dir walks + legacy
    // commands-dir). Load ONLY explicit --add-dir paths. Bundled skills
    // register separately. skillsLocked still applies — --bare is not a
    // policy bypass.
    if (isBareMode()) {
      if (additionalDirs.length === 0 || !projectSettingsEnabled) {
        logForDebugging(
          `[bare] Skipping skill dir discovery (${additionalDirs.length === 0 ? 'no --add-dir' : 'projectSettings disabled or skillsLocked'})`,
        )
        return []
      }
      const additionalSkillsNested = await Promise.all(
        additionalSkillRoots.map(root =>
          loadSkillsFromSkillsDir(root.path, 'projectSettings', root),
        ),
      )
      // Both conventions inside one added dir, and the same name across two of
      // them, collapse the same way they do on the main path.
      return dedupeSkillNameCollisions(additionalSkillsNested.flat()).map(
        s => s.skill,
      )
    }

    // Load from /skills/ directories, additional dirs, and legacy /commands/ in parallel
    // (all independent — different directories, no shared state)
    const [
      managedSkills,
      userSkillsNested,
      projectSkillsNested,
      additionalSkillsNested,
      legacyCommands,
    ] = await Promise.all([
      isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_POLICY_SKILLS)
        ? Promise.resolve([])
        : loadSkillsFromSkillsDir(managedSkillsDir, 'policySettings', {
            flavor: 'claude',
            scopeKey: 'managed',
          }),
      isSettingSourceEnabled('userSettings') && !skillsLocked
        ? Promise.all(
            userSkillRoots.map(root =>
              loadSkillsFromSkillsDir(root.path, 'userSettings', root),
            ),
          )
        : Promise.resolve([]),
      projectSettingsEnabled
        ? Promise.all(
            projectSkillRoots.map(root =>
              loadSkillsFromSkillsDir(root.path, 'projectSettings', root),
            ),
          )
        : Promise.resolve([]),
      projectSettingsEnabled
        ? Promise.all(
            additionalSkillRoots.map(root =>
              loadSkillsFromSkillsDir(root.path, 'projectSettings', root),
            ),
          )
        : Promise.resolve([]),
      // Legacy commands-as-skills goes through markdownConfigLoader with
      // subdir='commands', which our agents-only guard there skips. Block
      // here when skills are locked — these ARE skills, regardless of the
      // directory they load from.
      skillsLocked ? Promise.resolve([]) : loadSkillsFromCommandsDir(cwd),
    ])

    // Flatten and combine all skills
    const allSkillsWithPaths = [
      ...managedSkills,
      ...userSkillsNested.flat(),
      ...projectSkillsNested.flat(),
      ...additionalSkillsNested.flat(),
      ...legacyCommands,
    ]

    // Deduplicate by resolved path (handles symlinks and duplicate parent directories)
    // Pre-compute file identities in parallel (realpath calls are independent),
    // then dedup synchronously (order-dependent first-wins)
    const fileIds = await Promise.all(
      allSkillsWithPaths.map(({ skill, filePath }) =>
        skill.type === 'prompt'
          ? getFileIdentity(filePath)
          : Promise.resolve(null),
      ),
    )

    const seenFileIds = new Map<
      string,
      SettingSource | 'builtin' | 'mcp' | 'plugin' | 'bundled'
    >()
    /**
     * name → the entry currently holding it, and the flavor that claimed it.
     *
     * A skill name is a single slash command, so it has to resolve to exactly
     * one file however many roots spell it. `.claude` outranks `.agents` even
     * across scopes: this is the Claude Code CLI, so a skill installed for us
     * stays authoritative over one another client dropped into the shared
     * `.agents` space. Within one flavor the root order above decides
     * (managed → user → project, each most-specific-first → --add-dir).
     *
     * A `undefined` flavor marks a legacy `/commands/` entry: those only fill a
     * name nothing else claimed and never displace a skill.
     */
    const claimedByName = new Map<
      string,
      { skill: Command; flavor: SkillRootFlavor | undefined }
    >()

    for (let i = 0; i < allSkillsWithPaths.length; i++) {
      const entry = allSkillsWithPaths[i]
      if (entry === undefined || entry.skill.type !== 'prompt') continue
      const { skill, scopeKey, rootFlavor } = entry

      const fileId = fileIds[i]
      if (fileId !== null && fileId !== undefined) {
        const existingSource = seenFileIds.get(fileId)
        if (existingSource !== undefined) {
          logForDebugging(
            `Skipping duplicate skill '${skill.name}' from ${skill.source} (same file already loaded from ${existingSource})`,
          )
          continue
        }
      }

      // Two genuinely distinct files claiming one name — the copy-based sync
      // case, which the realpath dedup above cannot collapse.
      const flavor = scopeKey === undefined ? undefined : (rootFlavor ?? 'claude')
      const claimed = claimedByName.get(skill.name)
      if (claimed !== undefined) {
        if (!outranksClaimedSkill(claimed.flavor, flavor)) {
          logForDebugging(
            `[skills] Shadowed skill '${skill.name}' in ${entry.filePath}: a skill of the same name was already loaded from a ${claimed.flavor ?? 'legacy commands'} directory`,
            { level: 'warn' },
          )
          // Record the loser's file identity too. Roots can overlap — e.g.
          // CLAUDE_CONFIG_DIR pointing inside the project makes one directory
          // both the user root and a project root — and without this the
          // shadowed file reappears later under the other scope.
          if (fileId !== null && fileId !== undefined) {
            seenFileIds.set(fileId, skill.source)
          }
          continue
        }
        logForDebugging(
          `[skills] Replacing skill '${skill.name}' with ${entry.filePath}: a .claude directory outranks the .agents copy loaded earlier`,
          { level: 'warn' },
        )
      }

      if (fileId !== null && fileId !== undefined) {
        seenFileIds.set(fileId, skill.source)
      }
      // Map.set keeps the first insertion position, so a replacement inherits
      // the slot its predecessor held rather than jumping to the end.
      claimedByName.set(skill.name, { skill, flavor })
    }

    const deduplicatedSkills: Command[] = [...claimedByName.values()].map(
      claim => claim.skill,
    )

    const duplicatesRemoved =
      allSkillsWithPaths.length - deduplicatedSkills.length
    if (duplicatesRemoved > 0) {
      logForDebugging(`Deduplicated ${duplicatesRemoved} skills (same file)`)
    }

    // Separate conditional skills (with paths frontmatter) from unconditional ones
    const unconditionalSkills: Command[] = []
    const newConditionalSkills: Command[] = []
    for (const skill of deduplicatedSkills) {
      if (
        skill.type === 'prompt' &&
        skill.paths &&
        skill.paths.length > 0 &&
        !activatedConditionalSkillNames.has(skill.name)
      ) {
        newConditionalSkills.push(skill)
      } else {
        unconditionalSkills.push(skill)
      }
    }

    // Store conditional skills for later activation when matching files are touched
    for (const skill of newConditionalSkills) {
      conditionalSkills.set(skill.name, skill)
    }

    if (newConditionalSkills.length > 0) {
      logForDebugging(
        `[skills] ${newConditionalSkills.length} conditional skills stored (activated when matching files are touched)`,
      )
    }

    logForDebugging(
      `Loaded ${deduplicatedSkills.length} unique skills (${unconditionalSkills.length} unconditional, ${newConditionalSkills.length} conditional, managed: ${managedSkills.length}, user: ${userSkillsNested.flat().length}, project: ${projectSkillsNested.flat().length}, additional: ${additionalSkillsNested.flat().length}, legacy commands: ${legacyCommands.length})`,
    )

    return unconditionalSkills
  },
)

export function clearSkillCaches() {
  getSkillDirCommands.cache?.clear?.()
  loadMarkdownFilesForSubdir.cache?.clear?.()
  conditionalSkills.clear()
  activatedConditionalSkillNames.clear()
}

// Backwards-compatible aliases for tests
export { getSkillDirCommands as getCommandDirCommands }
export { clearSkillCaches as clearCommandCaches }
export { transformSkillFiles }

// --- Dynamic skill discovery ---

// State for dynamically discovered skills
const dynamicSkillDirs = new Set<string>()
const dynamicSkills = new Map<string, Command>()

// --- Conditional skills (path-filtered) ---

// Skills with paths frontmatter that haven't been activated yet
const conditionalSkills = new Map<string, Command>()
// Names of skills that have been activated (survives cache clears within a session)
const activatedConditionalSkillNames = new Set<string>()

// Signal fired when dynamic skills are loaded
const skillsLoaded = createSignal()

/**
 * Register a callback to be invoked when dynamic skills are loaded.
 * Used by other modules to clear caches without creating import cycles.
 * Returns an unsubscribe function.
 */
export function onDynamicSkillsLoaded(callback: () => void): () => void {
  // Wrap at subscribe time so a throwing listener is logged and skipped
  // rather than aborting skillsLoaded.emit() and breaking skill loading.
  // Same callSafe pattern as growthbook.ts — createSignal.emit() has no
  // per-listener try/catch.
  return skillsLoaded.subscribe(() => {
    try {
      callback()
    } catch (error) {
      logError(error)
    }
  })
}

/**
 * Discovers skill directories by walking up from file paths to cwd.
 * Only discovers directories below cwd (cwd-level skills are loaded at startup).
 *
 * @param filePaths Array of file paths to check
 * @param cwd Current working directory (upper bound for discovery)
 * @returns Array of newly discovered skill directories, sorted deepest first
 */
export async function discoverSkillDirsForPaths(
  filePaths: string[],
  cwd: string,
): Promise<string[]> {
  const fs = getFsImplementation()
  const resolvedCwd = cwd.endsWith(pathSep) ? cwd.slice(0, -1) : cwd
  const newDirs: string[] = []

  for (const filePath of filePaths) {
    // Start from the file's parent directory
    let currentDir = dirname(filePath)

    // Walk up to cwd but NOT including cwd itself
    // CWD-level skills are already loaded at startup, so we only discover nested ones
    // Use prefix+separator check to avoid matching /project-backup when cwd is /project
    while (currentDir.startsWith(resolvedCwd + pathSep)) {
      // Both `.claude/skills` and the cross-client `.agents/skills`.
      for (const skillDir of getNestedSkillDirCandidates(currentDir)) {
        // Skip if we've already checked this path (hit or miss) — avoids
        // repeating the same failed stat on every Read/Write/Edit call when
        // the directory doesn't exist (the common case).
        if (dynamicSkillDirs.has(skillDir)) continue

        dynamicSkillDirs.add(skillDir)
        try {
          await fs.stat(skillDir)
          // Skills dir exists. Before loading, check if the containing dir
          // is gitignored — blocks e.g. node_modules/pkg/.claude/skills from
          // loading silently. `git check-ignore` handles nested .gitignore,
          // .git/info/exclude, and global gitignore. Fails open outside a
          // git repo (exit 128 → false); the invocation-time trust dialog
          // is the actual security boundary.
          if (await isPathGitignored(currentDir, resolvedCwd)) {
            logForDebugging(
              `[skills] Skipped gitignored skills dir: ${skillDir}`,
            )
            continue
          }
          newDirs.push(skillDir)
        } catch {
          // Directory doesn't exist — already recorded above, continue
        }
      }

      // Move to parent
      const parent = dirname(currentDir)
      if (parent === currentDir) break // Reached root
      currentDir = parent
    }
  }

  // Sort by path depth (deepest first) so skills closer to the file take precedence
  return newDirs.sort(
    (a, b) => b.split(pathSep).length - a.split(pathSep).length,
  )
}

/**
 * Loads skills from the given directories and merges them into the dynamic skills map.
 * Skills from directories closer to the file (deeper paths) take precedence.
 *
 * @param dirs Array of skill directories to load from (should be sorted deepest first)
 */
export async function addSkillDirectories(dirs: string[]): Promise<void> {
  if (
    !isSettingSourceEnabled('projectSettings') ||
    isRestrictedToPluginOnly('skills')
  ) {
    logForDebugging(
      '[skills] Dynamic skill discovery skipped: projectSettings disabled or plugin-only policy',
    )
    return
  }
  if (dirs.length === 0) {
    return
  }

  const previousSkillNamesForLogging = new Set(dynamicSkills.keys())

  // Load skills from all directories
  const loadedSkills = await Promise.all(
    dirs.map(dir => loadSkillsFromSkillsDir(dir, 'projectSettings')),
  )

  // Process in reverse order (shallower first) so deeper paths override
  for (let i = loadedSkills.length - 1; i >= 0; i--) {
    for (const { skill } of loadedSkills[i] ?? []) {
      if (skill.type === 'prompt') {
        dynamicSkills.set(skill.name, skill)
      }
    }
  }

  const newSkillCount = loadedSkills.flat().length
  if (newSkillCount > 0) {
    const addedSkills = [...dynamicSkills.keys()].filter(
      n => !previousSkillNamesForLogging.has(n),
    )
    logForDebugging(
      `[skills] Dynamically discovered ${newSkillCount} skills from ${dirs.length} directories`,
    )
    if (addedSkills.length > 0) {
      logEvent('tengu_dynamic_skills_changed', {
        source:
          'file_operation' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        previousCount: previousSkillNamesForLogging.size,
        newCount: dynamicSkills.size,
        addedCount: addedSkills.length,
        directoryCount: dirs.length,
      })
    }
  }

  // Notify listeners that skills were loaded (so they can clear caches)
  skillsLoaded.emit()
}

/**
 * Gets all dynamically discovered skills.
 * These are skills discovered from file paths during the session.
 */
export function getDynamicSkills(): Command[] {
  return Array.from(dynamicSkills.values())
}

/**
 * Activates conditional skills (skills with paths frontmatter) whose path
 * patterns match the given file paths. Activated skills are added to the
 * dynamic skills map, making them available to the model.
 *
 * Uses the `ignore` library (gitignore-style matching), matching the behavior
 * of CLAUDE.md conditional rules.
 *
 * @param filePaths Array of file paths being operated on
 * @param cwd Current working directory (paths are matched relative to cwd)
 * @returns Array of newly activated skill names
 */
export function activateConditionalSkillsForPaths(
  filePaths: string[],
  cwd: string,
): string[] {
  if (conditionalSkills.size === 0) {
    return []
  }

  const activated: string[] = []

  for (const [name, skill] of conditionalSkills) {
    if (skill.type !== 'prompt' || !skill.paths || skill.paths.length === 0) {
      continue
    }

    const skillIgnore = ignore().add(skill.paths)
    for (const filePath of filePaths) {
      const relativePath = isAbsolute(filePath)
        ? relative(cwd, filePath)
        : filePath

      // ignore() throws on empty strings, paths escaping the base (../),
      // and absolute paths (Windows cross-drive relative() returns absolute).
      // Files outside cwd can't match cwd-relative patterns anyway.
      if (
        !relativePath ||
        relativePath.startsWith('..') ||
        isAbsolute(relativePath)
      ) {
        continue
      }

      if (skillIgnore.ignores(relativePath)) {
        // Activate this skill by moving it to dynamic skills
        dynamicSkills.set(name, skill)
        conditionalSkills.delete(name)
        activatedConditionalSkillNames.add(name)
        activated.push(name)
        logForDebugging(
          `[skills] Activated conditional skill '${name}' (matched path: ${relativePath})`,
        )
        break
      }
    }
  }

  if (activated.length > 0) {
    logEvent('tengu_dynamic_skills_changed', {
      source:
        'conditional_paths' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      previousCount: dynamicSkills.size - activated.length,
      newCount: dynamicSkills.size,
      addedCount: activated.length,
      directoryCount: 0,
    })

    // Notify listeners that skills were loaded (so they can clear caches)
    skillsLoaded.emit()
  }

  return activated
}

/**
 * Gets the number of pending conditional skills (for testing/debugging).
 */
export function getConditionalSkillCount(): number {
  return conditionalSkills.size
}

/**
 * Clears dynamic skill state (for testing).
 */
export function clearDynamicSkills(): void {
  dynamicSkillDirs.clear()
  dynamicSkills.clear()
  conditionalSkills.clear()
  activatedConditionalSkillNames.clear()
}

// Expose createSkillCommand + parseSkillFrontmatterFields to MCP skill
// discovery via a leaf registry module. See mcpSkillBuilders.ts for why this
// indirection exists (a literal dynamic import from mcpSkills.ts fans a single
// edge out into many cycle violations; a variable-specifier dynamic import
// passes dep-cruiser but fails to resolve in Bun-bundled binaries at runtime).
// eslint-disable-next-line custom-rules/no-top-level-side-effects -- write-once registration, idempotent
registerMCPSkillBuilders({
  createSkillCommand,
  parseSkillFrontmatterFields,
})
