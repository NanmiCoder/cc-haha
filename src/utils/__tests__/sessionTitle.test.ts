import { describe, expect, test } from 'bun:test'
import { generateSessionTitle, normalizeGeneratedSessionTitle } from '../sessionTitle.js'

describe('sessionTitle', () => {
  test('normalizes command XML emitted by title generation', () => {
    const raw = [
      '<command-message>frontend-design</command-message>',
      '<command-name>/frontend-design</command-name>',
      '<command-args>@website redesign the homepage</command-args>',
    ].join('\n')

    expect(normalizeGeneratedSessionTitle(raw)).toBe('/frontend-design @website redesign the homepage')
  })

  test('rejects empty or oversized generated titles', () => {
    expect(normalizeGeneratedSessionTitle('<ide_opened_file>src/app.ts</ide_opened_file>')).toBeNull()
    expect(normalizeGeneratedSessionTitle('x'.repeat(81))).toBeNull()
  })

  test('skips title generation when internal XML metadata leaves no title source', async () => {
    const title = await generateSessionTitle(
      '<ide_opened_file>src/app.ts</ide_opened_file>',
      AbortSignal.timeout(1000),
    )

    expect(title).toBeNull()
  })
})
