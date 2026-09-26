import { describe, expect, test } from 'bun:test'
import type { Message } from '../types/message.js'

/**
 * 章二十二「优化膨胀源」: storage must not keep the whole pre-edit file in
 * `toolUseResult.originalFile`. It is display-only (the model never sees it, and
 * the turn diff reads `structuredPatch`), and the client is only ever sent a
 * 16KB preview — so bounding at the source is invisible to readers while
 * removing the 67% of transcript bytes it accounted for.
 */
const MODULE = '../utils/sessionStorage.js'

async function loadHelper() {
  const mod = await import(MODULE)
  return mod as {
    boundOriginalFileForStorage: (message: Message) => Message
    ORIGINAL_FILE_STRING_LIMIT: number
  }
}

function toolResultMessage(toolUseResult: unknown): Message {
  return {
    type: 'user',
    uuid: '00000000-0000-4000-8000-000000000001',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    toolUseResult,
  } as unknown as Message
}

describe('boundOriginalFileForStorage', () => {
  test('clips an oversized originalFile to the transport bound and records its size', async () => {
    const { boundOriginalFileForStorage, ORIGINAL_FILE_STRING_LIMIT } = await loadHelper()
    const originalFile = 'x'.repeat(ORIGINAL_FILE_STRING_LIMIT + 5_000)
    const saved = boundOriginalFileForStorage(
      toolResultMessage({ filePath: '/a.ts', originalFile, structuredPatch: [{ oldStart: 1 }] }),
    )
    const result = saved.toolUseResult as Record<string, unknown>
    expect((result.originalFile as string).length).toBe(ORIGINAL_FILE_STRING_LIMIT)
    expect(result.originalFileTruncated).toBe(true)
    expect(result.originalFileBytes).toBe(originalFile.length)
    // The diff and the rest of the payload survive untouched.
    expect(result.filePath).toBe('/a.ts')
    expect(result.structuredPatch).toEqual([{ oldStart: 1 }])
  })

  test('leaves a small originalFile byte-identical', async () => {
    const { boundOriginalFileForStorage } = await loadHelper()
    const message = toolResultMessage({ filePath: '/a.ts', originalFile: 'small' })
    expect(boundOriginalFileForStorage(message)).toBe(message)
  })

  test('is a no-op when there is no toolUseResult or no originalFile', async () => {
    const { boundOriginalFileForStorage } = await loadHelper()
    const bare = toolResultMessage(undefined)
    expect(boundOriginalFileForStorage(bare)).toBe(bare)
    const noFile = toolResultMessage({ filePath: '/a.ts', originalFile: null })
    expect(boundOriginalFileForStorage(noFile)).toBe(noFile)
  })

  test('does not touch an oversized string in a sibling field', async () => {
    const { boundOriginalFileForStorage, ORIGINAL_FILE_STRING_LIMIT } = await loadHelper()
    // Only originalFile is display-only; other fields may be read back by
    // recovery, so they must keep the original record.
    const big = 'y'.repeat(ORIGINAL_FILE_STRING_LIMIT + 1)
    const message = toolResultMessage({ originalFile: 'small', newString: big })
    expect(boundOriginalFileForStorage(message)).toBe(message)
  })
})
