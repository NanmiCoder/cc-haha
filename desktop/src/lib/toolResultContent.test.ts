import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  TOOL_RESULT_IMAGES_MAX_TOTAL_BYTES,
  TOOL_RESULT_IMAGE_MAX_BYTES,
  TOOL_RESULT_IMAGE_MAX_COUNT,
  TOOL_RESULT_IMAGE_MEDIA_TYPES,
  extractToolResultImages,
  hasToolResultImageBlock,
  toolResultImageToBlob,
  toolResultImagesFor,
} from './toolResultContent'

const MIB = 1024 * 1024

const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48]
const PNG_BASE64 = Buffer.from(PNG_BYTES).toString('base64')

/** Rest parameters, not defaults, so a case can pass `undefined` on purpose. */
function imageBlock(data: unknown, ...rest: [mediaType?: unknown, sourceType?: unknown]) {
  const mediaType = rest.length > 0 ? rest[0] : 'image/png'
  const sourceType = rest.length > 1 ? rest[1] : 'base64'
  return { type: 'image', source: { type: sourceType, media_type: mediaType, data } }
}

/** Base64 that decodes to exactly `bytes` zero bytes (padded when the count is not a multiple of 3). */
function base64OfSize(bytes: number): string {
  const rest = bytes % 3
  return 'A'.repeat((bytes - rest) / 3 * 4) + (rest === 1 ? 'AA==' : rest === 2 ? 'AAA=' : '')
}

