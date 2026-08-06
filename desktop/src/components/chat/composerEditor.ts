/**
 * ProseMirror document plumbing for the chat composer.
 *
 * The document is a flat list of paragraphs (newline = new paragraph) with
 * `atMention` inline atoms for @-mentions. Everything outside this file works
 * on the plain-text projection from composerMentions.ts — these functions are
 * the only place that knows how the projection maps onto PM positions.
 */
import { Node as PMNode, Schema } from 'prosemirror-model'
import type { Command } from 'prosemirror-state'
import type { ComposerMention } from '../../lib/composerMentions'
import { findMentionRanges, mentionToken, tokenOccurrences } from '../../lib/composerMentions'

export const AT_MENTION_NODE = 'atMention'

export const composerSchema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      content: 'inline*',
      group: 'block',
      parseDOM: [{ tag: 'p' }],
      toDOM: () => ['p', 0],
    },
    text: { group: 'inline' },
    [AT_MENTION_NODE]: {
      inline: true,
      group: 'inline',
      // Atom: the pill is one indivisible unit — no cursor inside it, and
      // Backspace/Delete removes the whole mention rather than a character.
      atom: true,
      selectable: true,
      draggable: false,
      attrs: {
        label: { default: '' },
        path: { default: '' },
        isDirectory: { default: false },
      },
      toDOM: (node) => [
        'span',
        {
          class: node.attrs.isDirectory
            ? 'composer-mention composer-mention--directory'
            : 'composer-mention',
          'data-mention-path': node.attrs.path as string,
          'data-mention-label': node.attrs.label as string,
          title: node.attrs.path as string,
        },
        ['span', {
          class: 'material-symbols-outlined composer-mention-icon',
          // The icon is decoration; the label already carries the meaning.
          'aria-hidden': 'true',
        }, node.attrs.isDirectory ? 'folder' : 'draft'],
        `@${node.attrs.label as string}`,
      ],
      parseDOM: [
        {
          tag: 'span.composer-mention',
          getAttrs: (dom) => ({
            // The ligature icon text pollutes textContent, so the label
            // travels in its own attribute.
            label: dom.getAttribute('data-mention-label') ?? '',
            path: dom.getAttribute('data-mention-path') ?? '',
            isDirectory: dom.classList.contains('composer-mention--directory'),
          }),
        },
      ],
    },
  },
})

/** Build a PM document from the plain-text projection. */
export function buildComposerDoc(text: string, mentions: ComposerMention[]): PMNode {
  const ranges = findMentionRanges(text, mentions)
  const mentionType = composerSchema.nodes[AT_MENTION_NODE]!
  const paragraphType = composerSchema.nodes.paragraph!

  const paragraphs: PMNode[] = []
  let rangeIndex = 0
  let lineStart = 0
  for (const line of text.split('\n')) {
    const lineEnd = lineStart + line.length
    const content: PMNode[] = []
    let cursor = 0
    while (rangeIndex < ranges.length) {
      const range = ranges[rangeIndex]!
      // A token never spans a newline (filesystem names can't contain one), so
      // a range outside this line just means we've caught up with it.
      if (range.start >= lineEnd || range.end > lineEnd) break
      const relativeStart = range.start - lineStart
      if (relativeStart > cursor) {
        content.push(composerSchema.text(line.slice(cursor, relativeStart)))
      }
      content.push(mentionType.create({
        label: range.mention.label,
        path: range.mention.path,
        isDirectory: range.mention.isDirectory,
      }))
      cursor = range.end - lineStart
      rangeIndex += 1
    }
    if (cursor < line.length) {
      content.push(composerSchema.text(line.slice(cursor)))
    }
    paragraphs.push(paragraphType.create(null, content))
    lineStart = lineEnd + 1
  }
  return composerSchema.node('doc', null, paragraphs)
}

/** Project a PM document back to plain text plus the mention list, in document order. */
export function projectComposerDoc(doc: PMNode): { text: string; mentions: ComposerMention[] } {
  // The doc knows exactly where the atoms are; the ordinals let the
  // plain-text projection keep that knowledge when literal text happens to
  // spell out the same token.
  const atoms: Array<{ projectedStart: number; mention: ComposerMention }> = []
  let text = ''
  doc.forEach((block, _offset, index) => {
    if (index > 0) text += '\n'
    block.forEach((inline) => {
      if (inline.type.name === AT_MENTION_NODE) {
        const mention: ComposerMention = {
          label: inline.attrs.label as string,
          path: inline.attrs.path as string,
          isDirectory: inline.attrs.isDirectory as boolean,
          tokenOrdinal: 0, // resolved below
        }
        atoms.push({ projectedStart: text.length, mention })
        text += mentionToken(mention)
      } else if (inline.isText) {
        text += inline.text ?? ''
      }
    })
  })
  for (const atom of atoms) {
    const token = mentionToken(atom.mention)
    atom.mention.tokenOrdinal = tokenOccurrences(text, token)
      .filter((position) => position < atom.projectedStart).length
  }
  return { text, mentions: atoms.map((atom) => atom.mention) }
}

