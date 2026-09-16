import { describe, expect, test } from 'bun:test'
import { BUSINESS_ERROR_CODES } from '../src/constants/businessErrors.js'
import { getImageUnsupportedErrorMessage } from '../src/services/api/errors.js'
import { roughTokenCountEstimationForAPIRequest } from '../src/services/tokenEstimation.js'
import type { UserMessage } from '../src/types/message.js'
import {
  createAssistantAPIErrorMessage,
  createUserMessage,
  normalizeMessagesForAPI,
} from '../src/utils/messages.js'

const imageBlock = (data: string) => ({
  type: 'image' as const,
  source: {
    type: 'base64' as const,
    media_type: 'image/png' as const,
    data,
  },
})

describe('media error recovery', () => {
  test('strips images after an unsupported-image model error', () => {
    const imageUser = createUserMessage({
      content: [
        { type: 'text', text: 'describe this screenshot' },
        imageBlock('base64-image-payload'),
        { type: 'text', text: '[Image source: /tmp/screenshot.png]' },
      ],
      uuid: '00000000-0000-4000-8000-000000000001',
    })
    const unsupported = createAssistantAPIErrorMessage({
      content: getImageUnsupportedErrorMessage(),
      error: 'invalid_request',
    })
    const nextUser = createUserMessage({
      content: 'continue with text only',
      uuid: '00000000-0000-4000-8000-000000000002',
    })

    const normalized = normalizeMessagesForAPI([imageUser, unsupported, nextUser])
    const serialized = JSON.stringify(normalized)

    expect(serialized).not.toContain('base64-image-payload')
    expect(serialized).toContain('describe this screenshot')
    expect(serialized).toContain('continue with text only')
  })

  test('strips images using stable business error codes', () => {
    const imageUser = createUserMessage({
      content: [
        { type: 'text', text: 'describe this screenshot' },
        imageBlock('base64-image-payload'),
      ],
      uuid: '00000000-0000-4000-8000-000000000003',
    })
    const unsupported = createAssistantAPIErrorMessage({
      content: 'localized display text',
      error: 'invalid_request',
      businessErrorCode: BUSINESS_ERROR_CODES.IMAGE_UNSUPPORTED,
    })
    const nextUser = createUserMessage({
      content: 'continue with text only',
      uuid: '00000000-0000-4000-8000-000000000004',
    })

    const normalized = normalizeMessagesForAPI([imageUser, unsupported, nextUser])
    const serialized = JSON.stringify(normalized)

    expect(serialized).not.toContain('base64-image-payload')
    expect(serialized).toContain('describe this screenshot')
    expect(serialized).toContain('continue with text only')
  })

  test('keeps stripping while the failing model is still selected', () => {
    const imageUser = createUserMessage({
      content: [
        { type: 'text', text: 'describe this screenshot' },
        imageBlock('base64-image-payload'),
      ],
      uuid: '00000000-0000-4000-8000-000000000005',
    })
    const unsupported = createAssistantAPIErrorMessage({
      content: 'localized display text',
      error: 'invalid_request',
      businessErrorCode: BUSINESS_ERROR_CODES.IMAGE_UNSUPPORTED,
      sourceModel: 'nonvision-model',
    })

    const normalized = normalizeMessagesForAPI(
      [imageUser, unsupported],
      [],
      'nonvision-model',
    )

    expect(JSON.stringify(normalized)).not.toContain('base64-image-payload')
  })

  test('replays the image after switching to a different model', () => {
    const imageUser = createUserMessage({
      content: [
        { type: 'text', text: 'describe this screenshot' },
        imageBlock('base64-image-payload'),
      ],
      uuid: '00000000-0000-4000-8000-000000000006',
    })
    const unsupported = createAssistantAPIErrorMessage({
      content: 'localized display text',
      error: 'invalid_request',
      businessErrorCode: BUSINESS_ERROR_CODES.IMAGE_UNSUPPORTED,
      sourceModel: 'nonvision-model',
    })

    const normalized = normalizeMessagesForAPI(
      [imageUser, unsupported],
      [],
      'vision-model',
    )

    expect(JSON.stringify(normalized)).toContain('base64-image-payload')
  })

  test('legacy anchors without sourceModel strip regardless of current model', () => {
    const imageUser = createUserMessage({
      content: [
        { type: 'text', text: 'describe this screenshot' },
        imageBlock('base64-image-payload'),
      ],
      uuid: '00000000-0000-4000-8000-000000000007',
    })
    const unsupported = createAssistantAPIErrorMessage({
      content: 'localized display text',
      error: 'invalid_request',
      businessErrorCode: BUSINESS_ERROR_CODES.IMAGE_UNSUPPORTED,
    })

    const normalized = normalizeMessagesForAPI(
      [imageUser, unsupported],
      [],
      'vision-model',
    )

    expect(JSON.stringify(normalized)).not.toContain('base64-image-payload')
  })
})

describe('media context estimation', () => {
  test('does not count base64 image bytes as text tokens', () => {
    const rawBase64 = 'a'.repeat(1_000_000)
    const tokens = roughTokenCountEstimationForAPIRequest(
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is in this image?' },
            imageBlock(rawBase64),
          ] as UserMessage['message']['content'],
        },
      ],
      [],
    )

    expect(tokens).toBeGreaterThanOrEqual(2_000)
    expect(tokens).toBeLessThan(3_000)
  })
})
