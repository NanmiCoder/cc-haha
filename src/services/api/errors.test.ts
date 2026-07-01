import { describe, expect, test } from 'bun:test'
import { BUSINESS_ERROR_CODES } from '../../constants/businessErrors.js'
import {
  getAssistantMessageFromError,
  getImageUnsupportedErrorMessage,
  isContextWindowExceededMessage,
  isUnsupportedImageInputErrorMessage,
  PROMPT_TOO_LONG_ERROR_MESSAGE,
} from './errors.js'

describe('image unsupported API errors', () => {
  test('detects provider-specific text-only model image rejections', () => {
    const unsupportedImageErrors = [
      'This model does not support image blocks',
      'unsupported modality: image input is not available',
      'Failed to deserialize the JSON body into the target type: messages[1]: unknown variant `image_url`, expected `text` at line 1 column 394097',
      "Invalid value for 'messages[0].content[1].type': 'image_url' is not one of ['text']",
      "messages.0.content.1.type: Input should be 'text'; received 'image_url'",
      'image_url content parts are not allowed for this model',
    ]

    for (const message of unsupportedImageErrors) {
      expect(isUnsupportedImageInputErrorMessage(message)).toBe(true)
    }
    expect(isUnsupportedImageInputErrorMessage('image exceeds maximum')).toBe(false)
  })

  test('maps unsupported image rejections to a recoverable synthetic error', () => {
    const msg = getAssistantMessageFromError(
      new Error('This model does not support image blocks'),
      'mimo-v2.5-pro',
    )

    expect(msg.isApiErrorMessage).toBe(true)
    expect(msg.businessErrorCode).toBe(BUSINESS_ERROR_CODES.IMAGE_UNSUPPORTED)
    expect(msg.errorDetails).toBe('This model does not support image blocks')
    expect(msg.message.content[0]).toMatchObject({
      type: 'text',
      text: getImageUnsupportedErrorMessage(),
    })
  })
})

describe('context-window-overflow relay errors', () => {
  test('detects third-party relay context-overflow wording', () => {
    const overflowErrors = [
      'API Error: 400 {"error":{"type":"context_too_large","message":"Your input exceeds the context window of this model. Please adjust your input and try again."}}',
      'Your input exceeds the context window of this model.',
      'context_too_large',
      'This model maximum context length exceeded. Please reduce your prompt.',
    ]
    for (const message of overflowErrors) {
      expect(isContextWindowExceededMessage(message)).toBe(true)
    }
    expect(isContextWindowExceededMessage('prompt is too long')).toBe(false)
    expect(isContextWindowExceededMessage('some unrelated 400 error')).toBe(false)
  })

  test('maps relay context_too_large to the prompt-too-long handling', () => {
    const raw =
      'API Error: 400 {"error":{"type":"context_too_large","message":"Your input exceeds the context window of this model. Please adjust your input and try again."}}'
    const msg = getAssistantMessageFromError(new Error(raw), 'gpt-5.5')

    expect(msg.isApiErrorMessage).toBe(true)
    expect(msg.businessErrorCode).toBe(BUSINESS_ERROR_CODES.PROMPT_TOO_LONG)
    // Reuses the canonical content string so the TUI/desktop render the
    // actionable "Context limit reached · /compact or /clear" guidance.
    expect(msg.message.content[0]).toMatchObject({
      type: 'text',
      text: PROMPT_TOO_LONG_ERROR_MESSAGE,
    })
    expect(msg.errorDetails).toBe(raw)
  })
})
