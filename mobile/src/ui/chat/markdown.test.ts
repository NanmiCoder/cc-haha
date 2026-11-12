import { describe, expect, test } from 'bun:test'
import {
  fitColumnWidths,
  MARKDOWN_LIMIT,
  naturalColumnWidths,
  parseInline,
  parseMarkdown,
  TABLE_MAX_COLUMN,
  TABLE_MIN_COLUMN,
  textWidthUnits,
  windowMarkdown,
  type MarkdownBlock,
} from './markdown'
import { fileChange } from './changes'

describe('chat markdown', () => {
  test('splits paragraphs, lists, headings, quotes, rules and fenced code', () => {
    const blocks = parseMarkdown(
      [
        'Release notes are written: ',
        '- CJK first',
        '* English folded into details',
        '',
        '## Next step',
        '1. Run tests',
        '2) Release',
        '> Mind the signing',
        '---',
        '```ts',
        'const a = 1',
        '',
        'const b = 2',
        '```',
        'First line',
        'Second line',
      ].join('\n')
    )
    expect(blocks).toEqual([
      { type: 'paragraph', text: 'Release notes are written: ' },
      {
        type: 'list',
        ordered: false,
        items: [
          { marker: '•', text: 'CJK first' },
          { marker: '•', text: 'English folded into details' },
        ],
      },
      { type: 'heading', level: 2, text: 'Next step' },
      {
        type: 'list',
        ordered: true,
        items: [
          { marker: '1.', text: 'Run tests' },
          { marker: '2.', text: 'Release' },
        ],
      },
      { type: 'quote', text: 'Mind the signing' },
      { type: 'rule' },
      { type: 'code', lang: 'ts', text: 'const a = 1\n\nconst b = 2' },
      { type: 'paragraph', text: 'First line\nSecond line' },
    ])
  })

  test('an unfinished fence while streaming keeps the rest as code', () => {
    expect(parseMarkdown('Look here\n```\nbun test')).toEqual([
      { type: 'paragraph', text: 'Look here' },
      { type: 'code', text: 'bun test' },
    ])
  })

  test('inline code and bold, leaving lone markers as text', () => {
    expect(parseInline('in `release-notes/v0.7.6.md` , **passed** * and `')).toEqual([
      { type: 'text', text: 'in ' },
      { type: 'code', text: 'release-notes/v0.7.6.md' },
      { type: 'text', text: ' , ' },
      { type: 'bold', text: 'passed' },
      { type: 'text', text: ' * and `' },
    ])
  })
})

describe('turn file changes', () => {
  test('reads added, modified and deleted files with line counts from a unified diff', () => {
    expect(
      fileChange('diff --git a/x b/x\nnew file mode 100644\n--- /dev/null\n+++ b/x\n@@ -0,0 +1,2 @@\n+one\n+two')
    ).toEqual({ status: 'A', added: 2, removed: 0 })
    expect(fileChange('--- a/x\n+++ b/x\n@@ -1,3 +1,2 @@\n keep\n-old\n-gone\n+new')).toEqual({
      status: 'M',
      added: 1,
      removed: 2,
    })
    expect(fileChange('deleted file mode 100644\n--- a/x\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye')).toEqual({
      status: 'D',
      added: 0,
      removed: 1,
    })
  })
})

describe('tables', () => {
  test('a header, rule and rows become one table block', () => {
    const blocks = parseMarkdown('| Function | Purpose |\n|---|---|\n| addTodo | Append |\n| `remaining` | Stats |\n\nFollowing paragraph')
    expect(blocks).toEqual([
      { type: 'table', header: ['Function', 'Purpose'], rows: [['addTodo', 'Append'], ['`remaining`', 'Stats']] },
      { type: 'paragraph', text: 'Following paragraph' },
    ])
  })

  test('outer pipes are optional, alignment colons and escaped pipes are handled', () => {
    const blocks = parseMarkdown('a | b\n:--- | ---:\nx \\| y | z')
    expect(blocks).toEqual([{ type: 'table', header: ['a', 'b'], rows: [['x | y', 'z']] }])
  })

  test('short rows are padded so the table stays rectangular', () => {
    const [table] = parseMarkdown('| a | b | c |\n|---|---|---|\n| 1 | 2 |')
    expect(table).toEqual({ type: 'table', header: ['a', 'b', 'c'], rows: [['1', '2', '']] })
  })

  test('a lone pipe line without a rule row stays a paragraph', () => {
    expect(parseMarkdown('a | b\nplain text')).toEqual([{ type: 'paragraph', text: 'a | b\nplain text' }])
  })
})

