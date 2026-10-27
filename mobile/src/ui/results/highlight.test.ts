import { describe, expect, test } from 'bun:test'
import { highlight, languageFor, type Token, type TokenKind } from './highlight'

/** 把一行压成 “kind:text” 列表，只保留非空白 token，方便断言。 */
const kinds = (line: Token[] | undefined) =>
  (line ?? [])
    .filter((token) => token.text.trim())
    .map((token) => `${token.kind}:${token.text.trim()}`)

const of = (lines: Token[][], kind: TokenKind) =>
  lines.flat().filter((token) => token.kind === kind).map((token) => token.text.trim())

describe('language detection', () => {
  test('extension first, then server hint, then plain', () => {
    expect(languageFor('src/core/connection.ts')).toBe('ts')
    expect(languageFor('App.TSX')).toBe('ts')
    expect(languageFor('a.mjs')).toBe('js')
    expect(languageFor('package.json')).toBe('json')
    expect(languageFor('tool.py')).toBe('py')
    expect(languageFor('README.md')).toBe('md')
    expect(languageFor('theme.scss')).toBe('css')
    expect(languageFor('scripts/build.sh')).toBe('sh')
    expect(languageFor('/home/me/.zshrc')).toBe('sh')
    expect(languageFor('Dockerfile', 'shell')).toBe('sh')
    expect(languageFor('LICENSE')).toBe('plain')
  })
})

describe('typescript', () => {
  const source = [
    "import type { Host } from './types'",
    '',
    '/** 局域网凭据只放 SecureStore，不进 URL。 */',
    'export type ConnectionState =',
    "  | 'connecting'",
    'export function originOf(host: Host) {',
    '  const url = new URL(host.url)',
    "  if (url.search) throw new Error('地址里不能带参数')",
    '  return url.origin',
    '}',
    '// 重连退避：1s → 2s → 4s，最多 30s',
    'export const backoff = (n: number) =>',
    '  Math.min(1000 * 2 ** n, 30_000)',
  ].join('\n')
  const lines = highlight(source, 'ts')

  test('matches the design token classes line by line', () => {
    expect(lines).toHaveLength(13)
    expect(kinds(lines[0])).toEqual([
      'kw:import',
      'kw:type',
      'plain:{',
      'ty:Host',
      'plain:}',
      'kw:from',
      "str:'./types'",
    ])
    expect(lines[1]).toEqual([])
    expect(kinds(lines[2])).toEqual(['cm:/** 局域网凭据只放 SecureStore，不进 URL。 */'])
    expect(kinds(lines[3])).toEqual(['kw:export', 'kw:type', 'ty:ConnectionState', 'plain:='])
    expect(kinds(lines[5]).slice(0, 3)).toEqual(['kw:export', 'kw:function', 'ty:originOf'])
    expect(of([lines[6]!], 'ty')).toEqual(['URL'])
    expect(of([lines[7]!], 'str')).toEqual(["'地址里不能带参数'"])
    expect(kinds(lines[10])).toEqual(['cm:// 重连退避：1s → 2s → 4s，最多 30s'])
    expect(of([lines[11]!], 'ty')).toEqual(['number'])
    expect(of([lines[11]!], 'plain').join(' ')).toContain('backoff')
    expect(of([lines[12]!], 'str')).toEqual(['1000', '2', '30_000'])
    expect(of([lines[12]!], 'ty')).toEqual(['Math'])
  })

  test('property access is not a keyword and lines keep their exact text', () => {
    const [line] = highlight('node.type = item.default', 'ts')
    expect(of([line!], 'kw')).toEqual([])
    expect(line!.map((token) => token.text).join('')).toBe('node.type = item.default')
  })

  test('block comments and template strings continue across lines', () => {
    const multi = highlight('/* a\nb */ const x = `one\ntwo` + 1', 'ts')
    expect(kinds(multi[0])).toEqual(['cm:/* a'])
    expect(kinds(multi[1])[0]).toBe('cm:b */')
    expect(kinds(multi[1])).toContain('str:`one')
    expect(kinds(multi[2])[0]).toBe('str:two`')
    expect(kinds(multi[2])).toContain('str:1')
  })

  test('an unterminated string stops at the end of its line', () => {
    const broken = highlight("const a = 'oops\nconst b = 1", 'ts')
    expect(kinds(broken[1])[0]).toBe('kw:const')
  })
})

