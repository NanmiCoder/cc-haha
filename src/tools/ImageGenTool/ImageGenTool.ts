import { z } from 'zod/v4'

import {
  getImageGenerationRuntimeConfig,
} from '../../services/imageGeneration/config.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  generateImages,
  type ImageGenerationOutput,
} from './backend.js'
import {
  IMAGE_EDIT_TOOL_NAME,
  IMAGE_GEN_TOOL_NAME,
} from './constants.js'

const ASPECT_RATIOS = [
  'auto',
  '1:1',
  '16:9',
  '9:16',
  '4:3',
  '3:4',
  '3:2',
  '2:3',
  '2:1',
  '1:2',
  '19.5:9',
  '9:19.5',
  '20:9',
  '9:20',
] as const

function commonInputShape() {
  return {
    prompt: z
      .string()
      .min(1)
      .describe('A complete visual prompt preserving all relevant user-specified detail'),
    count: z
      .number()
      .int()
      .min(1)
      .max(4)
      .default(1)
      .describe('Number of variations for this exact prompt, from 1 to 4'),
    aspect_ratio: z
      .enum(ASPECT_RATIOS)
      .optional()
      .describe('Requested output aspect ratio'),
    resolution: z
      .enum(['1k', '2k'])
      .optional()
      .describe('Requested image resolution when supported'),
    size: z
      .enum(['auto', '1024x1024', '1024x1536', '1536x1024'])
      .optional()
      .describe('OpenAI-compatible image size'),
    quality: z.enum(['auto', 'low', 'medium', 'high']).optional(),
    background: z.enum(['auto', 'opaque', 'transparent']).optional(),
    output_format: z.enum(['png', 'jpeg', 'webp']).optional(),
  }
}

const generationInputSchema = lazySchema(() =>
  z.strictObject(commonInputShape()),
)
type GenerationInputSchema = ReturnType<typeof generationInputSchema>

const editInputSchema = lazySchema(() =>
  z.strictObject({
    ...commonInputShape(),
    referenced_image_paths: z
      .array(z
        .string()
        .min(1)
        .describe('Exact absolute path from an [Image source: ...] attachment or a prior ImageGen result'))
      .min(1)
      .max(3)
      .describe('Ordered source images to edit or use as visual references'),
  }),
)
type EditInputSchema = ReturnType<typeof editInputSchema>

const generatedImageSchema = z.object({
  path: z.string(),
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  revisedPrompt: z.string().optional(),
})

const outputSchema = lazySchema(() =>
  z.object({
    type: z.literal('image_generation_result'),
    operation: z.enum(['generate', 'edit']),
    inputImageCount: z.number().int().min(0).max(3),
    providerId: z.string(),
    providerKind: z.enum(['openai_oauth', 'grok_oauth', 'openai_images']),
    model: z.string(),
    prompt: z.string(),
    images: z.array(generatedImageSchema).min(1),
    durationMs: z.number().nonnegative(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export const ImageGenTool = buildTool({
  name: IMAGE_GEN_TOOL_NAME,
  searchHint: 'generate images or artwork from a visual prompt',
  maxResultSizeChars: 100_000,
  strict: false,
  shouldDefer: true,
  async description() {
    return 'Generate brand-new images from a text prompt with the image provider configured for this desktop session. This tool does not accept source-image paths; use ImageEdit for edits.'
  },
  async prompt() {
    return 'Use this tool only for a brand-new image. It has no source-image argument; never invent or pass a placeholder path. Preserve the full relevant user specification. Provider and image model selection come from the current desktop session and are not tool arguments. One call represents one distinct prompt; use count only for variations of that same prompt. The tool saves finished raster images locally and returns their absolute paths. If a provider call fails, do not retry ImageGen automatically; explain the error and wait for the user to decide.'
  },
  get inputSchema(): GenerationInputSchema {
    return generationInputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isEnabled() {
    return getImageGenerationRuntimeConfig() !== null
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return false
  },
  toAutoClassifierInput(input) {
    return `${input.count} image(s): ${input.prompt}`
  },
  async checkPermissions(input) {
    return { behavior: 'allow', updatedInput: input }
  },
  getToolUseSummary(input) {
    return input?.prompt?.trim() || null
  },
  getActivityDescription(input) {
    return input?.count && input.count > 1
      ? `Generating ${input.count} images`
      : 'Generating image'
  },
  renderToolUseMessage() {
    return null
  },
  async call(input, context) {
    const config = getImageGenerationRuntimeConfig()
    if (!config) {
      throw new Error(
        'Image generation is not configured for the current provider. Enable it in provider settings.',
      )
    }
    return {
      data: await generateImages(input, config, {
        signal: context.abortController.signal,
      }),
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: JSON.stringify(output),
    }
  },
} satisfies ToolDef<GenerationInputSchema, ImageGenerationOutput>)

export const ImageEditTool = buildTool({
  name: IMAGE_EDIT_TOOL_NAME,
  searchHint: 'edit or transform an attached or previously generated image',
  maxResultSizeChars: 100_000,
  strict: false,
  shouldDefer: true,
  async description() {
    return 'Edit images using exact source paths from user attachments or earlier ImageGen results.'
  },
  async prompt() {
    return 'Use this tool only when the user wants to edit, combine, or visually reference existing images. referenced_image_paths is required and may contain only exact paths surfaced by [Image source: ...] in the current conversation or returned by a prior ImageGen call; never invent, search for, or substitute a path. Preserve the full relevant user specification and repeat preservation constraints in every edit prompt. Provider and image model selection come from the current desktop session and are not tool arguments. One call represents one distinct prompt; use count only for variations of that same edit. If a provider call fails, do not retry ImageEdit automatically; explain the error and wait for the user to decide.'
  },
  get inputSchema(): EditInputSchema {
    return editInputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isEnabled() {
    return getImageGenerationRuntimeConfig() !== null
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return false
  },
  toAutoClassifierInput(input) {
    return `${input.count} image edit(s): ${input.prompt}`
  },
  async checkPermissions(input) {
    return { behavior: 'allow', updatedInput: input }
  },
  getToolUseSummary(input) {
    return input?.prompt?.trim() || null
  },
  getActivityDescription(input) {
    return input?.count && input.count > 1
      ? `Editing ${input.count} image variations`
      : 'Editing image'
  },
  renderToolUseMessage() {
    return null
  },
  async call(input, context) {
    const config = getImageGenerationRuntimeConfig()
    if (!config) {
      throw new Error(
        'Image generation is not configured for the current provider. Enable it in provider settings.',
      )
    }
    return {
      data: await generateImages(input, config, {
        signal: context.abortController.signal,
      }),
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: JSON.stringify(output),
    }
  },
} satisfies ToolDef<EditInputSchema, ImageGenerationOutput>)
