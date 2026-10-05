import { describe, expect, test } from 'bun:test'
import { isUnsupportedImageInputErrorMessage } from './unsupportedImageInput.js'

describe('isUnsupportedImageInputErrorMessage', () => {
  test('recognizes rejections relayed through a gateway prefix', () => {
    // OpenCode Zen/Go wraps the upstream message as "Error from provider (<name>): <message>".
    const relayed = [
      'Error from provider (DeepSeek): Failed to deserialize the JSON body into the target type: messages[2]: unknown variant `image_url`, expected `text` at line 1 column 512',
      'Error from provider (Moonshot): This model does not support image input',
      '{"error":{"message":"Error from provider: Invalid value for \'messages[0].content[1].type\': \'image_url\' is not one of [\'text\']"}}',
      // vLLM names the modality instead of images.
      'Qwen/Qwen3-8B is not a multimodal model',
      'Invalid content type. image_url is only supported by certain models.',
    ]

    for (const message of relayed) {
      expect(isUnsupportedImageInputErrorMessage(message)).toBe(true)
    }
  })

  test('ignores image failures that are not about the model refusing images', () => {
    const unrelated = [
      'image exceeds maximum',
      'Error from provider (DeepSeek): Image is too large: 34 MB exceeds the 20 MB limit',
      'Error from provider (DeepSeek): This model maximum context length is 131072 tokens',
      'unsupported content block type: only text is allowed for this model',
    ]

    for (const message of unrelated) {
      expect(isUnsupportedImageInputErrorMessage(message)).toBe(false)
    }
  })
})
