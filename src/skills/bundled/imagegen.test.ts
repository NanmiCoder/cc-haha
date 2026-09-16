import { afterEach, describe, expect, test } from 'bun:test'

import {
  IMAGE_GENERATION_MODEL_ENV_KEY,
  IMAGE_GENERATION_BASE_URL_ENV_KEY,
  IMAGE_GENERATION_API_KEY_ENV_KEY,
  IMAGE_GENERATION_PROVIDER_ID_ENV_KEY,
  IMAGE_GENERATION_PROVIDER_KIND_ENV_KEY,
} from '../../services/imageGeneration/config.js'
import type { ToolUseContext } from '../../Tool.js'
import {
  clearBundledSkills,
  getBundledSkills,
} from '../bundledSkills.js'
import { registerImagegenSkill } from './imagegen.js'
import { PROVIDER_PRESETS } from '../../server/config/providerPresets.js'
import { buildProviderManagedEnv } from '../../server/services/providerRuntimeEnv.js'
import { ImageGenTool, ImageEditTool } from '../../tools/ImageGenTool/ImageGenTool.js'

const ENV_KEYS = [
  IMAGE_GENERATION_PROVIDER_KIND_ENV_KEY,
  IMAGE_GENERATION_PROVIDER_ID_ENV_KEY,
  IMAGE_GENERATION_MODEL_ENV_KEY,
  IMAGE_GENERATION_BASE_URL_ENV_KEY,
  IMAGE_GENERATION_API_KEY_ENV_KEY,
] as const
const originalEnv = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
)

afterEach(() => {
  clearBundledSkills()
  for (const key of ENV_KEYS) {
    const value = originalEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('bundled imagegen skill', () => {
  test('enables the skill and native tools from the ApiSmart preset without exposing its key', async () => {
    const preset = PROVIDER_PRESETS.find(p => p.id === 'apismart')!
    const env = buildProviderManagedEnv({
      id: 'apismart-test', presetId: preset.id, name: preset.name,
      baseUrl: preset.baseUrl, apiKey: 'fake-apismart-image-key', apiFormat: preset.apiFormat,
      models: preset.defaultModels, imageGeneration: preset.defaultImageGeneration,
    })
    for (const key of ENV_KEYS) process.env[key] = env[key]
    registerImagegenSkill()
    const skill = getBundledSkills().find(command => command.name === 'imagegen')!
    expect(skill.isEnabled?.()).toBe(true)
    expect(ImageGenTool.isEnabled()).toBe(true)
    expect(ImageEditTool.isEnabled()).toBe(true)
    if (skill.type !== 'prompt') throw new Error('Expected bundled imagegen prompt')
    const prompt = JSON.stringify(await skill.getPromptForCommand('Generate a poster', {} as ToolUseContext))
    expect(prompt).toContain('ImageGen')
    expect(prompt).not.toContain('fake-apismart-image-key')
    delete process.env[IMAGE_GENERATION_MODEL_ENV_KEY]
    expect(skill.isEnabled?.()).toBe(false)
    expect(ImageGenTool.isEnabled()).toBe(false)
  })

  test('joins the skill prompt to the native ImageGen tool without credentials', async () => {
    process.env[IMAGE_GENERATION_PROVIDER_KIND_ENV_KEY] = 'openai_oauth'
    process.env[IMAGE_GENERATION_PROVIDER_ID_ENV_KEY] = 'openai-official'
    process.env[IMAGE_GENERATION_MODEL_ENV_KEY] = 'gpt-image-2'
    registerImagegenSkill()

    const skill = getBundledSkills().find((command) => command.name === 'imagegen')
    expect(skill).toBeDefined()
    expect(skill?.allowedTools).toEqual(['ImageGen', 'ImageEdit'])
    expect(skill?.isEnabled?.()).toBe(true)

    if (!skill || skill.type !== 'prompt') return
    const prompt = await skill.getPromptForCommand(
      'Create two poster variants',
      {} as ToolUseContext,
    )
    const text = prompt
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
    expect(text).toContain('Create two poster variants')
    expect(text).toContain('ImageGen')
    expect(text).toContain('ImageEdit')
    expect(text).toContain('do not retry the image tool automatically')
    expect(text).toContain('do not repeat, link, or embed the returned local paths')
    expect(text).toContain('latest selected output as the next turn')
    expect(text).toContain('one call per image')
    expect(text).toContain('schema intentionally has no image-path argument')
    expect(text).toContain('<code>ImageEdit</code> requires <code>referenced_image_paths</code>')
    expect(text).toContain('Never invent, search for, or substitute another filesystem path')
    expect(text).toContain('Preserve all relevant user-specified detail')
    expect(text).toContain('Provider and image model selection come from')
    expect(text).toContain('do not add either to the tool arguments')
    expect(text).not.toContain('CC_HAHA_IMAGE_API_KEY')
  })
})
