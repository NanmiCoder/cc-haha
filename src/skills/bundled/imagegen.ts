import { getImageGenerationRuntimeConfig } from '../../services/imageGeneration/config.js'
import { parseFrontmatter } from '../../utils/frontmatterParser.js'
import { registerBundledSkill } from '../bundledSkills.js'
import { IMAGEGEN_SKILL_MD } from './imagegenContent.js'

const { frontmatter, content: SKILL_BODY } = parseFrontmatter(IMAGEGEN_SKILL_MD)

const DESCRIPTION =
  typeof frontmatter.description === 'string'
    ? frontmatter.description
    : 'Generate images with the desktop image provider.'

export const IMAGEGEN_SKILL_NAME = 'imagegen'

/**
 * The image provider reaches the CLI as env the desktop injects per session, so
 * whether this skill exists depends on whose env is asked. Callers outside the
 * session's CLI (the desktop server) must pass that session's env explicitly.
 */
export function isImagegenAvailable(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return getImageGenerationRuntimeConfig(env) !== null
}

export function registerImagegenSkill(): void {
  registerBundledSkill({
    name: IMAGEGEN_SKILL_NAME,
    description: DESCRIPTION,
    allowedTools: ['ImageGen', 'ImageEdit'],
    userInvocable: true,
    isEnabled: () => isImagegenAvailable(),
    async getPromptForCommand(args) {
      const parts = [SKILL_BODY.trimStart()]
      if (args) parts.push(`## User request\n\n${args}`)
      return [{ type: 'text', text: parts.join('\n\n') }]
    },
  })
}
