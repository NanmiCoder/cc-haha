import { describe, expect, test } from 'bun:test'
import {
  fitColumnWidths,
  naturalColumnWidths,
  parseInline,
  parseMarkdown,
  TABLE_MAX_COLUMN,
  TABLE_MIN_COLUMN,
  textWidthUnits,
} from './markdown'
import { fileChange } from './changes'

describe('chat markdown', () => {
  test('splits paragraphs, lists, headings, quotes, rules and fenced code', () => {
    const blocks = parseMarkdown(
      [
        '发版说明写好了：',
        '- 中文在前',
        '* English 收进 details',
        '',
        '## 下一步',
        '1. 跑测试',
        '2) 发版',
        '> 注意签名',
        '---',
        '```ts',
        'const a = 1',
        '',
        'const b = 2',
        '```',
        '第一行',
        '第二行',
      ].join('\n')
    )
    expect(blocks).toEqual([
      { type: 'paragraph', text: '发版说明写好了：' },
      {
        type: 'list',
        ordered: false,
        items: [
          { marker: '•', text: '中文在前' },
          { marker: '•', text: 'English 收进 details' },
        ],
      },
      { type: 'heading', level: 2, text: '下一步' },
      {
        type: 'list',
        ordered: true,
        items: [
          { marker: '1.', text: '跑测试' },
          { marker: '2.', text: '发版' },
        ],
      },
      { type: 'quote', text: '注意签名' },
      { type: 'rule' },
      { type: 'code', lang: 'ts', text: 'const a = 1\n\nconst b = 2' },
      { type: 'paragraph', text: '第一行\n第二行' },
    ])
  })

  test('an unfinished fence while streaming keeps the rest as code', () => {
    expect(parseMarkdown('看这里\n```\nbun test')).toEqual([
      { type: 'paragraph', text: '看这里' },
      { type: 'code', text: 'bun test' },
    ])
  })

  test('inline code and bold, leaving lone markers as text', () => {
    expect(parseInline('在 `release-notes/v0.7.6.md` 里，**通过**了 * 和 `')).toEqual([
      { type: 'text', text: '在 ' },
      { type: 'code', text: 'release-notes/v0.7.6.md' },
      { type: 'text', text: ' 里，' },
      { type: 'bold', text: '通过' },
      { type: 'text', text: '了 * 和 `' },
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
    const blocks = parseMarkdown('| 函数 | 作用 |\n|---|---|\n| addTodo | 追加 |\n| `remaining` | 统计 |\n\n后面的段落')
    expect(blocks).toEqual([
      { type: 'table', header: ['函数', '作用'], rows: [['addTodo', '追加'], ['`remaining`', '统计']] },
      { type: 'paragraph', text: '后面的段落' },
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
  test('中文和 emoji 按两个半角单位算，避免列宽估得太窄', () => {
    expect(textWidthUnits('abc')).toBe(3)
    expect(textWidthUnits('章节')).toBe(4)
    expect(textWidthUnits('a章')).toBe(3)
    expect(textWidthUnits('🙂')).toBe(2)
  })

  test('自然列宽有上下限', () => {
    const [narrow, wide] = naturalColumnWidths(['a', '内容'], [['b', 'x'.repeat(200)]])
    expect(narrow).toBe(TABLE_MIN_COLUMN)
    expect(wide).toBe(TABLE_MAX_COLUMN)
  })

  test('放得下时按比例铺满可用宽度', () => {
    const widths = fitColumnWidths([87, 240], 358)
    expect(widths).not.toBeNull()
    expect(widths!.reduce((sum, value) => sum + value, 0)).toBe(358)
    expect(widths![0]).toBeGreaterThan(87)
    expect(widths![1]).toBeGreaterThan(240)
  })

  test('放不下时等比压缩，每列不低于可读下限', () => {
    const widths = fitColumnWidths([320, 320, 320], 358)
    expect(widths).not.toBeNull()
    expect(widths!.reduce((sum, value) => sum + value, 0)).toBe(358)
    for (const value of widths!) expect(value).toBeGreaterThanOrEqual(TABLE_MIN_COLUMN)
  })

  test('列太多、压到下限还放不下时返回 null，交给横向滚动', () => {
    expect(fitColumnWidths(new Array(10).fill(320), 358)).toBeNull()
    expect(fitColumnWidths(new Array(8).fill(320), 358)).toBeNull()
    expect(fitColumnWidths(new Array(4).fill(320), 358)).not.toBeNull()
  })

  test('宽度未知时沿用自然列宽', () => {
    expect(fitColumnWidths([87, 240], 0)).toEqual([87, 240])
  })
})
