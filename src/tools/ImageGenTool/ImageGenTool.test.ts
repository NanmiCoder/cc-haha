import { afterEach, describe, expect, test } from 'bun:test'

import {
  IMAGE_GENERATION_API_KEY_ENV_KEY,
  IMAGE_GENERATION_BASE_URL_ENV_KEY,
  IMAGE_GENERATION_MODEL_ENV_KEY,
  IMAGE_GENERATION_PROVIDER_ID_ENV_KEY,
  IMAGE_GENERATION_PROVIDER_KIND_ENV_KEY,
} from '../../services/imageGeneration/config.js'
import { zodToJsonSchema } from '../../utils/zodToJsonSchema.js'
import {
  ImageEditTool,
  ImageGenTool,
} from './ImageGenTool.js'

const ENV_KEYS = [
  IMAGE_GENERATION_PROVIDER_KIND_ENV_KEY,
  IMAGE_GENERATION_PROVIDER_ID_ENV_KEY,
  IMAGE_GENERATION_BASE_URL_ENV_KEY,
  IMAGE_GENERATION_API_KEY_ENV_KEY,
  IMAGE_GENERATION_MODEL_ENV_KEY,
] as const

const originalEnv = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
)

function setImageRuntime(kind: 'openai_oauth' | 'grok_oauth' | 'openai_images') {
  process.env[IMAGE_GENERATION_PROVIDER_KIND_ENV_KEY] = kind
  process.env[IMAGE_GENERATION_PROVIDER_ID_ENV_KEY] = `${kind}-provider`
  process.env[IMAGE_GENERATION_MODEL_ENV_KEY] = `${kind}-image-model`
  if (kind === 'openai_images') {
    process.env[IMAGE_GENERATION_BASE_URL_ENV_KEY] = 'https://relay.test/v1'
    process.env[IMAGE_GENERATION_API_KEY_ENV_KEY] = 'relay-key'
  } else {
    delete process.env[IMAGE_GENERATION_BASE_URL_ENV_KEY]
    delete process.env[IMAGE_GENERATION_API_KEY_ENV_KEY]
  }
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('ImageGenTool', () => {
  test('is enabled only when the active provider has a complete image runtime', () => {
    for (const key of ENV_KEYS) delete process.env[key]
    expect(ImageGenTool.isEnabled()).toBe(false)

    process.env[IMAGE_GENERATION_PROVIDER_KIND_ENV_KEY] = 'openai_images'
    process.env[IMAGE_GENERATION_PROVIDER_ID_ENV_KEY] = 'relay'
    process.env[IMAGE_GENERATION_MODEL_ENV_KEY] = 'image-model'
    process.env[IMAGE_GENERATION_BASE_URL_ENV_KEY] = 'https://relay.test/v1'
    expect(ImageGenTool.isEnabled()).toBe(false)

    process.env[IMAGE_GENERATION_API_KEY_ENV_KEY] = 'relay-key'
    expect(ImageGenTool.isEnabled()).toBe(true)
  })

  test('defaults to one slot and preserves the structured result for the desktop', () => {
    setImageRuntime('openai_images')
    expect(ImageGenTool.strict).toBe(false)
    const jsonSchema = zodToJsonSchema(ImageGenTool.inputSchema)
    expect(jsonSchema.required).toEqual(['prompt', 'count'])
    expect(jsonSchema.properties).not.toHaveProperty('model')
    expect(jsonSchema.properties).not.toHaveProperty('input_images')
    expect(jsonSchema.properties).not.toHaveProperty('referenced_image_paths')
    expect(jsonSchema.properties?.prompt).not.toHaveProperty('maxLength')
    expect(ImageGenTool.inputSchema.parse({ prompt: 'A paper-cut fox' })).toEqual({
      prompt: 'A paper-cut fox',
      count: 1,
    })
    expect(() => ImageGenTool.inputSchema.parse({
      prompt: 'A paper-cut fox',
      model: 'default',
    })).toThrow()
    expect(ImageGenTool.inputSchema.parse({
      prompt: 'x'.repeat(8001),
    }).prompt).toHaveLength(8001)

    const output = {
      type: 'image_generation_result' as const,
      operation: 'generate' as const,
      inputImageCount: 0,
      providerId: 'relay',
      providerKind: 'openai_images' as const,
      model: 'image-model',
      prompt: 'A paper-cut fox',
      images: [{ path: '/tmp/fox.png', mimeType: 'image/png' as const }],
      durationMs: 42,
    }
    const block = ImageGenTool.mapToolResultToToolResultBlockParam(
      output,
      'image-tool-use',
    )

    expect(block).toEqual({
      tool_use_id: 'image-tool-use',
      type: 'tool_result',
      content: JSON.stringify(output),
    })
  })

  test('separates editing into a schema that requires real source paths', () => {
    setImageRuntime('openai_oauth')
    const jsonSchema = zodToJsonSchema(ImageEditTool.inputSchema)
    expect(jsonSchema.required).toEqual([
      'prompt',
      'count',
      'referenced_image_paths',
    ])
    expect(() => ImageEditTool.inputSchema.parse({
      prompt: 'Change the scarf color',
    })).toThrow()
    expect(ImageEditTool.inputSchema.parse({
      prompt: 'Combine these subjects while preserving their identity',
      referenced_image_paths: [
        '/staged/first.png',
        '/staged/second.png',
      ],
    })).toEqual({
      prompt: 'Combine these subjects while preserving their identity',
      count: 1,
      referenced_image_paths: [
        '/staged/first.png',
        '/staged/second.png',
      ],
    })
  })

  test('exposes image editing as a first-class tool without generation placeholders', async () => {
    setImageRuntime('openai_oauth')
    const input = ImageEditTool.inputSchema.parse({
      prompt: 'Change only the scarf color',
      count: 2,
      referenced_image_paths: ['/staged/fox.png'],
    })
    const output = {
      type: 'image_generation_result' as const,
      operation: 'edit' as const,
      inputImageCount: 1,
      providerId: 'openai-official',
      providerKind: 'openai_oauth' as const,
      model: 'gpt-image-2',
      prompt: input.prompt,
      images: [{ path: '/tmp/edited.png', mimeType: 'image/png' as const }],
      durationMs: 42,
    }

    expect(await ImageEditTool.description()).toContain('Edit images using exact source paths')
    expect(ImageEditTool.outputSchema.parse(output)).toEqual(output)
    expect(ImageEditTool.isEnabled()).toBe(true)
    expect(ImageEditTool.isConcurrencySafe()).toBe(true)
    expect(ImageEditTool.isReadOnly()).toBe(false)
    expect(ImageEditTool.toAutoClassifierInput(input)).toBe(
      '2 image edit(s): Change only the scarf color',
    )
    await expect(ImageEditTool.checkPermissions(input)).resolves.toEqual({
      behavior: 'allow',
      updatedInput: input,
    })
    expect(ImageEditTool.getToolUseSummary(input)).toBe(input.prompt)
    expect(ImageEditTool.getToolUseSummary({ ...input, prompt: '  ' })).toBeNull()
    expect(ImageEditTool.getActivityDescription(input)).toBe('Editing 2 image variations')
    expect(ImageEditTool.getActivityDescription({ ...input, count: 1 })).toBe('Editing image')
    expect(ImageEditTool.renderToolUseMessage()).toBeNull()
    expect(ImageEditTool.mapToolResultToToolResultBlockParam(output, 'edit-use')).toEqual({
      tool_use_id: 'edit-use',
      type: 'tool_result',
      content: JSON.stringify(output),
    })

    for (const key of ENV_KEYS) delete process.env[key]
    await expect(ImageEditTool.call(input, {
      abortController: new AbortController(),
    } as never)).rejects.toThrow('Image generation is not configured')
  })

  test('tells the agent not to retry provider failures automatically', async () => {
    setImageRuntime('openai_oauth')
    expect(await ImageGenTool.description()).toContain('Generate brand-new images')
    const prompt = await ImageGenTool.prompt()
    expect(prompt).toContain(
      'do not retry ImageGen automatically',
    )
    expect(prompt).toContain('has no source-image argument')
    expect(prompt).toContain('Preserve the full relevant user specification')
    expect(prompt).toContain('Provider and image model selection')
    expect(prompt).toContain('are not tool arguments')

    const editPrompt = await ImageEditTool.prompt()
    expect(editPrompt).toContain('referenced_image_paths is required')
    expect(editPrompt).toContain('never invent, search for, or substitute a path')
    expect(editPrompt).toContain('do not retry ImageEdit automatically')
  })
})
