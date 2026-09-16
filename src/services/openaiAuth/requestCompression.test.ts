import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { encodeOpenAIRequestBody } from './requestCompression.js'
import { getRequestBodyAudit } from '../api/requestBodyAudit.js'

const prior = process.env.CC_HAHA_OPENAI_REQUEST_COMPRESSION
afterEach(() => {
  if (prior === undefined) delete process.env.CC_HAHA_OPENAI_REQUEST_COMPRESSION
  else process.env.CC_HAHA_OPENAI_REQUEST_COMPRESSION = prior
})

describe('Codex request compression', () => {
  test('encodes level 3 exactly and associates only the original encoded object with plaintext', async () => {
    delete process.env.CC_HAHA_OPENAI_REQUEST_COMPRESSION
    const compress = spyOn(Bun, 'zstdCompress')
    try {
      const plain = JSON.stringify({ fixture: '中文 synthetic '.repeat(1000) })
      const headers = new Headers({ 'Content-Type': 'application/json', 'Content-Length': '1' })
      const body = await encodeOpenAIRequestBody(plain, headers)
      expect(compress).toHaveBeenCalledWith(Buffer.from(plain), { level: 3 })
      expect(body).toBeInstanceOf(Uint8Array)
      expect(Buffer.from(await Bun.zstdDecompress(body as Uint8Array)).toString('utf8')).toBe(plain)
      expect(headers.get('content-encoding')).toBe('zstd')
      expect(headers.has('content-length')).toBe(false)
      expect(getRequestBodyAudit(body)).toEqual({ plainBody: plain, requestEncoding: 'zstd', requestPlainBytes: Buffer.byteLength(plain), requestWireBytes: (body as Uint8Array).byteLength })
      expect(getRequestBodyAudit(new Uint8Array(body as Uint8Array))).toBeUndefined()
      expect(getRequestBodyAudit(plain)).toBeUndefined()
    } finally { compress.mockRestore() }
  })

  test('honors compatibility opt-out and never double encodes an existing content encoding', async () => {
    process.env.CC_HAHA_OPENAI_REQUEST_COMPRESSION = 'false'
    expect(await encodeOpenAIRequestBody('fixture', new Headers())).toBe('fixture')
    delete process.env.CC_HAHA_OPENAI_REQUEST_COMPRESSION
    const headers = new Headers({ 'Content-Encoding': 'gzip' })
    expect(await encodeOpenAIRequestBody('fixture', headers)).toBe('fixture')
    expect(headers.get('content-encoding')).toBe('gzip')
  })

  test('falls back only on local encoding errors and never swallows cancellation', async () => {
    delete process.env.CC_HAHA_OPENAI_REQUEST_COMPRESSION
    const compress = spyOn(Bun, 'zstdCompress').mockRejectedValue(new Error('local fixture'))
    try {
      const headers = new Headers()
      expect(await encodeOpenAIRequestBody('fixture', headers)).toBe('fixture')
      expect(headers.has('content-encoding')).toBe(false)
      const abort = new AbortController()
      abort.abort()
      await expect(encodeOpenAIRequestBody('fixture', headers, abort.signal)).rejects.toThrow()
      expect(compress).toHaveBeenCalledTimes(1)
    } finally { compress.mockRestore() }
  })

  test('checks cancellation after asynchronous encoding before registering or submitting', async () => {
    delete process.env.CC_HAHA_OPENAI_REQUEST_COMPRESSION
    let release!: (value: Uint8Array) => void
    const compress = spyOn(Bun, 'zstdCompress').mockImplementation(() => new Promise(resolve => { release = resolve }))
    try {
      const abort = new AbortController()
      const headers = new Headers()
      const pending = encodeOpenAIRequestBody('fixture', headers, abort.signal)
      abort.abort()
      const result = new Uint8Array([1, 2, 3])
      release(result)
      await expect(pending).rejects.toThrow()
      expect(headers.has('content-encoding')).toBe(false)
      expect(getRequestBodyAudit(result)).toBeUndefined()
    } finally { compress.mockRestore() }
  })
})
