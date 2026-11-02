import { describe, expect, test } from 'bun:test'
import { APIConnectionError, APIConnectionTimeoutError, APIError } from '@anthropic-ai/sdk'
import { getIsInteractive, setIsInteractive } from '../../bootstrap/state.js'
import { BUSINESS_ERROR_CODES } from '../../constants/businessErrors.js'
import {
  getAssistantMessageFromError,
  categorizeRetryableAPIError,
  getRetryableAPIErrorDiagnostics,
  getPromptTooLongTokenGap,
  getImageUnsupportedErrorMessage,
  isContextOverflowErrorText,
  isUnsupportedImageInputErrorMessage,
  measureRequestPayload,
  PROMPT_TOO_LONG_ERROR_MESSAGE,
  parsePromptTooLongTokenCounts,
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
  test('uses the full requested DeepSeek token count to recover an oversized session (#1373)', () => {
    const message = "This model's maximum context length is 1048576 tokens. However, you requested 3763011 tokens (3731011 in the messages, 32000 in the completion)."
    const error = new APIError(400, {
      error: { type: 'invalid_request_error', message },
    }, message, undefined)
    const assistant = getAssistantMessageFromError(error, 'deepseek-v4-flash')

    expect(parsePromptTooLongTokenCounts(message)).toEqual({
      actualTokens: 3763011,
      limitTokens: 1048576,
    })
    expect(getPromptTooLongTokenGap(assistant)).toBe(2714435)
  })

  test('parses wrapped and case-insensitive Anthropic and OpenAI token counts', () => {
    for (const message of [
      '400 {"error":{"message":"PROMPT IS TOO LONG: 137500 tokens > 135000 maximum"}}',
      '400 {"error":{"message":"This model\'s MAXIMUM CONTEXT LENGTH IS 135000 tokens. However, you REQUESTED 137500 tokens."}}',
    ]) {
      expect(parsePromptTooLongTokenCounts(message)).toEqual({
        actualTokens: 137500,
        limitTokens: 135000,
      })
    }
  })

  test('leaves missing, malformed, and invalid token counts unparsed', () => {
    for (const message of [
      'Prompt is too long',
      'maximum context length is 1048576 tokens',
      'you requested 3763011 tokens',
      'maximum context length is -1 tokens. However, you requested 3 tokens.',
      'maximum context length is 1.5 tokens. However, you requested 3 tokens.',
      'maximum context length is 0 tokens. However, you requested 3 tokens.',
      'maximum context length is 1 tokens. However, you requested 9007199254740992 tokens.',
      'prompt is too long: 0 tokens > 135000 maximum',
    ]) {
      expect(parsePromptTooLongTokenCounts(message)).toEqual({
        actualTokens: undefined,
        limitTokens: undefined,
      })
    }
  })

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

describe('request too large (HTTP 413)', () => {
  const MODEL = 'claude-sonnet-5-5'
  const nginxHtml =
    '<html>\r\n<head><title>413 Request Entity Too Large</title></head>\r\n<body>\r\n<center><h1>413 Request Entity Too Large</h1></center>\r\n<hr><center>nginx/1.18.0</center>\r\n</body>\r\n</html>'
  const relayBody = {
    error: { message: 'request body too large, limit is 10 MB', type: 'invalid_request_error' },
  }
  const anthropicBody = {
    type: 'error',
    error: { type: 'request_too_large', message: 'Request exceeds the maximum allowed number of bytes.' },
  }
  const sources = [
    {
      name: 'nginx in front of a relay',
      error: new APIError(413, undefined, `413 ${nginxHtml}`, undefined),
      upstream: 'nginx/1.18.0',
    },
    {
      name: 'a relay that names its own limit',
      error: new APIError(413, relayBody, `413 ${JSON.stringify(relayBody)}`, undefined),
      upstream: 'limit is 10 MB',
    },
    {
      name: 'the Anthropic API',
      error: new APIError(413, anthropicBody, `413 ${JSON.stringify(anthropicBody)}`, undefined),
      upstream: 'maximum allowed number of bytes',
    },
  ]
  const textOf = (msg: { message: { content: unknown[] } }) =>
    (msg.message.content[0] as { text: string }).text
  const image = (chars: number) => ({
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(chars) },
  })
  const userTurn = (content: unknown[]) => ({
    type: 'user' as const,
    message: { role: 'user' as const, content },
  })
  const relayRejection = sources[1]!.error

  test.each(sources)(
    'does not invent a size limit when $name rejects the request',
    ({ error, upstream }) => {
      const msg = getAssistantMessageFromError(error, MODEL)
      const text = textOf(msg)

      // The old wording hard-coded the PDF limit ("max 20MB") for every 413,
      // which is wrong for a relay with its own limit and for the API's real one.
      expect(text).not.toMatch(/\d\s?MB/)
      expect(text).not.toMatch(/smaller file/i)
      expect(text).toContain('HTTP 413')
      expect(msg.businessErrorCode).toBe(BUSINESS_ERROR_CODES.REQUEST_TOO_LARGE)
      // Whoever rejected the request said something; keep it for diagnosis.
      expect(msg.errorDetails).toStartWith('request_too_large: ')
      expect(msg.errorDetails).toContain(upstream)
    },
  )

  test('reports how much of the rejected request was images and documents', () => {
    const messagesForAPI = [
      userTurn([{ type: 'text', text: 'take a screenshot' }]),
      userTurn([
        { type: 'tool_result', tool_use_id: 't1', content: [image(2 * 1024 * 1024)] },
      ]),
    ]

    const text = textOf(
      getAssistantMessageFromError(relayRejection, MODEL, {
        messagesForAPI: messagesForAPI as never,
      }),
    )

    expect(text).toContain('about 2MB')
    expect(text).toContain('2MB is images or documents')
    expect(text).toContain('placeholders')
  })

  test('says so when the rejected request carried no images or documents', () => {
    const messagesForAPI = [
      userTurn([
        { type: 'tool_result', tool_use_id: 't1', content: 'x'.repeat(1.5 * 1024 * 1024) },
      ]),
    ]

    const text = textOf(
      getAssistantMessageFromError(relayRejection, MODEL, {
        messagesForAPI: messagesForAPI as never,
      }),
    )

    expect(text).toContain('about 1.5MB')
    expect(text).toContain('none of it is images or documents')
  })

  test('points interactive users at /compact and non-interactive callers at a new session', () => {
    // Session mode is process-global and bun runs every file in one process:
    // set both modes explicitly and put back whatever was there.
    const original = getIsInteractive()
    try {
      setIsInteractive(true)
      expect(textOf(getAssistantMessageFromError(relayRejection, MODEL))).toContain('/compact')
      setIsInteractive(false)
      expect(textOf(getAssistantMessageFromError(relayRejection, MODEL))).toContain(
        'start a new session',
      )
    } finally {
      setIsInteractive(original)
    }
  })

  describe('measureRequestPayload', () => {
    const toolUse = {
      type: 'tool_use',
      id: 't',
      name: 'Read',
      input: { file_path: '/a' },
    }

    test('counts media by data length and keeps it separate from everything else', () => {
      const size = measureRequestPayload([
        userTurn([{ type: 'text', text: 'hello' }]),
        userTurn([
          {
            type: 'tool_result',
            tool_use_id: 't',
            content: [image(1000), { type: 'text', text: 'abc' }],
          },
        ]),
        userTurn([
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: 'B'.repeat(500) },
          },
        ]),
        { type: 'assistant', message: { role: 'assistant', content: [toolUse] } },
      ] as never)

      expect(size?.mediaBytes).toBe(1500)
      expect(size?.totalBytes).toBe(
        5 + 1003 + 500 + Buffer.byteLength(JSON.stringify(toolUse)),
      )
    })

    test('never throws while classifying: an unserializable payload falls back to the unmeasured wording', () => {
      const circular: Record<string, unknown> = {}
      circular.self = circular
      const messagesForAPI = [
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 't', name: 'Read', input: circular }],
          },
        },
      ] as never

      expect(measureRequestPayload(messagesForAPI)).toBeUndefined()
      expect(
        textOf(getAssistantMessageFromError(relayRejection, MODEL, { messagesForAPI })),
      ).toContain('The size limit is set by that endpoint')
    })
  })
})


