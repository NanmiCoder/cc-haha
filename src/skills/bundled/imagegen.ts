import { getImageGenerationRuntimeConfig } from '../../services/imageGeneration/config.js'
import { parseFrontmatter } from '../../utils/frontmatterParser.js'
import { registerBundledSkill } from '../bundledSkills.js'
import { IMAGEGEN_SKILL_MD } from './imagegenContent.js'

const { frontmatter, content: SKILL_BODY } = parseFrontmatter(IMAGEGEN_SKILL_MD)

const DESCRIPTION =
  typeof frontmatter.description === 'string'
    ? frontmatter.description
    : 'Generate images with the desktop image provider.'

export function registerImagegenSkill(): void {
  registerBundledSkill({
    name: 'imagegen',
    description: DESCRIPTION,
    allowedTools: ['ImageGen', 'ImageEdit'],
    userInvocable: true,
    isEnabled: () => getImageGenerationRuntimeConfig() !== null,
    async getPromptForCommand(args) {
      const parts = [SKILL_BODY.trimStart()]
      if (args) parts.push(`## User request\n\n${args}`)
      return [{ type: 'text', text: parts.join('\n\n') }]
    },
  })
}