describe('table column widths', () => {
  test('CJK characters and emoji count as two half-width units, so column widths are not estimated too narrow', () => {
    expect(textWidthUnits('abc')).toBe(3)
    expect(textWidthUnits('章节')).toBe(4)
    expect(textWidthUnits('a章')).toBe(3)
    expect(textWidthUnits('🙂')).toBe(2)
  })

  test('Natural column widths have lower and upper bounds', () => {
    const [narrow, wide] = naturalColumnWidths(['a', 'Content'], [['b', 'x'.repeat(200)]])
    expect(narrow).toBe(TABLE_MIN_COLUMN)
    expect(wide).toBe(TABLE_MAX_COLUMN)
  })

  test('When it fits, fill the available width proportionally', () => {
    const widths = fitColumnWidths([87, 240], 358)
    expect(widths).not.toBeNull()
    expect(widths!.reduce((sum, value) => sum + value, 0)).toBe(358)
    expect(widths![0]).toBeGreaterThan(87)
    expect(widths![1]).toBeGreaterThan(240)
  })

  test('When it does not fit, shrink proportionally, with each column no narrower than the readable minimum', () => {
    const widths = fitColumnWidths([320, 320, 320], 358)
    expect(widths).not.toBeNull()
    expect(widths!.reduce((sum, value) => sum + value, 0)).toBe(358)
    for (const value of widths!) expect(value).toBeGreaterThanOrEqual(TABLE_MIN_COLUMN)
  })

  test('Returns null when there are too many columns to fit even at the minimum, leaving it to horizontal scrolling', () => {
    expect(fitColumnWidths(new Array(10).fill(320), 358)).toBeNull()
    expect(fitColumnWidths(new Array(8).fill(320), 358)).toBeNull()
    expect(fitColumnWidths(new Array(4).fill(320), 358)).not.toBeNull()
  })

  test('Use natural column widths when the width is unknown', () => {
    expect(fitColumnWidths([87, 240], 0)).toEqual([87, 240])
  })
})

