import { getSessionReferences } from './composerMentions'
import { describe, expect, it } from 'vitest'
import {
  findMentionRanges,
  insertMentionIntoText,
  mentionToken,
  type ComposerMention,
  type NewComposerMention,
} from './composerMentions'

const dirMention: ComposerMention = {
  label: 'MediaCrawlerPro-Python/',
  path: '/repo/MediaCrawlerPro-Python',
  isDirectory: true,
  tokenOrdinal: 0,
}
const fileMention: ComposerMention = {
  label: 'main.ts',
  path: '/repo/src/main.ts',
  isDirectory: false,
  tokenOrdinal: 0,
}

describe('findMentionRanges', () => {
  it('locates tokens in document order', () => {
    const text = `look at ${mentionToken(dirMention)} and ${mentionToken(fileMention)} please`
    const ranges = findMentionRanges(text, [dirMention, fileMention])
    expect(ranges).toHaveLength(2)
    expect(ranges[0]!.start).toBe(text.indexOf(mentionToken(dirMention)))
    expect(ranges[1]!.start).toBe(text.indexOf(mentionToken(fileMention)))
  })

  it('disambiguates repeated labels by ordinal', () => {
    const text = `${mentionToken(dirMention)} vs ${mentionToken(dirMention)}`
    const ranges = findMentionRanges(text, [dirMention, { ...dirMention, tokenOrdinal: 1 }])
    expect(ranges).toHaveLength(2)
    expect(ranges[0]!.end).toBeLessThanOrEqual(ranges[1]!.start)
  })

  it('lets a literal duplicate keep its slot instead of stealing the pill', () => {
    // The first `@main.ts` is literal text the user typed; the pill for the
    // same label sits at the second occurrence.
    const text = `compare @main.ts with ${mentionToken(fileMention)}`
    const ranges = findMentionRanges(text, [{ ...fileMention, tokenOrdinal: 1 }])
    expect(ranges).toHaveLength(1)
    expect(ranges[0]!.start).toBe(text.lastIndexOf(mentionToken(fileMention)))
  })

  it('stops matching once a token went missing', () => {
    const text = `only ${mentionToken(fileMention)} survived`
    const ranges = findMentionRanges(text, [dirMention, fileMention])
    expect(ranges).toHaveLength(0)
  })
})

describe('insertMentionIntoText', () => {
  it('replaces the trigger range with the token and a trailing space', () => {
    const result = insertMentionIntoText('check @Medi out', [], 6, 11, dirMention)
    expect(result.text).toBe(`check ${mentionToken(dirMention)} out`)
    expect(result.mentions).toEqual([dirMention])
    expect(result.cursorPos).toBe('check '.length + mentionToken(dirMention).length + 1)
  })

  it('keeps existing mentions in document order around the insertion point', () => {
    const base = `${mentionToken(dirMention)} mid ${mentionToken(fileMention)}`
    const next: NewComposerMention = { label: 'new/', path: '/repo/new', isDirectory: true }
    const insertAt = mentionToken(dirMention).length + 1 // before "mid"
    const result = insertMentionIntoText(base, [dirMention, fileMention], insertAt, insertAt + 3, next)
    expect(result.text).toBe(`${mentionToken(dirMention)} ${mentionToken(next)} ${mentionToken(fileMention)}`)
    expect(result.mentions.map((mention) => mention.label)).toEqual([
      dirMention.label,
      next.label,
      fileMention.label,
    ])
  })

  it('counts literal duplicates before the insertion point into the ordinal', () => {
    const base = `see @main.ts and `
    const next: NewComposerMention = { label: 'main.ts', path: '/repo/src/main.ts', isDirectory: false }
    const result = insertMentionIntoText(base, [], base.length, base.length, next)
    expect(result.mentions[0]!.tokenOrdinal).toBe(1)
  })

  it('clamps out-of-range bounds instead of throwing', () => {
    const result = insertMentionIntoText('abc', [], -5, 99, fileMention)
    expect(result.text).toBe(`${mentionToken(fileMention)} `)
    expect(result.cursorPos).toBe(result.text.length)
  })
})

it('collects only structured session references, deduplicating repeated pills and ignoring deleted or literal mentions', () => {
  const reference: ComposerMention = { kind: 'session', id: 'past', label: 'Review', path: '', isDirectory: false, tokenOrdinal: 1 }
  expect(getSessionReferences('@Review then @Review', [reference])).toEqual([{ sessionId: 'past' }])
  expect(getSessionReferences('@Review', [reference])).toEqual([])
  expect(getSessionReferences('@Review', [])).toEqual([])
  expect(getSessionReferences('@Review @Review', [{ ...reference, tokenOrdinal: 0 }, reference])).toEqual([{ sessionId: 'past' }])
})
