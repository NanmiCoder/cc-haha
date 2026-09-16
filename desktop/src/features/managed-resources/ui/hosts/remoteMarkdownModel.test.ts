import { describe, expect, it } from 'vitest'
import { EditorState, TextSelection } from 'prosemirror-state'
import { splitBlock } from 'prosemirror-commands'
import { parseRemoteMarkdown, remoteMarkdownSchema as schema } from './remoteMarkdownModel'

function replaceText(source: string, oldText: string, newText: string) {
  const model = parseRemoteMarkdown(source)
  let position = -1
  model.doc.descendants((node, offset) => {
    if (node.isText && position < 0) {
      const found = node.text!.indexOf(oldText)
      if (found >= 0) position = offset + found
    }
  })
  if (position < 0) throw new Error('Fixture text missing')
  const state = EditorState.create({ schema, doc: model.doc })
  return model.serialize(state.apply(state.tr.insertText(newText, position, position + oldText.length)).doc)
}

describe('remote Markdown safe round-trip', () => {
  it.each([
    '', '# Heading\n\nBody **bold** and *italic*.\n',
    '---\r\ntitle: Example\r\n---\r\n\r\n# Title\r\n\r\nBody\r\n',
    '[ref]: https://example.invalid\n\nSee [guide][ref].\n',
    '- [x] Done\n- [ ] Todo\n\n    more\n',
    '| Name | Value |\n|:---|---:|\n| one | two |\n',
    '~~~bash\nexport HOME=/tmp\n~~~\n\n<div data-x="fixture">HTML</div>\n',
    'Math $$x^2$$ and <custom>inert</custom>\n\n[^a]: footnote\n',
    '  \n\n# Mixed\r\n\nline one\nline two\r\n',
  ])('preserves unmodified source exactly: %s', source => {
    const parsed = parseRemoteMarkdown(source)
    expect(parsed.serialize(parsed.doc)).toBe(source)
    expect(() => parsed.doc.check()).not.toThrow()
  })

  it('edits a paragraph while preserving frontmatter, HTML, references and CRLF', () => {
    const source = '---\r\nlayout: keep\r\n---\r\n\r\n# Title\r\n\r\nHello world\r\n\r\n<div>Do not rewrite</div>\r\n\r\n[ref]: https://example.invalid\r\n'
    expect(replaceText(source, 'world', '中文')).toBe(source.replace('world', '中文'))
  })

  it.each(['hello', 'hello\n', '# Title\r\n\r\nhello'])('preserves a new paragraph at the original EOF: %s', source => {
    const model = parseRemoteMarkdown(source)
    let state = EditorState.create({ schema, doc: model.doc })
    state = state.apply(state.tr.setSelection(TextSelection.atEnd(state.doc)))
    expect(splitBlock(state, transaction => { state = state.apply(transaction) })).toBe(true)
    state = state.apply(state.tr.insertText('next'))
    const updated = model.serialize(state.doc)
    const parsed = parseRemoteMarkdown(updated)
    expect(parsed.doc.childCount).toBe(state.doc.childCount)
    expect(parsed.doc.lastChild?.textContent).toBe('next')
    expect(parsed.doc.child(parsed.doc.childCount - 2).textContent).toBe('hello')
    expect(updated.startsWith(source)).toBe(true)
  })

  it('serializes changed GFM table cells without flattening the table', () => {
    const updated = replaceText('| Name | Value |\n|:---|---:|\n| one | two |\n', 'two', '中文')
    const parsed = parseRemoteMarkdown(updated)
    expect(parsed.doc.firstChild?.type.name).toBe('table')
    expect(parsed.doc.firstChild?.child(1).child(1).textContent).toBe('中文')
    expect(parsed.doc.firstChild?.firstChild?.child(1).attrs.align).toBe('right')
  })

  it('preserves a code-span pipe while editing another cell in the same table', () => {
    const updated = replaceText('| Code | Value |\n|---|---|\n| `a\\|b` | old |\n', 'old', 'new')
    const parsed = parseRemoteMarkdown(updated)
    const row = parsed.doc.firstChild!.child(1)
    expect(row.childCount).toBe(2)
    expect(row.child(0).textContent).toBe('a|b')
    expect(row.child(0).firstChild?.marks[0]?.type.name).toBe('code')
    expect(row.child(1).textContent).toBe('new')
  })

  it('round-trips nested marks when an already-bold paragraph is edited', () => {
    const updated = replaceText('**bold and *italic* and more**\n', 'more', 'next')
    const parsed = parseRemoteMarkdown(updated)
    const text: Array<{ value: string; marks: string[] }> = []
    parsed.doc.descendants(node => { if (node.isText) text.push({ value: node.text!, marks: node.marks.map(mark => mark.type.name).sort() }) })
    expect(text.map(item => item.value).join('')).toBe('bold and italic and next')
    expect(text.find(item => item.value.includes('italic'))?.marks).toEqual(['em', 'strong'])
    expect(text.every(item => item.marks.includes('strong'))).toBe(true)
  })

  it('does not lose text when literal Markdown punctuation and entities are entered', () => {
    const updated = replaceText('plain\n', 'plain', '[x] **not bold** & <tag>')
    const parsed = parseRemoteMarkdown(updated)
    expect(parsed.doc.textContent).toBe('[x] **not bold** & <tag>')
    expect(parsed.doc.firstChild?.firstChild?.marks).toHaveLength(0)
  })
})
