/**
 * 文件预览用的轻量语法高亮：只分四类 token（关键字 kw、字符串/数字 str、类型/声明名 ty、注释 cm），
 * 覆盖 ts/js/json/py/md/css/sh。目标是“看得清结构”，不是完整语法解析；
 * 跨行结构（块注释、模板字符串、三引号、代码块）会正确延续到后面的行。
 */
export type TokenKind = 'kw' | 'str' | 'ty' | 'cm' | 'plain'
export type Token = { kind: TokenKind; text: string }
export type CodeLanguage = 'ts' | 'js' | 'json' | 'py' | 'md' | 'css' | 'sh' | 'plain'

const byExtension: Record<string, CodeLanguage> = {
  ts: 'ts',
  tsx: 'ts',
  mts: 'ts',
  cts: 'ts',
  js: 'js',
  jsx: 'js',
  mjs: 'js',
  cjs: 'js',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  py: 'py',
  pyi: 'py',
  md: 'md',
  mdx: 'md',
  markdown: 'md',
  css: 'css',
  scss: 'css',
  less: 'css',
  sh: 'sh',
  bash: 'sh',
  zsh: 'sh',
}
const byHint: Record<string, CodeLanguage> = {
  typescript: 'ts',
  tsx: 'ts',
  javascript: 'js',
  jsx: 'js',
  json: 'json',
  python: 'py',
  markdown: 'md',
  css: 'css',
  scss: 'css',
  less: 'css',
  shell: 'sh',
  bash: 'sh',
  sh: 'sh',
  zsh: 'sh',
}
const shellNames = new Set(['.bashrc', '.zshrc', '.profile', '.bash_profile', '.zprofile', '.envrc'])

export function languageFor(path: string, hint?: string): CodeLanguage {
  const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? ''
  if (shellNames.has(name)) return 'sh'
  const extension = /\.([^.]+)$/.exec(name)?.[1]
  if (extension && byExtension[extension]) return byExtension[extension]
  return (hint && byHint[hint.toLowerCase()]) || 'plain'
}

class Output {
  tokens: Token[] = []
  push(kind: TokenKind, text: string) {
    if (!text) return
    const last = this.tokens[this.tokens.length - 1]
    if (last && last.kind === kind) last.text += text
    else this.tokens.push({ kind, text })
  }
}

const identifier = /[A-Za-z_$][\w$]*/y
const number = /(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?|\.\d[\d_]*(?:[eE][+-]?\d+)?)n?/y

function match(pattern: RegExp, source: string, index: number) {
  pattern.lastIndex = index
  return pattern.exec(source)?.[0]
}

/** 读到同一种引号（考虑反斜杠转义）为止；multiline 为 false 时遇到换行也结束。 */
function readQuoted(source: string, start: number, quote: string, multiline: boolean, escapes = true) {
  let index = start + quote.length
  while (index < source.length) {
    const char = source[index]!
    if (escapes && char === '\\') {
      index += 2
      continue
    }
    if (!multiline && char === '\n') return index
    if (source.startsWith(quote, index)) return index + quote.length
    index++
  }
  return source.length
}

function readUntil(source: string, start: number, end: string) {
  const found = source.indexOf(end, start)
  return found < 0 ? source.length : found + end.length
}

function lineEnd(source: string, start: number) {
  const found = source.indexOf('\n', start)
  return found < 0 ? source.length : found
}

const tsKeywords = new Set(
  'abstract as asserts async await break case catch class const continue debugger declare default delete do else enum export extends false finally for from function get if implements import in infer instanceof interface is keyof let namespace new null of override private protected public readonly return satisfies set static super switch this throw true try type typeof undefined unique var void while with yield'.split(' ')
)
const tsTypes = new Set('any bigint boolean never number object string symbol unknown'.split(' '))
const tsDeclarers = new Set(['function', 'class', 'interface', 'type', 'enum'])

function scanScript(source: string, out: Output) {
  let index = 0
  let declaring = false
  let previous = ''
  while (index < source.length) {
    const char = source[index]!
    const next = source[index + 1]
    if (char === '/' && next === '/') {
      const end = lineEnd(source, index)
      out.push('cm', source.slice(index, end))
      index = end
      continue
    }
    if (char === '/' && next === '*') {
      const end = readUntil(source, index + 2, '*/')
      out.push('cm', source.slice(index, end))
      index = end
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      const end = readQuoted(source, index, char, char === '`')
      out.push('str', source.slice(index, end))
      index = end
      previous = 'value'
      continue
    }
    if (/\d/.test(char) || (char === '.' && next !== undefined && /\d/.test(next))) {
      const text = match(number, source, index) ?? char
      out.push('str', text)
      index += text.length
      previous = 'value'
      continue
    }
    const word = /[A-Za-z_$]/.test(char) ? match(identifier, source, index) : undefined
    if (word) {
      // `obj.type`、`x.function` 这类属性名不是关键字。
      const property = previous === '.'
      if (!property && tsKeywords.has(word)) {
        out.push('kw', word)
        declaring = tsDeclarers.has(word)
      } else {
        const isType =
          declaring || /^[A-Z]/.test(word) || (!property && tsTypes.has(word))
        out.push(isType ? 'ty' : 'plain', word)
        declaring = false
      }
      index += word.length
      previous = 'value'
      continue
    }
    out.push('plain', char)
    if (!/\s/.test(char)) {
      previous = char
      if (char !== '*' && char !== '<') declaring = false
    }
    index++
  }
}

