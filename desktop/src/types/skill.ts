export type SkillSource = 'user' | 'project' | 'plugin' | 'mcp' | 'bundled'

/**
 * Which directory convention a skill was found in: our native `.claude/skills`
 * or the cross-client `.agents/skills` shared with Codex, Cursor, and Gemini CLI.
 * Absent for plugin/mcp/bundled skills, and for servers predating the field.
 */
export type SkillRootFlavor = 'claude' | 'agents'

export type SkillMeta = {
  name: string
  displayName?: string
  description: string
  source: SkillSource
  rootFlavor?: SkillRootFlavor
  userInvocable: boolean
  /** A lean session can run it. Absent for servers predating the field, which counts as yes. */
  leanCompatible?: boolean
  version?: string
  contentLength: number
  hasDirectory: boolean
  pluginName?: string
}

export type FileTreeNode = {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: FileTreeNode[]
}

export type SkillFrontmatter = Record<string, unknown>

export type SkillFile = {
  path: string
  content: string
  language: string
  frontmatter?: SkillFrontmatter
  body?: string
  isEntry?: boolean
}

export type SkillMarketMeta = {
  id: string
  source: string
  slug: string
  version?: string
  installedAt?: string
  fileCount?: number
}

export type SkillDetail = {
  meta: SkillMeta
  tree: FileTreeNode[]
  files: SkillFile[]
  skillRoot: string
  /** Present when the skill was installed from the Skills Market. */
  marketMeta?: SkillMarketMeta
}