/**
 * Serialize a PM document for the model: text stays text, each mention atom
 * becomes the `@"absolute path"` form the CLI already parses. Done from the
 * document rather than the plain-text projection on purpose — only the doc
 * knows which `@label` is a pill and which is literal text the user typed.
 */
export function serializeComposerDoc(doc: PMNode): string {
  let text = ''
  doc.forEach((block, _offset, index) => {
    if (index > 0) text += '\n'
    block.forEach((inline) => {
      if (inline.type.name === AT_MENTION_NODE) {
        text += `@"${inline.attrs.path as string}"`
      } else if (inline.isText) {
        text += inline.text ?? ''
      }
    })
  })
  return text
}

/** Projected text length of the whole document. */
export function projectedDocLength(doc: PMNode): number {
  return pmPosToTextOffset(doc, doc.content.size)
}

/** Map a PM position to its offset in the plain-text projection. */
export function pmPosToTextOffset(doc: PMNode, pos: number): number {
  const bounded = Math.max(0, Math.min(pos, doc.content.size))
  return doc.textBetween(0, bounded, '\n', (node) =>
    node.type.name === AT_MENTION_NODE
      ? mentionToken(node.attrs as ComposerMention)
      : '',
  ).length
}

/** Map a projection offset back to a PM position. */
export function textOffsetToPmPos(doc: PMNode, textOffset: number): number {
  let remaining = Math.max(0, textOffset)
  let result = -1

  doc.forEach((block, blockPos, index) => {
    if (result >= 0) return
    if (index > 0) {
      // The '\n' separator belongs to the boundary between blocks.
      if (remaining === 0) {
        result = blockPos
        return
      }
      remaining -= 1
    }
    const contentStart = blockPos + 1
    block.forEach((inline, inlineOffset) => {
      if (result >= 0) return
      const inlinePos = contentStart + inlineOffset
      const projectedLength = inline.isText
        ? (inline.text ?? '').length
        : inline.type.name === AT_MENTION_NODE
          ? mentionToken(inline.attrs as ComposerMention).length
          : 0
      if (remaining <= projectedLength) {
        if (inline.isText) {
          result = inlinePos + remaining
        } else {
          // Inside a token: snap to the nearest atom edge.
          result = remaining === 0 ? inlinePos : inlinePos + inline.nodeSize
        }
        return
      }
      remaining -= projectedLength
    })
    if (result < 0 && remaining === 0) {
      result = contentStart + block.content.size
    }
  })

  return result >= 0 ? result : doc.content.size
}

/**
 * Delete the atMention atom directly adjacent to the caret. Without this the
 * browser's native contenteditable behavior decides what Backspace does with
 * an uneditable inline span — one deterministic transaction beats hoping, and
 * it keeps the pill single-press deletable in every environment.
 */
export function deleteAdjacentMentionAtom(direction: 'backward' | 'forward'): Command {
  return (state, dispatch) => {
    const { empty, $from } = state.selection
    if (!empty || !$from.parent.isTextblock) return false

    let from = $from.pos
    let to = $from.pos

    if (direction === 'backward') {
      let node = $from.nodeBefore
      // Picker insertion deliberately leaves one separator space after the
      // pill so subsequent typing starts outside the atom. The caret lands
      // after that space, so treat both pieces as one insertion unit when the
      // user immediately deletes it.
      if (node?.isText && node.text === ' ') {
        const separatorStart = $from.pos - 1
        node = state.doc.resolve(separatorStart).nodeBefore
        if (node?.type.name !== AT_MENTION_NODE) return false
        from = separatorStart - node.nodeSize
      } else {
        if (node?.type.name !== AT_MENTION_NODE) return false
        from = $from.pos - node.nodeSize
        const afterMention = state.doc.resolve($from.pos).nodeAfter
        if (afterMention?.isText && afterMention.text?.startsWith(' ')) to += 1
      }
    } else {
      const node = $from.nodeAfter
      if (node?.type.name !== AT_MENTION_NODE) return false
      to = $from.pos + node.nodeSize
      const afterMention = state.doc.resolve(to).nodeAfter
      if (afterMention?.isText && afterMention.text?.startsWith(' ')) to += 1
    }

    if (dispatch) {
      dispatch(state.tr.delete(from, to))
    }
    return true
  }
}
