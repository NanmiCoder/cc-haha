import { describe, expect, it } from 'vitest'
import { EditorState, TextSelection } from 'prosemirror-state'
import {
  AT_MENTION_NODE,
  buildComposerDoc,
  composerSchema,
  deleteAdjacentMentionAtom,
  pmPosToTextOffset,
  projectComposerDoc,
  projectedDocLength,
  serializeComposerDoc,
  textOffsetToPmPos,
} from './composerEditor'
import { findMentionRanges, mentionToken, type ComposerMention } from '../../lib/composerMentions'

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

describe('buildComposerDoc / projectComposerDoc round trip', () => {
  it('round-trips plain text without mentions', () => {
    const projected = projectComposerDoc(buildComposerDoc('hello\nworld', []))
    expect(projected).toEqual({ text: 'hello\nworld', mentions: [] })
  })

  it('round-trips mentions with their attrs intact', () => {
    const text = `read ${mentionToken(dirMention)} and ${mentionToken(fileMention)}`
    const projected = projectComposerDoc(buildComposerDoc(text, [dirMention, fileMention]))
    expect(projected.text).toBe(text)
    expect(projected.mentions).toEqual([dirMention, fileMention])
  })

  it('builds one paragraph per line', () => {
    const doc = buildComposerDoc('a\nb\nc', [])
    expect(doc.childCount).toBe(3)
  })

  it('creates an atom node per mention', () => {
    const doc = buildComposerDoc(mentionToken(dirMention), [dirMention])
    let atomCount = 0
    doc.descendants((node) => {
      if (node.type.name === AT_MENTION_NODE) atomCount += 1
      return true
    })
    expect(atomCount).toBe(1)
  })

  it('drops mentions whose token is not in the text', () => {
    const projected = projectComposerDoc(buildComposerDoc('no token here', [dirMention]))
    expect(projected).toEqual({ text: 'no token here', mentions: [] })
  })
})

describe('serializeComposerDoc', () => {
  it('serializes atoms to @"path" and keeps text verbatim', () => {
    const text = `read ${mentionToken(dirMention)}\nthen edit ${mentionToken(fileMention)}`
    const doc = buildComposerDoc(text, [dirMention, fileMention])
    expect(serializeComposerDoc(doc)).toBe(
      'read @"/repo/MediaCrawlerPro-Python"\nthen edit @"/repo/src/main.ts"',
    )
  })

  it('never rewrites literal text that merely looks like a pill token', () => {
    // The user typed `@main.ts` by hand, then inserted a real pill for the
    // same file after it. Only the pill may be serialized — the doc, unlike
    // an in-order indexOf scan, knows which occurrence is the atom.
    const text = `compare @main.ts with ${mentionToken(fileMention)}`
    const doc = buildComposerDoc(text, [{ ...fileMention, tokenOrdinal: 1 }])
    expect(serializeComposerDoc(doc)).toBe('compare @main.ts with @"/repo/src/main.ts"')
    // …and the projection remembers which occurrence is the pill.
    expect(projectComposerDoc(doc).mentions[0]!.tokenOrdinal).toBe(1)
  })

  it('returns plain text when the doc has no atoms', () => {
    expect(serializeComposerDoc(buildComposerDoc('just text', []))).toBe('just text')
  })
})

describe('pmPosToTextOffset / textOffsetToPmPos', () => {
  const text = `ab ${mentionToken(dirMention)} cd\nef ${mentionToken(fileMention)} gh`
  const doc = buildComposerDoc(text, [dirMention, fileMention])

  it('round-trips every projected offset outside mention tokens', () => {
    // Offsets strictly inside a token have no PM position (the atom is
    // indivisible) and snap to the atom's end edge instead.
    const tokenRanges = findMentionRanges(text, [dirMention, fileMention])
    const insideToken = (offset: number) =>
      tokenRanges.some((range) => offset > range.start && offset < range.end)
    for (let offset = 0; offset <= text.length; offset += 1) {
      if (insideToken(offset)) continue
      const pmPos = textOffsetToPmPos(doc, offset)
      expect(pmPosToTextOffset(doc, pmPos)).toBe(offset)
    }
  })

  it('snaps offsets inside a token to the atom edge', () => {
    const tokenStart = 3 // after "ab "
    const tokenEnd = tokenStart + mentionToken(dirMention).length
    expect(pmPosToTextOffset(doc, textOffsetToPmPos(doc, tokenStart + 2))).toBe(tokenEnd)
  })

  it('maps the full doc length both ways', () => {
    expect(projectedDocLength(doc)).toBe(text.length)
    expect(pmPosToTextOffset(doc, doc.content.size)).toBe(text.length)
  })

  it('counts mention tokens as their projected length', () => {
    // Position right after the first atom ↔ offset right after its token.
    const tokenEnd = 3 + mentionToken(dirMention).length
    const pmPos = textOffsetToPmPos(doc, tokenEnd)
    expect(pmPosToTextOffset(doc, pmPos)).toBe(tokenEnd)
  })

  it('clamps offsets outside the document', () => {
    expect(textOffsetToPmPos(doc, 9999)).toBe(doc.content.size)
    expect(pmPosToTextOffset(doc, 9999)).toBe(text.length)
  })
})

describe('deleteAdjacentMentionAtom', () => {
  it.each([
    ['Backspace after the separator', 'backward' as const, mentionToken(dirMention).length + 1],
    ['Backspace at the atom edge', 'backward' as const, mentionToken(dirMention).length],
    ['Delete before the atom', 'forward' as const, 0],
  ])('removes a mention and its picker-inserted separator with %s', (_key, direction, offset) => {
    const doc = buildComposerDoc(`${mentionToken(dirMention)} tail`, [dirMention])
    const selection = TextSelection.near(doc.resolve(textOffsetToPmPos(doc, offset)))
    let state = EditorState.create({ schema: composerSchema, doc, selection })

    expect(deleteAdjacentMentionAtom(direction)(state, (tr) => {
      state = state.apply(tr)
    })).toBe(true)

    expect(projectComposerDoc(state.doc)).toEqual({ text: 'tail', mentions: [] })
  })
})
