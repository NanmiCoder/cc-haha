import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile, truncate } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LEGACY_TRANSCRIPT_BYTES, readLegacyTranscriptFiles } from './legacyTranscriptBudget.js'

test('rejects oversized single and combined fragments before body allocation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'legacy-history-budget-'))
  try {
    const first = join(dir, 'first.jsonl')
    const second = join(dir, 'second.jsonl')
    await writeFile(first, '{}\n')
    expect((await readLegacyTranscriptFiles([first]))[0]!.bytes.toString()).toBe('{}\n')
    await truncate(first, 500 * 1024 * 1024)
    await expect(readLegacyTranscriptFiles([first])).rejects.toMatchObject({ statusCode: 413, code: 'TEAM_TRANSCRIPT_TOO_LARGE' })
    await truncate(first, LEGACY_TRANSCRIPT_BYTES / 2 + 1)
    await writeFile(second, '')
    await truncate(second, LEGACY_TRANSCRIPT_BYTES / 2 + 1)
    await expect(readLegacyTranscriptFiles([first, second])).rejects.toMatchObject({ statusCode: 413 })
  } finally { await rm(dir, { recursive: true, force: true }) }
})
