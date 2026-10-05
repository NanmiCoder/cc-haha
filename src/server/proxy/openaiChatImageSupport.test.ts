import { afterEach, describe, expect, test } from 'bun:test'
import {
  getOpenAIChatImageContentMode,
  isOpenAIChatImageRejection,
  rememberOpenAIChatTextOnlyModel,
  resetOpenAIChatImageSupportForTests,
} from './openaiChatImageSupport.js'
import type { OpenAIChatRequest } from './transform/types.js'

const withImage: OpenAIChatRequest = {
  model: 'deepseek-flash',
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: 'Look.' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ],
  }],
}
const withoutImage: OpenAIChatRequest = { model: 'deepseek-flash', messages: [{ role: 'user', content: 'Look.' }] }

afterEach(resetOpenAIChatImageSupportForTests)

describe('isOpenAIChatImageRejection', () => {
  test('accepts an explicit refusal of image input', () => {
    const refusals = [
      'Error from provider (DeepSeek): Failed to deserialize the JSON body into the target type: messages[0]: unknown variant `image_url`, expected `text` at line 1 column 120',
      'Error from provider (Moonshot): This model does not support image input',
      "messages.0.content.1.type: Input should be 'text'; received 'image_url'",
      'unsupported modality: image input is not available',
      'Qwen/Qwen3-8B is not a multimodal model',
      'Invalid content type. image_url is only supported by certain models.',
    ]

    for (const refusal of refusals) {
      expect(isOpenAIChatImageRejection(400, refusal, withImage)).toBe(true)
    }
    expect(isOpenAIChatImageRejection(422, refusals[2]!, withImage)).toBe(true)
  })

  test('rejects failures about one particular image', () => {
    const imageProblems = [
      "You uploaded an unsupported image. Please make sure your image has of one the following formats: ['png', 'jpeg', 'gif', 'webp'].",
      "Invalid image_url: unsupported MIME type 'image/heic'",
      'unsupported image format: image/bmp',
      'Image format not supported',
      'Image is not supported: exceeds the 20 MB limit',
      'image_url is not supported: failed to download the image',
      'Unsupported image: could not decode the image data',
      'Multiple images are not supported by this model',
      'Animated images are not supported',
      'Image type gif is not supported',
      'Image input is not supported in your region',
    ]

    for (const problem of imageProblems) {
      expect(isOpenAIChatImageRejection(400, problem, withImage)).toBe(false)
    }
  })

  test('rejects server failures and requests without images', () => {
    const refusal = 'This model does not support image input'
    expect(isOpenAIChatImageRejection(500, refusal, withImage)).toBe(false)
    expect(isOpenAIChatImageRejection(429, refusal, withImage)).toBe(false)
    expect(isOpenAIChatImageRejection(400, refusal, withoutImage)).toBe(false)
  })
})

describe('learned text-only models', () => {
  test('are scoped to one endpoint and model, ignoring case and trailing slashes', () => {
    rememberOpenAIChatTextOnlyModel('https://opencode.ai/zen/go/v1/chat/completions/', 'DeepSeek-V4-Pro')

    expect(getOpenAIChatImageContentMode('https://opencode.ai/zen/go/v1/chat/completions', 'deepseek-v4-pro')).toBe('text_only')
    expect(getOpenAIChatImageContentMode('https://opencode.ai/zen/go/v1/chat/completions', 'deepseek-flash')).toBe('vision')
    expect(getOpenAIChatImageContentMode('https://api.deepseek.com/chat/completions', 'deepseek-v4-pro')).toBe('vision')
  })

  test('expire after 30 minutes so the model is probed with images again', () => {
    const endpoint = 'https://opencode.ai/zen/go/v1/chat/completions'
    const learnedAt = 1_000_000
    rememberOpenAIChatTextOnlyModel(endpoint, 'deepseek-v4-pro', learnedAt)

    expect(getOpenAIChatImageContentMode(endpoint, 'deepseek-v4-pro', learnedAt + 29 * 60_000)).toBe('text_only')
    expect(getOpenAIChatImageContentMode(endpoint, 'deepseek-v4-pro', learnedAt + 31 * 60_000)).toBe('vision')
  })
})