describe('other languages', () => {
  test('json keys, values and literals', () => {
    const [line] = highlight('{ "name": "cc-haha", "private": true, "n": -1.5 }', 'json')
    expect(kinds(line)).toEqual([
      'plain:{',
      'ty:"name"',
      'plain::',
      'str:"cc-haha"',
      'plain:,',
      'ty:"private"',
      'plain::',
      'kw:true',
      'plain:,',
      'ty:"n"',
      'plain::',
      'str:-1.5',
      'plain:}',
    ])
  })

  test('python comments, decorators, triple quotes and declarations', () => {
    const lines = highlight(
      '@cache\ndef load(path: str) -> None:\n    """多行\n    说明"""\n    return 42  # done',
      'py'
    )
    expect(kinds(lines[0])).toEqual(['ty:@cache'])
    expect(kinds(lines[1]).slice(0, 2)).toEqual(['kw:def', 'ty:load'])
    expect(of([lines[1]!], 'ty')).toEqual(['load', 'str'])
    expect(of([lines[1]!], 'kw')).toEqual(['def', 'None'])
    expect(kinds(lines[2])).toEqual(['str:"""多行'])
    expect(kinds(lines[3])).toEqual(['str:说明"""'])
    expect(kinds(lines[4])).toEqual(['kw:return', 'str:42', 'cm:# done'])
  })

  test('shell keywords, variables, strings and comments', () => {
    const lines = highlight(
      '#!/bin/sh\nif [ -n "$HOME" ]; then\n  echo ${PATH} $1 # show\nfi',
      'sh'
    )
    expect(kinds(lines[0])).toEqual(['cm:#!/bin/sh'])
    expect(of([lines[1]!], 'kw')).toEqual(['if', 'then'])
    expect(of([lines[1]!], 'str')).toEqual(['"$HOME"'])
    expect(of([lines[2]!], 'ty')).toEqual(['${PATH}', '$1'])
    expect(of([lines[2]!], 'cm')).toEqual(['# show'])
    expect(kinds(lines[3])).toEqual(['kw:fi'])
    // a `#` inside a word is not a comment
    expect(of(highlight('echo a#b', 'sh'), 'cm')).toEqual([])
  })

  test('css properties, values, at-rules and comments', () => {
    const lines = highlight(
      '@media (max-width: 600px) {\n  .card:hover { color: #fff; margin: 0 4px !important; }\n}\n/* end */',
      'css'
    )
    expect(of([lines[0]!], 'kw')).toEqual(['@media'])
    expect(of([lines[1]!], 'ty')).toEqual(['color', 'margin'])
    expect(of([lines[1]!], 'str')).toEqual(['#fff', '0', '4px'])
    expect(of([lines[1]!], 'kw')).toEqual(['!important'])
    expect(kinds(lines[3])).toEqual(['cm:/* end */'])
  })

  test('markdown headings, lists, inline code, links and fences', () => {
    const lines = highlight(
      '# 标题\n- 运行 `bun test`\n见 [文档](https://x.dev)\n```ts\nconst a = 1\n```\n> 引用',
      'md'
    )
    expect(kinds(lines[0])).toEqual(['kw:# 标题'])
    expect(kinds(lines[1])).toEqual(['kw:-', 'plain:运行', 'str:`bun test`'])
    expect(of([lines[2]!], 'ty')).toEqual(['(https://x.dev)'])
    expect(kinds(lines[3])).toEqual(['cm:```ts'])
    expect(kinds(lines[4])).toEqual(['str:const a = 1'])
    expect(kinds(lines[5])).toEqual(['cm:```'])
    expect(kinds(lines[6])).toEqual(['cm:> 引用'])
  })

  test('plain text and CRLF keep one row per line', () => {
    expect(highlight('a\r\nb\r\n', 'plain')).toEqual([
      [{ kind: 'plain', text: 'a' }],
      [{ kind: 'plain', text: 'b' }],
      [],
    ])
  })

  test('a large file tokenizes quickly', () => {
    const big = Array.from({ length: 20000 }, (_, i) => `export const v${i} = 'x' // ${i}`).join('\n')
    const started = performance.now()
    const lines = highlight(big, 'ts')
    expect(lines).toHaveLength(20000)
    expect(performance.now() - started).toBeLessThan(1500)
  })
})
