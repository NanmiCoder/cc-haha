import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileRange, tailFile } from '../fsOperations.js'
import { readFileInRange } from '../readFileInRange.js'
import { decodeShellOutput, hasClippedUtf8Start } from './outputEncoding.js'

const gbk = (bytes: Buffer) => new TextDecoder('gb18030').decode(bytes)
const chinese = Buffer.from([0xd6, 0xd0, 0xce, 0xc4])

test('preserves valid UTF-8 and decodes localized output sharing the same shell file', () => {
  const utf8 = Buffer.from('UTF-8 中文 🙂\n')
  const legacy = Buffer.concat([chinese, Buffer.from('\r\n')])
  const bytes = Buffer.concat([utf8, legacy])
  expect(decodeShellOutput(bytes, false, false, gbk)).toEqual({
    content: 'UTF-8 中文 🙂\n中文\r\n',
    bytesRead: bytes.length,
  })
})

test('uses the chosen legacy encoding and preserves the UTF-8 fast path', () => {
  const shiftJis = (bytes: Buffer) => new TextDecoder('shift_jis').decode(bytes)
  expect(decodeShellOutput(Buffer.from([0x93, 0xfa, 0x96, 0x7b]), false, false, shiftJis).content).toBe('日本')
  const text = Buffer.from('Iñtërnâtiônàlizætiøn')
  expect(decodeShellOutput(text, false, false, () => {
    throw new Error('valid UTF-8 must not use the fallback')
  })).toEqual({ content: text.toString(), bytesRead: text.length })
})

test('retains incomplete characters for the next bounded read', () => {
  const text = Buffer.from('abc🙂')
  const utf8Prefix = decodeShellOutput(text.subarray(0, 5), false, true, gbk)
  expect(utf8Prefix).toEqual({ content: 'abc', bytesRead: 3 })
  expect(decodeShellOutput(text.subarray(utf8Prefix.bytesRead), false, false, gbk).content).toBe('🙂')
  const legacyPrefix = decodeShellOutput(chinese.subarray(0, 3), false, true, gbk)
  expect(legacyPrefix).toEqual({ content: '中', bytesRead: 2 })
  expect(decodeShellOutput(chinese.subarray(legacyPrefix.bytesRead), false, false, gbk).content).toBe('文')
})

test('keeps consecutive legacy lines and resumes a clipped UTF-8 character after them', () => {
  const legacy = Buffer.concat([chinese, Buffer.from('\r\n'), chinese, Buffer.from('\n')])
  const output = Buffer.concat([legacy, Buffer.from('next🙂')])
  const first = decodeShellOutput(output.subarray(0, -2), false, true, gbk)
  expect(first).toEqual({
    content: '中文\r\n中文\nnext',
    bytesRead: legacy.length + Buffer.byteLength('next'),
  })
  expect(decodeShellOutput(output.subarray(first.bytesRead), false, false, gbk).content).toBe('🙂')
})

test('recognizes a tail clipped inside UTF-8 without discarding an OEM line start', () => {
  const output = Buffer.from('first🙂\nlast')
  expect(hasClippedUtf8Start(output, 5)).toBe(false)
  for (const offset of [6, 7, 8]) {
    expect(hasClippedUtf8Start(output, offset)).toBe(true)
    expect(decodeShellOutput(output.subarray(offset), true, false, gbk)).toEqual({
      content: '\nlast',
      bytesRead: output.length - offset,
    })
  }
  const oemLine = Buffer.from([0xb0, 0xa1, 0x0a])
  const prefix = Buffer.from('start\n')
  expect(hasClippedUtf8Start(Buffer.concat([prefix, oemLine]), prefix.length)).toBe(false)
})

test('returns replacement text and complete offsets if the native decoder declines a line', () => {
  const utf8 = Buffer.from('\nnext 🙂\n')
  const output = Buffer.concat([chinese, utf8, chinese])
  expect(decodeShellOutput(output, false, false, () => undefined)).toEqual({
    content: output.toString('utf8'),
    bytesRead: output.length,
  })
})

test.skipIf(process.platform !== 'win32')('file range cursors and tails preserve bounded UTF-8 output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cc-haha-output-encoding-'))
  try {
    const path = join(directory, 'shell.output')
    const output = Buffer.from('abc🙂\r\nfinish')
    await writeFile(path, output)
    const first = await readFileRange(path, 0, 5)
    expect(first).toEqual({ content: 'abc', bytesRead: 3, bytesTotal: output.length })
    expect(await readFileRange(path, first!.bytesRead, 100)).toMatchObject({ content: '🙂\r\nfinish' })
    expect(await tailFile(path, output.length - 5)).toMatchObject({ content: '\r\nfinish', bytesTotal: output.length })

    // An OEM lead byte can look like a UTF-8 continuation byte. Keep it
    // when the previous bytes prove that the tail starts at a new line.
    const oemLine = Buffer.from([0xb0, 0xa1, 0x0a])
    await writeFile(path, Buffer.concat([Buffer.from('start\n'), oemLine]))
    expect((await tailFile(path, oemLine.length)).content).toBe(decodeShellOutput(oemLine).content)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('reading persisted output preserves line ranges across a split multibyte character', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cc-haha-persisted-encoding-'))
  try {
    const file = join(directory, 'shell.txt')
    // The legacy character begins in the last byte of the first stream chunk.
    const prefix = Buffer.alloc(512 * 1024 - 1, 0x61)
    prefix[prefix.length - 1] = 0x0a
    for (const firstLine of [Buffer.from('start\n'), prefix]) {
      const suffix = firstLine === prefix ? Buffer.alloc(10 * 1024 * 1024, 0x62) : Buffer.from('end')
      const bytes = Buffer.concat([firstLine, chinese, Buffer.from('\r\n'), suffix])
      await writeFile(file, bytes)
      expect(await readFileInRange(file, 1, 1, undefined, undefined, {
        decode: (chunk, partial) => decodeShellOutput(chunk, false, partial, gbk),
      })).toMatchObject({ content: '中文', lineCount: 1, totalLines: 3, totalBytes: bytes.length })
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
