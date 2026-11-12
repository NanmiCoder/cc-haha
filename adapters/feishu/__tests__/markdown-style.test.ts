/**
 * markdown-style unit tests
 *
 * Covers:
 * - Heading downgrade (H1~H3 workaround)
 * - Code block protection
 * - Blank line compression
 * - Schema 2.0: <br> spacing for consecutive headings/tables/code blocks
 * - stripInvalidImageKeys
 * - sanitizeTextForCard (table count limit)
 * - findMarkdownTablesOutsideCodeBlocks
 */

import { describe, it, expect } from 'bun:test'
import {
  optimizeMarkdownForFeishu,
  sanitizeTextForCard,
  findMarkdownTablesOutsideCodeBlocks,
  FEISHU_CARD_TABLE_LIMIT,
} from '../markdown-style.js'

// Shortcut for the default cardVersion=2
const opt = (text: string, v?: number) => optimizeMarkdownForFeishu(text, v)

// ---------------------------------------------------------------------------
// Heading downgrade
// ---------------------------------------------------------------------------

describe('optimizeMarkdownForFeishu: heading downgrade', () => {
  it('H1 → H4 (cardVersion=1 simplified check)', () => {
    expect(opt('# Title', 1)).toBe('#### Title')
  })

  it('H2 → H5 (cardVersion=1)', () => {
    expect(opt('## Title', 1)).toBe('##### Title')
  })

  it('H3 → H5 (cardVersion=1)', () => {
    expect(opt('### Title', 1)).toBe('##### Title')
  })

  it('mixed H1+H2+H3 all downgraded (cardVersion=1)', () => {
    expect(opt('# H1\n## H2\n### H3', 1)).toBe('#### H1\n##### H2\n##### H3')
  })

  it('pure H4 document does not trigger downgrade (cardVersion=1)', () => {
    // Trigger condition: source must contain H1~H3
    expect(opt('#### Already H4', 1)).toBe('#### Already H4')
  })

  it('both H1 and H4 present: H1→H4, original H4 → H5 (cardVersion=1)', () => {
    expect(opt('# Top\n#### Sub', 1)).toBe('#### Top\n##### Sub')
  })

  it('# must be followed by a space to count as a heading', () => {
    expect(opt('#notaheading', 1)).toBe('#notaheading')
  })

  it('order guarantee: # downgraded to #### is not re-eaten by #{2,6} into #####', () => {
    // Key comment from openclaw-lark source: the order must not be reversed
    expect(opt('# Top', 1)).toBe('#### Top')
  })

  it('text without headings is returned as-is', () => {
    expect(opt('just plain text', 1)).toBe('just plain text')
  })

  it('also downgrades headings correctly with the default cardVersion=2', () => {
    const out = opt('# Title')
    expect(out).toContain('#### Title')
    expect(out).not.toMatch(/^# Title$/m)
  })
})

// ---------------------------------------------------------------------------
// Code block protection
// ---------------------------------------------------------------------------

describe('optimizeMarkdownForFeishu: code block protection', () => {
  it('# inside a code block is not downgraded (cardVersion=1)', () => {
    const input = '```\n# not a heading\n## also not\n```'
    expect(opt(input, 1)).toBe(input)
  })

  it('outer H1 downgraded, # inside code block kept (cardVersion=1)', () => {
    const input = '# Real heading\n\n```\n# inside code\n```'
    expect(opt(input, 1)).toBe('#### Real heading\n\n```\n# inside code\n```')
  })

  it('fenced code blocks with a language tag are also protected (cardVersion=1)', () => {
    const input = '## Section\n\n```python\n# python comment\n### not a heading\n```'
    expect(opt(input, 1)).toBe('##### Section\n\n```python\n# python comment\n### not a heading\n```')
  })

  it('multiple code blocks protected and restored in order (cardVersion=1)', () => {
    const input = '# A\n```\n# b1\n```\n## C\n```\n### b2\n```'
    expect(opt(input, 1)).toBe('#### A\n```\n# b1\n```\n##### C\n```\n### b2\n```')
  })

  it('# inside code blocks is still protected with the default cardVersion=2 (semantic assertion)', () => {
    const out = opt('# Heading\n\n```\n# inside\n```')
    expect(out).toContain('#### Heading') // outer H1 downgraded
    expect(out).toContain('# inside') // kept inside the code block
    expect(out).toContain('```') // fence kept
  })
})

// ---------------------------------------------------------------------------
// Blank line compression
// ---------------------------------------------------------------------------

describe('optimizeMarkdownForFeishu: blank line compression', () => {
  it('3 newlines → 2 (cardVersion=1)', () => {
    expect(opt('line1\n\n\nline2', 1)).toBe('line1\n\nline2')
  })

  it('5 newlines → 2 (cardVersion=1)', () => {
    expect(opt('line1\n\n\n\n\nline2', 1)).toBe('line1\n\nline2')
  })

  it('2 newlines kept (cardVersion=1)', () => {
    expect(opt('line1\n\nline2', 1)).toBe('line1\n\nline2')
  })

  it('consecutive newlines inside code blocks are kept (cardVersion=1)', () => {
    const input = '# Title\n\n```\nline1\n\n\nline2\n```'
    expect(opt(input, 1)).toBe('#### Title\n\n```\nline1\n\n\nline2\n```')
  })
})

// ---------------------------------------------------------------------------
// Schema 2.0: <br> spacing
// ---------------------------------------------------------------------------

describe('optimizeMarkdownForFeishu: Schema 2.0 <br> spacing', () => {
  it('cardVersion=2 adds <br> around code blocks by default', () => {
    const out = opt('text\n\n```\ncode\n```')
    // Code blocks should be wrapped in <br>
    expect(out).toContain('<br>\n```')
    expect(out).toContain('```\n<br>')
  })

  it('cardVersion=1 adds no <br> around code blocks', () => {
    const out = opt('text\n\n```\ncode\n```', 1)
    expect(out).not.toContain('<br>')
  })

  it('cardVersion=2 adds <br> between consecutive headings', () => {
    const out = opt('# A\n# B')
    // H1 downgraded to H4, <br> inserted between
    expect(out).toMatch(/#### A\n<br>\n#### B/)
  })

  it('cardVersion=2 adds <br> around tables', () => {
    const input = 'text before\n\n| col1 | col2 |\n|------|------|\n| v1 | v2 |\n\ntext after'
    const out = opt(input)
    // Before the table: <br> right after the text line (rule 3e drops extra blank lines)
    expect(out).toMatch(/text before\n<br>\n\| col1/)
    // After the table: <br> followed by two newlines to the next paragraph
    expect(out).toMatch(/\| v1 \| v2 \|\n<br>\n\ntext after/)
  })

  it('cardVersion=1 adds no <br> around tables', () => {
    const input = 'text before\n\n| col1 | col2 |\n|------|------|\n| v1 | v2 |\n\ntext after'
    const out = opt(input, 1)
    expect(out).not.toContain('<br>')
  })

  it('| inside a code block is not treated as a table (Schema 2.0)', () => {
    const input = '```\n| in code | not a table |\n|---|---|\n```'
    const out = opt(input)
    // Code block body should be kept intact
    expect(out).toContain('| in code | not a table |')
    // No table br markers outside the code block (content inside code blocks is not a table)
    // The code block itself is wrapped in <br> (Schema 2.0) but no separate <br> around |
    expect(out).toMatch(/<br>\n```\n\| in code/)
  })
})

// ---------------------------------------------------------------------------
// stripInvalidImageKeys
// ---------------------------------------------------------------------------

describe('optimizeMarkdownForFeishu: stripInvalidImageKeys', () => {
  it('img_* image keys are kept', () => {
    const out = opt('prefix ![alt](img_abc123) suffix')
    expect(out).toContain('![alt](img_abc123)')
  })

  it('http:// URL images are removed', () => {
    const out = opt('prefix ![alt](http://example.com/img.png) suffix')
    expect(out).toBe('prefix  suffix')
  })

  it('https:// URL images are removed', () => {
    const out = opt('![a](https://x.y/z.jpg)')
    expect(out).toBe('')
  })

  it('local paths are removed', () => {
    const out = opt('![a](/Users/me/pic.png)')
    expect(out).toBe('')
  })

  it('text without images is unchanged', () => {
    expect(opt('no images here', 1)).toBe('no images here')
  })

  it('mixed: img_ kept, URL removed', () => {
    const out = opt('![keep](img_good) and ![drop](http://bad.com/x.png)')
    expect(out).toContain('![keep](img_good)')
    expect(out).not.toContain('bad.com')
    expect(out).not.toContain('![drop]')
  })
})

// ---------------------------------------------------------------------------
// findMarkdownTablesOutsideCodeBlocks
// ---------------------------------------------------------------------------

describe('findMarkdownTablesOutsideCodeBlocks', () => {
  it('detects a single table', () => {
    const text = '| a | b |\n|---|---|\n| 1 | 2 |'
    const matches = findMarkdownTablesOutsideCodeBlocks(text)
    expect(matches.length).toBe(1)
    expect(matches[0]!.raw).toContain('| a | b |')
  })

  it('detects multiple tables', () => {
    const text =
      '| a | b |\n|---|---|\n| 1 | 2 |\n\ntext\n\n| x | y |\n|---|---|\n| 3 | 4 |'
    const matches = findMarkdownTablesOutsideCodeBlocks(text)
    expect(matches.length).toBe(2)
  })

  it('| inside a code block is not counted as a table', () => {
    const text = '```\n| in | code |\n|---|---|\n| 1 | 2 |\n```'
    const matches = findMarkdownTablesOutsideCodeBlocks(text)
    expect(matches.length).toBe(0)
  })

  it('code block + outer table: only the outer one is detected', () => {
    const text =
      '```\n| in | code |\n|---|---|\n| 1 | 2 |\n```\n\n| real | table |\n|---|---|\n| a | b |'
    const matches = findMarkdownTablesOutsideCodeBlocks(text)
    expect(matches.length).toBe(1)
    expect(matches[0]!.raw).toContain('real')
  })

  it('returns an empty array for text without tables', () => {
    expect(findMarkdownTablesOutsideCodeBlocks('just text').length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// sanitizeTextForCard
// ---------------------------------------------------------------------------

describe('sanitizeTextForCard: table count limit', () => {
  function makeTable(label: string): string {
    return `| ${label} h1 | h2 |\n|---|---|\n| v1 | v2 |`
  }

  it('returned as-is when table count ≤ 3', () => {
    const text = [makeTable('A'), makeTable('B'), makeTable('C')].join('\n\n')
    expect(sanitizeTextForCard(text)).toBe(text)
  })

  it('exactly 3 tables returned as-is', () => {
    const text = [makeTable('A'), makeTable('B'), makeTable('C')].join('\n\n')
    const matches = findMarkdownTablesOutsideCodeBlocks(text)
    expect(matches.length).toBe(3)
    expect(sanitizeTextForCard(text)).toBe(text)
  })

  it('4 tables: first 3 kept, 4th wrapped as a code block', () => {
    const text = [makeTable('A'), makeTable('B'), makeTable('C'), makeTable('D')].join('\n\n')
    const out = sanitizeTextForCard(text)
    // First 3 tables unchanged
    expect(out).toContain(makeTable('A'))
    expect(out).toContain(makeTable('B'))
    expect(out).toContain(makeTable('C'))
    // 4th is wrapped
    expect(out).toContain('```\n' + makeTable('D') + '\n```')
  })

  it('custom limit=1: first kept, all later ones wrapped', () => {
    const text = [makeTable('A'), makeTable('B'), makeTable('C')].join('\n\n')
    const out = sanitizeTextForCard(text, 1)
    expect(out).toContain(makeTable('A'))
    expect(out).toContain('```\n' + makeTable('B') + '\n```')
    expect(out).toContain('```\n' + makeTable('C') + '\n```')
  })

  it('limit=0: all wrapped', () => {
    const text = makeTable('Solo')
    const out = sanitizeTextForCard(text, 0)
    expect(out).toContain('```\n' + makeTable('Solo') + '\n```')
  })

  it('returned as-is without tables', () => {
    expect(sanitizeTextForCard('no tables here')).toBe('no tables here')
  })

  it('FEISHU_CARD_TABLE_LIMIT default = 3', () => {
    expect(FEISHU_CARD_TABLE_LIMIT).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// Edge cases and real scenarios
// ---------------------------------------------------------------------------

describe('optimizeMarkdownForFeishu: edge cases and real scenarios', () => {
  it('OpenCutSkill project structure report from a screenshot', () => {
    const input = `## OpenCutSkill architecture overview

### 1. Project positioning

Automatic editing tool for Screen Studio videos.

### 2. Module structure

\`\`\`
opencutskill/
├── cli/
├── core/
└── tests/
\`\`\``
    const out = opt(input)
    // All H2~H3 should be downgraded to H5
    expect(out).toContain('##### OpenCutSkill architecture overview')
    expect(out).toContain('##### 1. Project positioning')
    expect(out).toContain('##### 2. Module structure')
    // Code block content untouched
    expect(out).toContain('opencutskill/')
    expect(out).toContain('├── cli/')
    // No raw ## literals left
    expect(out).not.toMatch(/^## OpenCutSkill/m)
    expect(out).not.toMatch(/^### 1\./m)
    // <br> around code blocks (Schema 2.0 default)
    expect(out).toContain('<br>\n```')
    expect(out).toContain('```\n<br>')
  })

  it('abnormal input falls back to the original without throwing', () => {
    expect(() => opt('\u0000\uFFFF```unclosed')).not.toThrow()
  })

  it('empty string returns empty string', () => {
    expect(opt('')).toBe('')
  })
})
