import { describe, expect, test } from 'bun:test'
import { APIError } from '@anthropic-ai/sdk'
import { BUSINESS_ERROR_CODES } from '../../constants/businessErrors.js'
import {
  getAssistantMessageFromError,
  getImageUnsupportedErrorMessage,
  isContextOverflowErrorText,
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
    expect(msg.sourceModel).toBe('mimo-v2.5-pro')
    expect(msg.message.content[0]).toMatchObject({
      type: 'text',
      text: getImageUnsupportedErrorMessage(),
    })
  })

  test('falls back to image_unsupported when a 400 with unrecognized wording hit a request carrying images', () => {
    const message = 'unsupported content block type: only text is allowed for this model'
    const error = new APIError(
      400,
      {
        type: 'error',
        error: { type: 'invalid_request_error', message },
      },
      message,
      undefined,
    )
    const messagesForAPI = [
      {
        type: 'user' as const,
        message: {
          role: 'user' as const,
          content: [
            { type: 'text', text: 'look at this' },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'AAA' },
            },
          ],
        },
      },
    ]

    // The wording alone must not match the text classifier, otherwise this
    // test stops exercising the request-context fallback.
    expect(isUnsupportedImageInputErrorMessage(message)).toBe(false)

    const msg = getAssistantMessageFromError(error, 'deepseek-v4-pro', {
      messagesForAPI: messagesForAPI as never,
    })

    expect(msg.isApiErrorMessage).toBe(true)
    expect(msg.businessErrorCode).toBe(BUSINESS_ERROR_CODES.IMAGE_UNSUPPORTED)
    expect(msg.sourceModel).toBe('deepseek-v4-pro')
  })

  test('does not fall back to image_unsupported when the failed request carried no images', () => {
    const message = 'unsupported content block type: only text is allowed for this model'
    const error = new APIError(
      400,
      {
        type: 'error',
        error: { type: 'invalid_request_error', message },
      },
      message,
      undefined,
    )
    const messagesForAPI = [
      {
        type: 'user' as const,
        message: { role: 'user' as const, content: 'plain text only' },
      },
    ]

    const msg = getAssistantMessageFromError(error, 'deepseek-v4-pro', {
      messagesForAPI: messagesForAPI as never,
    })

    expect(msg.isApiErrorMessage).toBe(true)
    expect(msg.businessErrorCode).toBeUndefined()
  })

  test('does not fall back for non-400/422 API errors even when images were sent', () => {
    const error = new APIError(
      500,
      {
        type: 'error',
        error: { type: 'api_error', message: 'internal error' },
      },
      'internal error',
      undefined,
    )
    const messagesForAPI = [
      {
        type: 'user' as const,
        message: {
          role: 'user' as const,
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'AAA' },
            },
          ],
        },
      },
    ]

    const msg = getAssistantMessageFromError(error, 'deepseek-v4-pro', {
      messagesForAPI: messagesForAPI as never,
    })

    expect(msg.businessErrorCode).toBeUndefined()
  })
})

describe('context overflow errors', () => {
  test('matches provider-specific overflow wordings', () => {
    const overflowMessages = [
      'prompt is too long: 137500 tokens > 135000 maximum',
      'Prompt is too long',
      'input is too long for requested model',
      "This model's maximum context length is 262144 tokens",
      'context_length_exceeded',
      '401 {"error":{"type":"authentication_error","message":"k3-256k supports only 256K context."}}',
      'Request exceeds the context window of this model',
    ]

    for (const message of overflowMessages) {
      expect(isContextOverflowErrorText(message)).toBe(true)
    }
  })

  test('does not match unrelated or separately-handled errors', () => {
    const negatives = [
      'Invalid API key',
      'OAuth token has been revoked',
      'This model does not support image blocks',
      // Handled by the max_tokens adjustment retry path, not the PTL path.
      'input length and `max_tokens` exceed context limit: 190000 + 20000 > 200000',
    ]

    for (const message of negatives) {
      expect(isContextOverflowErrorText(message)).toBe(false)
    }
  })

  test('maps a 401-wrapped overflow to Prompt is too long, not a login prompt (#1162)', () => {
    const message = 'k3-256k supports only 256K context.'
    const error = new APIError(
      401,
      {
        type: 'error',
        error: { type: 'authentication_error', message },
      },
      message,
      undefined,
    )

    const msg = getAssistantMessageFromError(error, 'k3-256k')

    expect(msg.isApiErrorMessage).toBe(true)
    expect(msg.businessErrorCode).toBe(BUSINESS_ERROR_CODES.PROMPT_TOO_LONG)
    expect(msg.message.content[0]).toMatchObject({
      type: 'text',
      text: PROMPT_TOO_LONG_ERROR_MESSAGE,
    })
  })
})