describe('retry diagnostics', () => {
  test('classifies transport failures without calling every unknown fault a connection error', () => {
    expect(categorizeRetryableAPIError(new APIConnectionError({}))).toBe('connection_error')
    expect(categorizeRetryableAPIError(new APIConnectionTimeoutError())).toBe('connection_error')
    expect(categorizeRetryableAPIError(new APIError(undefined, undefined, 'unrecognized fault', undefined))).toBe('unknown')
  })

  test('keeps provider detail, request id, and transport cause with bounded redacted text', () => {
    const error = new APIError(503, { error: { message: 'No available channel' } }, '503 response', new Headers({ 'request-id': 'req-fixture' }))
    expect(getRetryableAPIErrorDiagnostics(error)).toEqual({ error_message: 'No available channel', request_id: 'req-fixture' })
    const connection = new APIConnectionError({ message: 'Connection error.', cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) })
    expect(getRetryableAPIErrorDiagnostics(connection).error_message).toContain('ECONNRESET: socket hang up')
    const sensitive = new APIConnectionError({ message: 'Bearer fixture-secret api_key=fixture-key https://user:pass@proxy.test/?token=private ' + 'x'.repeat(3000) })
    const detail = getRetryableAPIErrorDiagnostics(sensitive).error_message!
    expect(detail.length).toBeLessThanOrEqual(2000)
    for (const secret of ['fixture-secret', 'fixture-key', 'user:pass', 'token=private']) expect(detail).not.toContain(secret)
  })
})


test('retry detail redacts provider key and auth query parameters', () => {
  const error = new APIConnectionError({ message: 'Request failed https://provider.test/v1?key=fixture-provider-key&auth=fixture-auth' })
  const detail = getRetryableAPIErrorDiagnostics(error).error_message!
  expect(detail).not.toContain('fixture-provider-key')
  expect(detail).not.toContain('fixture-auth')
  expect(detail).toContain('https://provider.test/v1?key=[REDACTED]&auth=[REDACTED]')
})

describe('quoted retry credentials', () => {
  test.each([
    ['password="correct horse battery staple"', 'password="[REDACTED]"'],
    ["api_key='fixture,key;with&delimiters'", "api_key='[REDACTED]'"],
    ['{"api_key":"fixture,key,with,commas"}', '{"api_key":"[REDACTED]"}'],
    ['{"api_key":"fixture\\"quoted, key suffix"}', '{"api_key":"[REDACTED]"}'],
    ["password='fixture\\'quoted secret suffix'", "password='[REDACTED]'"],
    ['password="unfinished secret suffix', 'password="[REDACTED]"'],
    ['password=fixture-secret', 'password=[REDACTED]'],
  ])('redacts the complete credential in %s', (credential, redacted) => {
    const error = new APIConnectionError({
      message: `Proxy rejected ${credential}`,
      cause: new Error(`Upstream rejected ${credential}`),
    })
    expect(getRetryableAPIErrorDiagnostics(error).error_message).toBe(
      `Proxy rejected ${redacted} · Upstream rejected ${redacted}`,
    )
  })
})