const pyKeywords = new Set(
  'False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case'.split(' ')
)
const pyTypes = new Set('int float str bool bytes list dict set tuple object type complex'.split(' '))

function scanPython(source: string, out: Output) {
  let index = 0
  let declaring = false
  while (index < source.length) {
    const char = source[index]!
    if (char === '#') {
      const end = lineEnd(source, index)
      out.push('cm', source.slice(index, end))
      index = end
      continue
    }
    if (char === '"' || char === "'") {
      const triple = source.startsWith(char.repeat(3), index) ? char.repeat(3) : char
      const end = readQuoted(source, index, triple, triple.length === 3)
      out.push('str', source.slice(index, end))
      index = end
      continue
    }
    if (/\d/.test(char)) {
      const text = match(number, source, index) ?? char
      out.push('str', text)
      index += text.length
      continue
    }
    if (char === '@' && /[A-Za-z_]/.test(source[index + 1] ?? '')) {
      const word = match(identifier, source, index + 1) ?? ''
      out.push('ty', `@${word}`)
      index += word.length + 1
      continue
    }
    const word = /[A-Za-z_]/.test(char) ? match(identifier, source, index) : undefined
    if (word) {
      if (pyKeywords.has(word)) {
        out.push('kw', word)
        declaring = word === 'def' || word === 'class'
      } else {
        out.push(declaring || pyTypes.has(word) || /^[A-Z]/.test(word) ? 'ty' : 'plain', word)
        declaring = false
      }
      index += word.length
      continue
    }
    out.push('plain', char)
    if (!/\s/.test(char)) declaring = false
    index++
  }
}

const shKeywords = new Set(
  'if then else elif fi for while until do done case esac function in select return local export readonly declare unset shift exit set source alias break continue'.split(' ')
)