describe('Mount cap for very long messages', () => {
  const paragraphs = (blocks: MarkdownBlock[]) =>
    blocks.flatMap((block) => (block.type === 'paragraph' ? [block.text] : []))

  test('Normal long replies render as is without collapsing', () => {
    const table = [
      '| Model | Input | Output | Latency | Notes |',
      '| --- | --- | --- | --- | --- |',
      ...Array.from({ length: 12 }, (_, row) => `| m${row} | 1 | 2 | 3 | ok |`),
    ].join('\n')
    const article = [
      ...Array.from({ length: 150 }, (_, index) => `Paragraph ${index} body.`),
      ...Array.from({ length: 10 }, (_, list) =>
        Array.from({ length: 6 }, (_, item) => `- List ${list}-${item}`).join('\n')
      ),
      table,
      table,
      table,
      '```ts\nconst a = 1\n```',
    ].join('\n\n')
    const blocks = parseMarkdown(article)
    const window = windowMarkdown(blocks, MARKDOWN_LIMIT)
    expect(window.hidden).toBe(0)
    expect(window.head).toBe(blocks)
    expect(window.tail).toEqual([])
  })

  test('When the model repeats tens of thousands of blocks only the beginning and end are mounted, collapsing the middle', () => {
    // A shape seen in a real session: "<br>\n\n" repeated about 32,000 times in one reply, which rendered as is crashes Android with a Java heap OOM.
    const blocks = parseMarkdown('Real run started.\n\n' + '<br>\n\n'.repeat(32000) + 'Conclusion at the end.')
    expect(blocks).toHaveLength(32002)
    const window = windowMarkdown(blocks, MARKDOWN_LIMIT)
    expect(window.head.length + window.tail.length).toBe(MARKDOWN_LIMIT.head + MARKDOWN_LIMIT.tail)
    expect(window.hidden).toBe(32002 - MARKDOWN_LIMIT.head - MARKDOWN_LIMIT.tail)
    expect(paragraphs(window.head)[0]).toBe('Real run started.')
    expect(paragraphs(window.tail).at(-1)).toBe('Conclusion at the end.')
  })

  test('A very long list is split by item; head and tail do not overlap and keep original numbering', () => {
    const blocks = parseMarkdown(
      Array.from({ length: 5000 }, (_, index) => `${index + 1}. Item ${index + 1}`).join('\n')
    )
    const window = windowMarkdown(blocks, { head: 40, tail: 20 })
    const [head] = window.head
    const [tail] = window.tail
    if (head?.type !== 'list' || tail?.type !== 'list') throw new Error('expected list slices')
    expect(head.items.map((item) => item.marker)).toEqual(
      Array.from({ length: 10 }, (_, index) => `${index + 1}.`)
    )
    expect(tail.items.map((item) => item.marker)).toEqual(['4996.', '4997.', '4998.', '4999.', '5000.'])
    expect(window.hidden).toBe(5000 - 15)
  })

  test('A very long table split in two keeps the header in both halves', () => {
    const blocks = parseMarkdown(
      ['| a | b |', '| --- | --- |', ...Array.from({ length: 3000 }, (_, row) => `| ${row} | x |`)].join('\n')
    )
    const window = windowMarkdown(blocks, { head: 100, tail: 50 })
    const [head] = window.head
    const [tail] = window.tail
    if (head?.type !== 'table' || tail?.type !== 'table') throw new Error('expected table slices')
    expect(head.header).toEqual(['a', 'b'])
    expect(tail.header).toEqual(['a', 'b'])
    expect(head.rows[0]).toEqual(['0', 'x'])
    expect(tail.rows.at(-1)).toEqual(['2999', 'x'])
    expect(window.hidden).toBe(3000 - head.rows.length - tail.rows.length)
  })

  test('Increase the head budget step by step until fully expanded', () => {
    const blocks = parseMarkdown(Array.from({ length: 900 }, (_, index) => `Paragraph ${index}`).join('\n\n'))
    const hidden = [1, 2, 3].map((step) => windowMarkdown(blocks, { head: 300 * step, tail: 100 }).hidden)
    expect(hidden).toEqual([500, 200, 0])
    expect(windowMarkdown(blocks, { head: 900, tail: 100 }).head).toBe(blocks)
  })

  test('Header-only tables still show at the head or tail when collapsed; those in the middle count toward the omitted blocks', () => {
    const headerOnly = (name: string) => `| ${name} | Value |\n| --- | --- |`
    const blocks = parseMarkdown(
      ['Start', headerOnly('Table A'), headerOnly('Table B'), '<br>\n\n'.repeat(3000), headerOnly('Table C'), 'End'].join('\n\n')
    )
    const window = windowMarkdown(blocks, { head: 40, tail: 40 })
    const tables = (shown: MarkdownBlock[]) =>
      shown.flatMap((block) => (block.type === 'table' ? [block.header[0]] : []))
    expect(tables(window.head)).toEqual(['Table A', 'Table B'])
    expect(tables(window.tail)).toEqual(['Table C'])
    expect(window.tail.at(-1)).toEqual({ type: 'paragraph', text: 'End' })
    // The end window always ends with the last block of the source, and the render layer keys by source position accordingly.
    expect(blocks.slice(blocks.length - window.tail.length)).toEqual(window.tail)
  })
})