function none() {
  return { images: [], dropped: 0 }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('hasToolResultImageBlock', () => {
  it('recognizes image blocks for grouping without reading their payloads', () => {
    const source = vi.fn(() => { throw new Error('unexpected image read') })
    const blocks = [{ type: 'image', get source() { return source() } }]
    expect(hasToolResultImageBlock(blocks)).toBe(true)
    expect(hasToolResultImageBlock({ content: blocks })).toBe(true)
    expect(source).not.toHaveBeenCalled()
    expect(hasToolResultImageBlock([{ type: 'text', text: '/tmp/picture.png' }])).toBe(false)
  })

  it('leaves unreadable result content in the ordinary tool group', () => {
    const unreadable = { get content() { throw new Error('unreadable content') } }
    expect(hasToolResultImageBlock(unreadable)).toBe(false)
  })
})

describe('extractToolResultImages · block shapes', () => {
  it('reads a base64 image block out of an array of blocks', () => {
    expect(extractToolResultImages([imageBlock(PNG_BASE64)])).toEqual({
      images: [{ mediaType: 'image/png', data: PNG_BASE64 }],
      dropped: 0,
    })
  })

  it('keeps only the images of a mixed text and image result, in order', () => {
    const result = extractToolResultImages([
      { type: 'text', text: 'before' },
      imageBlock('QUJD', 'image/png'),
      { type: 'text', text: 'between' },
      imageBlock('REVG', 'image/jpeg'),
      'a bare string chunk',
    ])

    expect(result.images).toEqual([
      { mediaType: 'image/png', data: 'QUJD' },
      { mediaType: 'image/jpeg', data: 'REVG' },
    ])
    expect(result.dropped).toBe(0)
  })

  it.each([
    ['a { content } wrapper', { content: [imageBlock('QUJD')] }],
    ['a completed-status wrapper', { status: 'completed', content: [imageBlock('QUJD')] }],
  ])('unwraps %s the way the sibling text extractors do', (_label, content) => {
    expect(extractToolResultImages(content).images).toEqual([{ mediaType: 'image/png', data: 'QUJD' }])
  })

  it('unwraps one level only, so a nested wrapper cannot recurse', () => {
    expect(extractToolResultImages({ content: { content: [imageBlock('QUJD')] } })).toEqual(none())
  })

  it.each([
    ['a string', 'iVBORw0KGgo='],
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['a boolean', true],
    ['an empty array', []],
    ['an empty object', {}],
    ['a wrapper whose content is not an array', { content: 'text' }],
    ['text-only blocks', [{ type: 'text', text: 'hello' }]],
    ['a block that only looks like an image', [{ type: 'text', text: 'image', source: { type: 'base64' } }]],
  ])('finds nothing in %s', (_label, content) => {
    expect(extractToolResultImages(content)).toEqual(none())
  })
})

describe('extractToolResultImages · media type allowlist', () => {
  it('is exactly the four raster types the model API accepts', () => {
    // Widening this is a security decision (svg and html both run script in the
    // wrong context), so it should fail loudly rather than drift.
    expect([...TOOL_RESULT_IMAGE_MEDIA_TYPES]).toEqual(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
  })

  it.each(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])('accepts %s', (mediaType) => {
    expect(extractToolResultImages([imageBlock('QUJD', mediaType)]).images).toEqual([{ mediaType, data: 'QUJD' }])
  })

  it.each([
    ['IMAGE/PNG', 'image/png'],
    ['Image/Jpeg', 'image/jpeg'],
    ['image/WEBP', 'image/webp'],
  ])('compares %s case-insensitively and reports %s', (given, normalized) => {
    expect(extractToolResultImages([imageBlock('QUJD', given)]).images).toEqual([
      { mediaType: normalized, data: 'QUJD' },
    ])
  })

  // One row per case: an array-valued media type must not be spread as arguments.
  it.each(
    [
      'image/svg+xml',
      'IMAGE/SVG+XML',
      'text/html',
      'image/*',
      '*/*',
      'image/bmp',
      'image/avif',
      'image/jpg',
      'application/pdf',
      'image/png; charset=utf-8',
      ' image/png',
      'image/png ',
      '',
      undefined,
      null,
      123,
      ['image/png'],
    ].map((mediaType) => [mediaType] as const),
  )('refuses %j and counts it as dropped', (mediaType) => {
    expect(extractToolResultImages([imageBlock('QUJD', mediaType)])).toEqual({ images: [], dropped: 1 })
  })
})

describe('extractToolResultImages · source', () => {
  it.each([
    ['a url source', { type: 'url', url: 'https://example.com/a.png' }],
    ['a source without a type', { media_type: 'image/png', data: 'QUJD' }],
    ['a file source', { type: 'file', file_id: 'file_1', media_type: 'image/png', data: 'QUJD' }],
    ['a string source', 'QUJD'],
    ['a null source', null],
    ['no source', undefined],
  ])('refuses %s', (_label, source) => {
    expect(extractToolResultImages([{ type: 'image', source }])).toEqual({ images: [], dropped: 1 })
  })
})

describe('extractToolResultImages · history references', () => {
  const source = { type: 'ref', media_type: 'image/png', url: '/api/sessions/session-1/tool-images/parent%2Ftoolu_1/0', bytes: 1024 }

  it('accepts bounded tool-image references without decoding image bytes', () => {
    expect(extractToolResultImages([{ type: 'image', source }])).toEqual({
      images: [{ mediaType: 'image/png', url: source.url }], dropped: 0,
    })
  })

  it.each([
    'https://evil.invalid/a.png', '//evil.invalid/a.png', '/api/files?path=secret',
    '/api/sessions/s/tool-images/../0', '/api/sessions/s/tool-images/%2e%2e/0',
    '/api/sessions/s/tool-images/t/0?variant=full', '/api/sessions/s/tool-images/t/0#fragment',
    '/api/sessions/s/tool-images/t/0\\extra',
  ])('refuses a reference outside the tool-image route: %s', (url) => {
    expect(extractToolResultImages([{ type: 'image', source: { ...source, url } }])).toEqual({ images: [], dropped: 1 })
  })

  it.each([undefined, -1, NaN, Infinity, 1.5, TOOL_RESULT_IMAGE_MAX_BYTES + 1])('refuses an invalid image byte count: %s', (bytes) => {
    expect(extractToolResultImages([{ type: 'image', source: { ...source, bytes } }])).toEqual({ images: [], dropped: 1 })
  })

  it('shares the count and total-byte budgets with inline images', () => {
    const content = Array.from({ length: 4 }, (_, index) => ({ type: 'image', source: { ...source, url: source.url.replace('/0', `/${index}`), bytes: TOOL_RESULT_IMAGE_MAX_BYTES } }))
    expect(extractToolResultImages(content).images).toHaveLength(3)
    expect(extractToolResultImages(content).dropped).toBe(1)
  })
})

describe('extractToolResultImages · base64 validation', () => {
  it.each([
    ['padded, one byte', 'QQ=='],
    ['padded, two bytes', 'QUI='],
    ['a whole quantum', 'QUJD'],
    // atob takes unpadded input, so an unpadded image is a real image.
    ['unpadded, one byte', 'QQ'],
    ['unpadded, two bytes', 'QUI'],
    ['the standard alphabet with + and /', 'ab+/AB+/'],
  ])('accepts %s and hands atob something it can decode', (_label, data) => {
    const [image] = extractToolResultImages([imageBlock(data)]).images
    expect(image?.data).toBe(data)
    expect(() => atob(data)).not.toThrow()
  })

  it('strips the whitespace atob skips and returns clean base64', () => {
    const wrapped = 'iVBO\nRw0K\r\n Ggo\tAAA\fAN'
    const result = extractToolResultImages([imageBlock(wrapped)])
    expect(result.images).toEqual([{ mediaType: 'image/png', data: 'iVBORw0KGgoAAAAN' }])
  })

  it.each([
    ['a data: URL prefix', 'data:image/png;base64,QUJD'],
    ['a character outside the alphabet', 'QUJD!'],
    ['the URL-safe alphabet', 'QU-_'],
    ['markup', '<svg onload=alert(1)>'],
    ['a leading padding character', '=QUJ'],
    ['padding in the middle', 'QU=D'],
    ['three padding characters', 'QQ==='],
    ['padding that disagrees with the length', 'QUJ=='],
    ['a lone trailing character', 'QUJDQ'],
    ['a single character', 'Q'],
    ['an empty string', ''],
    ['only whitespace', ' \n\t '],
    ['only padding', '=='],
    ['a non-breaking space, which atob does not skip', 'QU JD'],
    ['a vertical tab, which atob does not skip', 'QU\vJD'],
  ])('refuses %s', (_label, data) => {
    expect(extractToolResultImages([imageBlock(data)])).toEqual({ images: [], dropped: 1 })
  })

  it.each([
    ['a lone trailing character', 'QUJDQ'],
    ['padding in the middle', 'QU=D'],
    ['padding that disagrees with the length', 'QUJ=='],
  ])('refuses only %s that atob would also reject', (_label, data) => {
    // The component decodes with atob. What is refused here must be what atob
    // cannot decode, so nothing accepted later fails at the Blob step.
    expect(() => atob(data)).toThrow()
  })

  it.each([
    ['a number', 12345],
    ['null', null],
    ['undefined', undefined],
    ['an array of chunks', ['QUJD']],
    ['an object', { base64: 'QUJD' }],
  ])('refuses data that is %s', (_label, data) => {
    expect(extractToolResultImages([imageBlock(data)])).toEqual({ images: [], dropped: 1 })
  })

  it('does not let one bad image hide the good ones around it', () => {
    const result = extractToolResultImages([
      imageBlock('QUJD'),
      imageBlock('<script>', 'image/svg+xml'),
      imageBlock('REVG'),
    ])
    expect(result.images.map((image) => image.data)).toEqual(['QUJD', 'REVG'])
    expect(result.dropped).toBe(1)
  })
})

describe('extractToolResultImages · limits', () => {
  it('pins the limits, so changing one is a deliberate decision', () => {
    expect(TOOL_RESULT_IMAGE_MAX_COUNT).toBe(6)
    expect(TOOL_RESULT_IMAGE_MAX_BYTES).toBe(8 * MIB)
    expect(TOOL_RESULT_IMAGES_MAX_TOTAL_BYTES).toBe(24 * MIB)
  })

  it('keeps the first images up to the count cap and reports the rest as dropped', () => {
    const blocks = Array.from({ length: TOOL_RESULT_IMAGE_MAX_COUNT + 3 }, (_, index) => (
      imageBlock(Buffer.from(`image-${index}`).toString('base64'))
    ))

    const result = extractToolResultImages(blocks)

    expect(result.images).toHaveLength(TOOL_RESULT_IMAGE_MAX_COUNT)
    expect(result.images.map((image) => image.data !== undefined ? Buffer.from(image.data, 'base64').toString() : undefined)).toEqual(
      Array.from({ length: TOOL_RESULT_IMAGE_MAX_COUNT }, (_, index) => `image-${index}`),
    )
    expect(result.dropped).toBe(3)
  })

  it('counts a refused image against the drops, not against the count cap', () => {
    const blocks = [
      imageBlock('QUJD', 'image/svg+xml'),
      ...Array.from({ length: TOOL_RESULT_IMAGE_MAX_COUNT }, () => imageBlock('QUJD')),
    ]

    const result = extractToolResultImages(blocks)

    expect(result.images).toHaveLength(TOOL_RESULT_IMAGE_MAX_COUNT)
    expect(result.dropped).toBe(1)
  })

  it('does not inspect image blocks past the count cap', () => {
    let inspected = false
    const beyondTheCap = {
      type: 'image',
      get source() {
        inspected = true
        return { type: 'base64', media_type: 'image/png', data: 'QUJD' }
      },
    }
    const blocks = [
      ...Array.from({ length: TOOL_RESULT_IMAGE_MAX_COUNT }, () => imageBlock('QUJD')),
      beyondTheCap,
    ]

    expect(extractToolResultImages(blocks).dropped).toBe(1)
    expect(inspected).toBe(false)
  })

  it('accepts an image of exactly the per-image byte cap and refuses one byte more', () => {
    // Same character count either way; only the padding tells them apart, so this
    // also proves the size is measured from the decoded bytes, not the length.
    const atTheCap = base64OfSize(TOOL_RESULT_IMAGE_MAX_BYTES)
    const overTheCap = base64OfSize(TOOL_RESULT_IMAGE_MAX_BYTES + 1)
    expect(atTheCap.length).toBe(overTheCap.length)

    expect(extractToolResultImages([imageBlock(atTheCap)]).images).toHaveLength(1)
    expect(extractToolResultImages([imageBlock(overTheCap)])).toEqual({ images: [], dropped: 1 })
  })

  it('accepts images that add up to exactly the total cap and refuses more', () => {
    const full = base64OfSize(TOOL_RESULT_IMAGE_MAX_BYTES)
    const fitting = Math.floor(TOOL_RESULT_IMAGES_MAX_TOTAL_BYTES / TOOL_RESULT_IMAGE_MAX_BYTES)
    expect(fitting * TOOL_RESULT_IMAGE_MAX_BYTES).toBe(TOOL_RESULT_IMAGES_MAX_TOTAL_BYTES)

    const blocks = [
      ...Array.from({ length: fitting }, () => imageBlock(full)),
      imageBlock('QQ=='),
    ]

    const result = extractToolResultImages(blocks)

    // Which images, not just how many: the trailing byte must be the one left out.
    expect(result.images.map((image) => image.data?.length)).toEqual(Array(fitting).fill(full.length))
    expect(result.dropped).toBe(1)
  })

  it('skips an image that overflows the total but keeps a later one that still fits', () => {
    const seven = base64OfSize(7 * MIB)
    const one = base64OfSize(1 * MIB)

    const result = extractToolResultImages([
      imageBlock(seven),
      imageBlock(seven),
      imageBlock(seven),
      imageBlock(seven), // 28 MiB: over the 24 MiB total
      imageBlock(one), // 22 MiB: fits
    ])

    expect(result.images.map((image) => image.data?.length)).toEqual([seven.length, seven.length, seven.length, one.length])
    expect(result.dropped).toBe(1)
  })

  it('still accepts line-wrapped base64 at the byte cap', () => {
    // The length check that guards the copy must leave room for the line breaks.
    const wrapped = base64OfSize(TOOL_RESULT_IMAGE_MAX_BYTES).replace(/.{76}/g, '$&\r\n')
    expect(wrapped.length).toBeGreaterThan(base64OfSize(TOOL_RESULT_IMAGE_MAX_BYTES).length)

    expect(extractToolResultImages([imageBlock(wrapped)]).images).toHaveLength(1)
  })

  it('refuses an oversized payload on its length alone, before copying or decoding it', () => {
    // Longer than any valid image could be even with heavy line wrapping.
    const huge = 'A'.repeat(base64OfSize(TOOL_RESULT_IMAGE_MAX_BYTES).length * 2 + 1)
    const replace = vi.spyOn(String.prototype, 'replace')
    const decode = vi.spyOn(globalThis, 'atob')

    const result = extractToolResultImages([imageBlock(huge)])

    // Read the counts and put the spies back before asserting: the assertion
    // library itself uses String.prototype.replace.
    const copies = replace.mock.calls.length
    const decodes = decode.mock.calls.length
    vi.restoreAllMocks()
    expect(result).toEqual({ images: [], dropped: 1 })
    expect(copies).toBe(0)
    expect(decodes).toBe(0)
  })

  it('never decodes anything itself', () => {
    const decode = vi.spyOn(globalThis, 'atob')

    extractToolResultImages([imageBlock(PNG_BASE64), imageBlock('REVG', 'image/gif')])

    const decodes = decode.mock.calls.length
    vi.restoreAllMocks()
    expect(decodes).toBe(0)
  })
})

describe('extractToolResultImages · hostile input', () => {
  it('survives a long array of junk', () => {
    const junk = Array.from({ length: 20_000 }, (_, index) => (index % 3 === 0 ? null : index % 3 === 1 ? index : []))
    expect(extractToolResultImages(junk)).toEqual(none())
  })

  it('survives self-referencing content', () => {
    const selfWrapper: Record<string, unknown> = {}
    selfWrapper.content = selfWrapper
    const selfArray: unknown[] = []
    selfArray.push(selfArray)
    const selfSource: Record<string, unknown> = { type: 'base64', media_type: 'image/png' }
    selfSource.data = selfSource

    expect(extractToolResultImages(selfWrapper)).toEqual(none())
    expect(extractToolResultImages(selfArray)).toEqual(none())
    expect(extractToolResultImages([{ type: 'image', source: selfSource }])).toEqual({ images: [], dropped: 1 })
  })

  it('returns nothing, rather than throwing, when reading the content throws', () => {
    const trap = new Proxy([], {
      get() {
        throw new Error('hostile getter')
      },
    })
    const throwingSource = {
      type: 'image',
      get source(): never {
        throw new Error('hostile source')
      },
    }

    expect(() => extractToolResultImages(trap)).not.toThrow()
    expect(extractToolResultImages(trap)).toEqual(none())
    // Whatever was read before the failure is not shown either: half a result
    // would read as the whole one.
    expect(extractToolResultImages([imageBlock('QUJD'), throwingSource])).toEqual(none())
  })
})

describe('extractToolResultImages · remembering', () => {
  /** How many times a base64 string was copied for validation while `run` ran. */
  function countValidations(run: () => void): number {
    const original = String.prototype.replace as (this: string, ...args: unknown[]) => string
    let validations = 0
    const spy = vi.spyOn(String.prototype, 'replace').mockImplementation(function (this: string, ...args: unknown[]) {
      const [pattern] = args
      if (pattern instanceof RegExp && pattern.source === '[\\t\\n\\f\\r ]+') validations += 1
      return original.apply(this, args)
    } as never)
    try {
      run()
    } finally {
      spy.mockRestore()
    }
    return validations
  }

  it('reads a content object once and hands back the same extraction', () => {
    const content = [imageBlock('QUJD'), imageBlock('REVG')]

    const first = extractToolResultImages(content)

    expect(extractToolResultImages(content)).toBe(first)
    expect(first.images).toHaveLength(2)
  })

  it('does not validate the same content again', () => {
    const content = [imageBlock(PNG_BASE64), imageBlock('REVG', 'image/gif')]

    const validations = countValidations(() => {
      for (let render = 0; render < 5; render += 1) extractToolResultImages(content)
    })

    expect(validations).toBe(2)
  })

  it('keeps two content objects apart even when their blocks are equal', () => {
    const first = [imageBlock('QUJD')]
    const second = [imageBlock('QUJD')]

    expect(extractToolResultImages(first)).not.toBe(extractToolResultImages(second))
    expect(extractToolResultImages(first)).toEqual(extractToolResultImages(second))
    expect(countValidations(() => {
      extractToolResultImages([imageBlock('QUJD')])
      extractToolResultImages([imageBlock('QUJD')])
    })).toBe(2)
  })

  it('remembers a wrapper by the wrapper object', () => {
    const wrapper = { status: 'completed', content: [imageBlock('QUJD')] }

    expect(extractToolResultImages(wrapper)).toBe(extractToolResultImages(wrapper))
    expect(extractToolResultImages({ ...wrapper })).not.toBe(extractToolResultImages(wrapper))
  })

  it.each([
    ['a string', 'QUJD'],
    ['null', null],
    ['a number', 7],
  ])('has nothing to remember for %s, and still answers', (_label, content) => {
    expect(extractToolResultImages(content)).toEqual(none())
  })
})

describe('toolResultImagesFor', () => {
  const content = () => [imageBlock('QUJD')]

  it('carries the images and drops of the call\'s result', () => {
    const shown = toolResultImagesFor({
      toolName: 'mcp__shots__take',
      input: {},
      content: [imageBlock('QUJD'), imageBlock('QUJD', 'image/svg+xml')],
    })

    expect(shown.images).toEqual([{ mediaType: 'image/png', data: 'QUJD' }])
    expect(shown.dropped).toBe(1)
  })

  it('shares the remembered images, so a strip sees the same array every time', () => {
    const result = content()
    const call = { toolName: 'Read', input: { file_path: '/a.png' }, content: result }

    expect(toolResultImagesFor(call).images).toBe(toolResultImagesFor(call).images)
    expect(toolResultImagesFor(call).images).toBe(extractToolResultImages(result).images)
  })

  it('names the file a Read came from', () => {
    expect(toolResultImagesFor({ toolName: 'Read', input: { file_path: '/repo/shot.png' }, content: content() }).originalPath)
      .toBe('/repo/shot.png')
  })

  it('gives each call its own path without touching what is remembered for the content', () => {
    const shared = content()

    const one = toolResultImagesFor({ toolName: 'Read', input: { file_path: '/one.png' }, content: shared })
    const two = toolResultImagesFor({ toolName: 'Read', input: { file_path: '/two.png' }, content: shared })

    expect(one.originalPath).toBe('/one.png')
    expect(two.originalPath).toBe('/two.png')
    expect(extractToolResultImages(shared)).not.toHaveProperty('originalPath')
    expect(toolResultImagesFor({ toolName: 'Bash', input: {}, content: shared })).not.toHaveProperty('originalPath')
  })

  it.each([
    ['another tool that has a file_path', 'Write', { file_path: '/repo/out.png' }],
    ['an MCP tool that has a file_path', 'mcp__shots__take', { file_path: '/repo/out.png' }],
    ['a Read in another case', 'read', { file_path: '/repo/out.png' }],
    ['a Read without a file_path', 'Read', {}],
    ['a Read with an empty file_path', 'Read', { file_path: '' }],
    ['a Read whose file_path is not text', 'Read', { file_path: 42 }],
    ['a Read with a null input', 'Read', null],
    ['a Read with a string input', 'Read', '/repo/out.png'],
    ['a Read with no input', 'Read', undefined],
  ])('has no original for %s', (_label, toolName, input) => {
    const shown = toolResultImagesFor({ toolName, input, content: content() })

    expect(shown).not.toHaveProperty('originalPath')
    expect(shown.images).toHaveLength(1)
  })

  it('has no original, rather than throwing, when the input cannot be read', () => {
    const input = {
      get file_path(): never {
        throw new Error('hostile getter')
      },
    }

    expect(() => toolResultImagesFor({ toolName: 'Read', input, content: content() })).not.toThrow()
    expect(toolResultImagesFor({ toolName: 'Read', input, content: content() })).not.toHaveProperty('originalPath')
  })

  it('still answers for a result with nothing to show', () => {
    expect(toolResultImagesFor({ toolName: 'Read', input: { file_path: '/a.txt' }, content: 'plain text' })).toEqual({
      images: [],
      dropped: 0,
      originalPath: '/a.txt',
    })
  })
})

describe('toolResultImageToBlob', () => {
  function readBytes(blob: Blob): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
      reader.onerror = () => reject(reader.error)
      reader.readAsArrayBuffer(blob)
    })
  }

  it('decodes to the original bytes and carries the media type', async () => {
    const blob = toolResultImageToBlob({ mediaType: 'image/png', data: PNG_BASE64 })

    expect(blob.type).toBe('image/png')
    expect(blob.size).toBe(PNG_BYTES.length)
    expect([...(await readBytes(blob))]).toEqual(PNG_BYTES)
  })

  it('types the Blob from the image, not from a default', () => {
    expect(toolResultImageToBlob({ mediaType: 'image/webp', data: 'QUJD' }).type).toBe('image/webp')
  })

  it('throws on data atob cannot decode, so the caller can drop the thumbnail', () => {
    expect(() => toolResultImageToBlob({ mediaType: 'image/png', data: 'Q' })).toThrow()
  })
})