function scanShell(source: string, out: Output) {
  let index = 0
  while (index < source.length) {
    const char = source[index]!
    const before = index === 0 ? '\n' : source[index - 1]!
    if (char === '#' && /\s/.test(before)) {
      const end = lineEnd(source, index)
      out.push('cm', source.slice(index, end))
      index = end
      continue
    }
    if (char === "'" || char === '"') {
      const end = readQuoted(source, index, char, true, char === '"')
      out.push('str', source.slice(index, end))
      index = end
      continue
    }
    if (char === '$') {
      const rest = source.slice(index + 1)
      const variable = rest.startsWith('{')
        ? rest.slice(0, readUntil(rest, 1, '}'))
        : (/^(?:[A-Za-z_]\w*|\d|[@*#?$!-])/.exec(rest)?.[0] ?? '')
      out.push(variable ? 'ty' : 'plain', `$${variable}`)
      index += variable.length + 1
      continue
    }
    const word =
      /[A-Za-z_]/.test(char) && !/[\w-]/.test(before)
        ? /^[A-Za-z_][\w-]*/.exec(source.slice(index, index + 64))?.[0]
        : undefined
    if (word) {
      out.push(shKeywords.has(word) ? 'kw' : 'plain', word)
      index += word.length
      continue
    }
    out.push('plain', char)
    index++
  }
}

function scanJson(source: string, out: Output) {
  let index = 0
  while (index < source.length) {
    const char = source[index]!
    if (char === '/' && source[index + 1] === '/') {
      const end = lineEnd(source, index)
      out.push('cm', source.slice(index, end))
      index = end
      continue
    }
    if (char === '/' && source[index + 1] === '*') {
      const end = readUntil(source, index + 2, '*/')
      out.push('cm', source.slice(index, end))
      index = end
      continue
    }
    if (char === '"' || char === "'") {
      const end = readQuoted(source, index, char, false)
      let after = end
      while (after < source.length && /[ \t]/.test(source[after]!)) after++
      out.push(source[after] === ':' ? 'ty' : 'str', source.slice(index, end))
      index = end
      continue
    }
    if (/[\d-]/.test(char)) {
      const text = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(index, index + 64))?.[0]
      if (text) {
        out.push('str', text)
        index += text.length
        continue
      }
    }
    const word = /[a-z]/.test(char) ? /^[a-z]+/.exec(source.slice(index, index + 16))?.[0] : undefined
    if (word) {
      out.push(word === 'true' || word === 'false' || word === 'null' ? 'kw' : 'plain', word)
      index += word.length
      continue
    }
    out.push('plain', char)
    index++
  }
}

function scanCss(source: string, out: Output) {
  let index = 0
  let depth = 0
  while (index < source.length) {
    const char = source[index]!
    if (char === '/' && source[index + 1] === '*') {
      const end = readUntil(source, index + 2, '*/')
      out.push('cm', source.slice(index, end))
      index = end
      continue
    }
    if (char === '/' && source[index + 1] === '/') {
      const end = lineEnd(source, index)
      out.push('cm', source.slice(index, end))
      index = end
      continue
    }
    if (char === '"' || char === "'") {
      const end = readQuoted(source, index, char, false)
      out.push('str', source.slice(index, end))
      index = end
      continue
    }
    if (char === '@' || char === '!') {
      const word = /^[@!][\w-]+/.exec(source.slice(index, index + 64))?.[0]
      if (word) {
        out.push('kw', word)
        index += word.length
        continue
      }
    }
    if (char === '#' && depth > 0) {
      const color = /^#[\da-fA-F]{3,8}\b/.exec(source.slice(index, index + 12))?.[0]
      if (color) {
        out.push('str', color)
        index += color.length
        continue
      }
    }
    if (depth > 0 && /[\d.]/.test(char) && !/[\w-]/.test(source[index - 1] ?? '')) {
      const value = /^\d*\.?\d+(?:%|[a-zA-Z]+)?/.exec(source.slice(index, index + 32))?.[0]
      if (value) {
        out.push('str', value)
        index += value.length
        continue
      }
    }
    const word =
      /[A-Za-z_-]/.test(char) && !/[\w-]/.test(source[index - 1] ?? '')
        ? /^-?-?[A-Za-z_][\w-]*/.exec(source.slice(index, index + 128))?.[0]
        : undefined
    if (word) {
      let after = index + word.length
      while (after < source.length && /[ \t]/.test(source[after]!)) after++
      // `a:hover {` 是嵌套选择器，`color: red;` 才是属性：看冒号后先遇到 `{` 还是 `;`/`}`。
      const rest = /^[^{};\n]*([{};\n]|$)/.exec(source.slice(after, after + 256))?.[1]
      out.push(depth > 0 && source[after] === ':' && rest !== '{' ? 'ty' : 'plain', word)
      index += word.length
      continue
    }
    if (char === '{') depth++
    else if (char === '}') depth = Math.max(0, depth - 1)
    out.push('plain', char)
    index++
  }
}

function scanMarkdownInline(line: string, out: Output) {
  let index = 0
  while (index < line.length) {
    const char = line[index]!
    if (char === '`') {
      const ticks = /^`+/.exec(line.slice(index))![0]
      const end = line.indexOf(ticks, index + ticks.length)
      if (end > 0) {
        out.push('str', line.slice(index, end + ticks.length))
        index = end + ticks.length
        continue
      }
    }
    if (char === '<' && line.startsWith('<!--', index)) {
      const end = line.indexOf('-->', index)
      const stop = end < 0 ? line.length : end + 3
      out.push('cm', line.slice(index, stop))
      index = stop
      continue
    }
    if (char === ']' && line[index + 1] === '(') {
      const end = line.indexOf(')', index + 2)
      if (end > 0) {
        out.push('plain', ']')
        out.push('ty', line.slice(index + 1, end + 1))
        index = end + 1
        continue
      }
    }
    out.push('plain', char)
    index++
  }
}

function scanMarkdown(source: string, out: Output) {
  let fence: string | null = null
  const lines = source.split('\n')
  lines.forEach((line, number) => {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line)
    if (fence) {
      if (fenceMatch && fenceMatch[1]!.startsWith(fence)) {
        out.push('cm', line)
        fence = null
      } else out.push('str', line)
    } else if (fenceMatch) {
      fence = fenceMatch[1]!
      out.push('cm', line)
    } else if (/^\s{0,3}#{1,6}(\s|$)/.test(line)) out.push('kw', line)
    else if (/^\s{0,3}>/.test(line)) out.push('cm', line)
    else if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) out.push('cm', line)
    else {
      const marker = /^(\s*)([-*+]|\d+[.)])(\s+)/.exec(line)
      if (marker) {
        out.push('plain', marker[1]!)
        out.push('kw', marker[2]!)
        out.push('plain', marker[3]!)
        scanMarkdownInline(line.slice(marker[0].length), out)
      } else scanMarkdownInline(line, out)
    }
    if (number < lines.length - 1) out.push('plain', '\n')
  })
}

/** 把 token 流按换行切成行；每行至少有一个 token（空行是空的 plain）。 */
function splitLines(tokens: Token[]) {
  const lines: Token[][] = [[]]
  for (const token of tokens) {
    const parts = token.text.split('\n')
    parts.forEach((part, index) => {
      if (index > 0) lines.push([])
      if (part) lines[lines.length - 1]!.push({ kind: token.kind, text: part })
    })
  }
  return lines
}

export function highlight(content: string, language: CodeLanguage): Token[][] {
  const source = content.replace(/\r\n?/g, '\n')
  if (language === 'plain') return source.split('\n').map((text) => (text ? [{ kind: 'plain', text }] : []))
  const out = new Output()
  if (language === 'ts' || language === 'js') scanScript(source, out)
  else if (language === 'py') scanPython(source, out)
  else if (language === 'sh') scanShell(source, out)
  else if (language === 'json') scanJson(source, out)
  else if (language === 'css') scanCss(source, out)
  else scanMarkdown(source, out)
  return splitLines(out.tokens)
}
