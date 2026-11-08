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

describe('超长消息的挂载上限', () => {
  const paragraphs = (blocks: MarkdownBlock[]) =>
    blocks.flatMap((block) => (block.type === 'paragraph' ? [block.text] : []))

  test('普通长回复原样渲染，不出现折叠', () => {
    const table = [
      '| 模型 | 输入 | 输出 | 延迟 | 备注 |',
      '| --- | --- | --- | --- | --- |',
      ...Array.from({ length: 12 }, (_, row) => `| m${row} | 1 | 2 | 3 | ok |`),
    ].join('\n')
    const article = [
      ...Array.from({ length: 150 }, (_, index) => `第 ${index} 段正文。`),
      ...Array.from({ length: 10 }, (_, list) =>
        Array.from({ length: 6 }, (_, item) => `- 列表 ${list}-${item}`).join('\n')
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

  test('模型重复输出几万段时只挂开头和结尾，中间折叠', () => {
    // 真实会话里出现过的形状：一条回复里 "<br>\n\n" 重复约 3.2 万次，原样渲染会让安卓 Java 堆 OOM 闪退。
    const blocks = parseMarkdown('实跑已启动。\n\n' + '<br>\n\n'.repeat(32000) + '结论在最后。')
    expect(blocks).toHaveLength(32002)
    const window = windowMarkdown(blocks, MARKDOWN_LIMIT)
    expect(window.head.length + window.tail.length).toBe(MARKDOWN_LIMIT.head + MARKDOWN_LIMIT.tail)
    expect(window.hidden).toBe(32002 - MARKDOWN_LIMIT.head - MARKDOWN_LIMIT.tail)
    expect(paragraphs(window.head)[0]).toBe('实跑已启动。')
    expect(paragraphs(window.tail).at(-1)).toBe('结论在最后。')
  })

  test('一个超长列表按项切开，头尾不重叠且保留原序号', () => {
    const blocks = parseMarkdown(
      Array.from({ length: 5000 }, (_, index) => `${index + 1}. 第 ${index + 1} 项`).join('\n')
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

  test('超长表格切开后两截都带表头', () => {
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

  test('逐次加大开头预算，最终完整展开', () => {
    const blocks = parseMarkdown(Array.from({ length: 900 }, (_, index) => `段落 ${index}`).join('\n\n'))
    const hidden = [1, 2, 3].map((step) => windowMarkdown(blocks, { head: 300 * step, tail: 100 }).hidden)
    expect(hidden).toEqual([500, 200, 0])
    expect(windowMarkdown(blocks, { head: 900, tail: 100 }).head).toBe(blocks)
  })

  test('只有表头的表格在折叠时照样显示在开头或结尾，中间的计入省略段数', () => {
    const headerOnly = (name: string) => `| ${name} | 值 |\n| --- | --- |`
    const blocks = parseMarkdown(
      ['开头', headerOnly('前表'), headerOnly('中表'), '<br>\n\n'.repeat(3000), headerOnly('后表'), '结尾'].join('\n\n')
    )
    const window = windowMarkdown(blocks, { head: 40, tail: 40 })
    const tables = (shown: MarkdownBlock[]) =>
      shown.flatMap((block) => (block.type === 'table' ? [block.header[0]] : []))
    expect(tables(window.head)).toEqual(['前表', '中表'])
    expect(tables(window.tail)).toEqual(['后表'])
    expect(window.tail.at(-1)).toEqual({ type: 'paragraph', text: '结尾' })
    // 结尾窗口总是以原文最后一块收尾，渲染层据此按原文位置给 key。
    expect(blocks.slice(blocks.length - window.tail.length)).toEqual(window.tail)
  })
})
