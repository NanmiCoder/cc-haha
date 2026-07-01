/**
 * Active Skills — always-on skill injection into the system prompt.
 *
 * When a user marks a skill as "active" (global or project scope), its
 * SKILL.md content is read from the installed skill directory and injected
 * into the system prompt at conversation start. This allows constraint-type
 * skills (e.g. coding guidelines) to apply automatically without requiring
 * a /slash-command invocation.
 *
 * Deduplication: if the same skill name appears in both global and project
 * activeSkills, it is only injected once (project takes precedence).
 */

import { join } from 'node:path'
import { getGlobalConfig, getCurrentProjectConfig } from '../utils/config.js'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'
import { getFsImplementation } from '../utils/fsOperations.js'
import { logForDebugging } from '../utils/debug.js'

/**
 * Returns the merged list of active skill names, deduplicated.
 * Project-level activeSkills override global (same name counted once).
 */
export function getActiveSkillNames(): string[] {
  const globalConfig = getGlobalConfig()
  const projectConfig = getCurrentProjectConfig()

  const globalSkills = globalConfig.activeSkills ?? []
  const projectSkills = projectConfig.activeSkills ?? []

  // Deduplicate: project entries take precedence (appear first)
  const seen = new Set<string>()
  const result: string[] = []

  for (const name of projectSkills) {
    if (!seen.has(name)) {
      seen.add(name)
      result.push(name)
    }
  }
  for (const name of globalSkills) {
    if (!seen.has(name)) {
      seen.add(name)
      result.push(name)
    }
  }

  return result
}

/**
 * Reads the SKILL.md content for a given installed skill name.
 * Looks in ~/.claude/skills/<name>/SKILL.md
 * Returns null if the skill is not installed or unreadable.
 */
async function readSkillContent(skillName: string): Promise<string | null> {
  const fs = getFsImplementation()
  const skillPath = join(getClaudeConfigHomeDir(), 'skills', skillName, 'SKILL.md')

  try {
    return await fs.readFile(skillPath, { encoding: 'utf-8' })
  } catch {
    logForDebugging(
      `[active_skills] Could not read SKILL.md for "${skillName}" at ${skillPath}`,
      { level: 'debug' },
    )
    return null
  }
}

/**
 * Builds the system prompt section for all active skills.
 * Returns null if no active skills are configured or readable.
 */
export async function buildActiveSkillsPrompt(): Promise<string | null> {
  const skillNames = getActiveSkillNames()
  if (skillNames.length === 0) return null

  const entries: string[] = []

  for (const name of skillNames) {
    const content = await readSkillContent(name)
    if (content) {
      entries.push(content.trim())
    }
  }

  if (entries.length === 0) return null

  return [
    '# Active Skills',
    '',
    'The following skills are always active and should be followed in every response:',
    '',
    ...entries.map((content, i) => {
      if (entries.length === 1) return content
      return `---\n\n${content}`
    }),
  ].join('\n')
}
