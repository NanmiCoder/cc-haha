import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/**
 * Dead-import detection for source trees that no compiler checks.
 *
 * `desktop/tsconfig.json` sets `noUnusedLocals` and the eslint config covers
 * `desktop/` only. `src/` has neither: the root `tsconfig.json` sets no such option,
 * and nothing installs `typescript` or `bun-types` at the root, so no tool reads it.
 * Splitting `src/server/ws/handler.ts` left nine imports behind whose symbols had all
 * moved out; every check passed and a human found them by reading the diff.
 *
 * Turning on `noUnusedLocals` at the root is not the fix. Over `src/` and `scripts/`
 * it adds 646 unused-symbol diagnostics to a baseline of 3225 that already fails, so
 * it would have to land disabled and would never go green.
 *
 * This is deliberately narrower than `noUnusedLocals` — imports only — because that
 * is the part that was actually unowned, and a check nobody can keep green gets
 * switched off. It found 27 more dead imports than the handler.ts split left, all
 * removed before it landed.
 *
 * The analysis is lexical, like `module-graph.ts`: an import whose binding appears
 * nowhere else in its own file is dead regardless of what it resolves to, and that is
 * decidable from the file alone without a compiler or a per-run install.
 */

/**
 * Directories this check owns: every source root no compiler checks.
 *
 * `desktop/` is absent because `desktop/tsconfig.json` already sets
 * `noUnusedLocals`, which is strictly stronger. Running this scan over it finds
 * nothing, which is the cross-check that the analysis agrees with a real compiler.
 */
export const DEAD_IMPORT_ROOTS = ['src', 'scripts', 'adapters'] as const

/**
 * Imports kept despite having no reference in their own file, keyed by
 * `deadImportKey`, valued by the reason.
 *
 * Empty. An entry needs a reason a reader can check: a side-effect import is already
 * exempt because it declares no binding, and a symbol used only by a sibling file
 * should be imported by that sibling.
 */
export const ALLOWED_DEAD_IMPORTS: Record<string, string> = {}

export type DeadImport = {
  /** Repo-relative file. */
  file: string
  /** The unreferenced local binding. */
  binding: string
  /** 1-based line of the import statement that declares it. */
  line: number
}

/**
 * Characters after which a `/` opens a regular expression rather than dividing.
 *
 * `)` and `}` are absent on purpose: `(a + b) / 2` is ordinary and a regex directly
 * after a closing bracket is not.
 */
const REGEX_MAY_FOLLOW = new Set(
  ['', '(', '[', '{', ',', ';', ':', '=', '!', '&', '|', '?', '+', '-', '*', '%', '^', '~', '<', '>'],
)

/** Keywords after which a `/` opens a regular expression. */
const REGEX_MAY_FOLLOW_KEYWORD = new Set(
  ['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await'],
)

/**
 * Whether the `!` before a slash ends an expression instead of negating one.
 *
 * `!` is the one character that reaches the slash from both sides: `!/re/.test(x)`
 * negates a regex test, and `estimates[i]! / total` is a TypeScript non-null
 * assertion followed by a division. What precedes the `!` settles it — an operand
 * ends with an identifier, a closing bracket or a literal.
 */
function endsExpressionBeforeSlash(blanked: readonly string[], slashIndex: number): boolean {
  let cursor = slashIndex - 1
  while (cursor >= 0 && /\s/.test(blanked[cursor]!)) cursor -= 1
  if (cursor < 0 || blanked[cursor] !== '!') return false
  cursor -= 1
  while (cursor >= 0 && /\s/.test(blanked[cursor]!)) cursor -= 1
  if (cursor < 0) return false
  return /[\w$)\]'"`]/.test(blanked[cursor]!)
}

/**
 * Blanks comments and literal text so an identifier scan sees code only.
 *
 * Three things must survive, because blanking any of them reports a live import as
 * dead: template substitutions (`${renderRow(x)}` is code), the code after a string
 * that contains `//` (a URL is not a comment), and the code after a regular
 * expression that contains a quote (`/'/g` is not a string — this is what
 * `src/utils/terminalShellEnvironment.ts` does, and missing it blanked 130 lines).
 */
export function blankNonCode(source: string): string {
  const out = source.split('')
  const blankTo = (from: number, to: number) => {
    for (let index = from; index < to && index < out.length; index += 1) {
      if (out[index] !== '\n') out[index] = ' '
    }
  }

  /** Brace depth at which each open template substitution returns to literal text. */
  const templateStack: number[] = []
  let braceDepth = 0
  /** Last significant code character, which decides `/` division vs regex. */
  let previous = ''
  /**
   * The last identifier token, empty if the last token was not one. Accumulated
   * from code only — reading it back out of the raw source let a preceding
   * comment's last word decide, which is how `// …correction tone` made the regex
   * on the next line lex as a division.
   */
  let word = ''
  /** Whether the cursor is inside that identifier, so `return false` stays two. */
  let inWord = false
  let index = 0

  /** Blanks a template's literal run; returns the index after it. */
  const consumeTemplateText = (from: number): number => {
    let cursor = from
    while (cursor < source.length) {
      if (source[cursor] === '\\') {
        cursor += 2
        continue
      }
      if (source[cursor] === '`') break
      if (source[cursor] === '$' && source[cursor + 1] === '{') break
      cursor += 1
    }
    blankTo(from, cursor)
    word = ''
    inWord = false
    if (source[cursor] === '`') {
      templateStack.pop()
      previous = '`'
      return cursor + 1
    }
    braceDepth += 1
    previous = '{'
    return cursor + 2
  }

  while (index < source.length) {
    const char = source[index]!
    const next = source[index + 1]

    // A comment is whitespace to the grammar, so it leaves `previous` and `word`
    // exactly as the code before it left them.
    if (char === '/' && next === '/') {
      let end = source.indexOf('\n', index)
      if (end === -1) end = source.length
      blankTo(index, end)
      inWord = false
      index = end
      continue
    }

    if (char === '/' && next === '*') {
      const closing = source.indexOf('*/', index + 2)
      const end = closing === -1 ? source.length : closing + 2
      blankTo(index, end)
      inWord = false
      index = end
      continue
    }

    if (char === '/') {
      const startsRegex = word
        ? REGEX_MAY_FOLLOW_KEYWORD.has(word)
        : REGEX_MAY_FOLLOW.has(previous) && !endsExpressionBeforeSlash(out, index)
      if (!startsRegex) {
        previous = '/'
        word = ''
        inWord = false
        index += 1
        continue
      }
      let cursor = index + 1
      let inCharacterClass = false
      while (cursor < source.length && source[cursor] !== '\n') {
        const current = source[cursor]
        if (current === '\\') {
          cursor += 2
          continue
        }
        if (current === '[') inCharacterClass = true
        else if (current === ']') inCharacterClass = false
        else if (current === '/' && !inCharacterClass) break
        cursor += 1
      }
      blankTo(index + 1, cursor)
      previous = '/'
      word = ''
      inWord = false
      index = cursor + 1
      continue
    }

    if (char === '"' || char === "'") {
      let cursor = index + 1
      while (cursor < source.length && source[cursor] !== char) {
        // A newline ends an unterminated quote rather than swallowing the file.
        if (source[cursor] === '\n') break
        cursor += source[cursor] === '\\' ? 2 : 1
      }
      blankTo(index + 1, cursor)
      previous = char
      word = ''
      inWord = false
      index = cursor + 1
      continue
    }

    if (char === '`') {
      templateStack.push(braceDepth)
      index = consumeTemplateText(index + 1)
      continue
    }

    if (char === '{') {
      braceDepth += 1
      previous = '{'
      word = ''
      inWord = false
      index += 1
      continue
    }

    if (char === '}') {
      braceDepth -= 1
      previous = '}'
      word = ''
      inWord = false
      index += 1
      if (templateStack.length > 0 && templateStack[templateStack.length - 1] === braceDepth) {
        index = consumeTemplateText(index)
      }
      continue
    }

    // Whitespace leaves both alone, so a line break does not look like a fresh
    // statement to the `/` decision above, and `return\n  /re/` still lexes.
    if (/[\w$]/.test(char)) {
      word = inWord ? word + char : char
      inWord = true
      previous = char
    } else if (!/\s/.test(char)) {
      word = ''
      inWord = false
      previous = char
    } else {
      // Whitespace ends the token but keeps it, so `return\n  /re/` still lexes.
      inWord = false
    }
    index += 1
  }

  return out.join('')
}

/**
 * `import <clause> from '<specifier>'`, anchored at a line start and multi-line aware.
 *
 * The clause may not contain a quote, which is what keeps a bare side-effect import
 * — a path and no clause — from consuming the next statement looking for its `from`.
 */
const IMPORT_STATEMENT = /^[ \t]*import\s+([^'"]*?)\s+from\s*['"][^'"]*['"]/gm

/**
 * Local bindings declared by one import clause.
 *
 * `import Default, { a as b, type C }` declares `Default`, `b` and `C`. The name a
 * symbol carries upstream never matters here — only what this file can reference.
 */
export function parseImportClause(clause: string): string[] {
  const bindings: string[] = []
  const withoutTypeKeyword = clause.replace(/^type\s+/, '')

  const braceStart = withoutTypeKeyword.indexOf('{')
  const head = braceStart === -1 ? withoutTypeKeyword : withoutTypeKeyword.slice(0, braceStart)
  const named = braceStart === -1
    ? ''
    : withoutTypeKeyword.slice(braceStart + 1, withoutTypeKeyword.lastIndexOf('}'))

  for (const part of head.split(',')) {
    const token = part.trim()
    if (!token) continue
    const namespace = token.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)$/)
    if (namespace) {
      bindings.push(namespace[1]!)
      continue
    }
    if (/^[A-Za-z_$][\w$]*$/.test(token)) bindings.push(token)
  }

  for (const part of named.split(',')) {
    const token = part.trim().replace(/^type\s+/, '')
    if (!token) continue
    const aliased = token.match(/^\S+\s+as\s+([A-Za-z_$][\w$]*)$/)
    if (aliased) {
      bindings.push(aliased[1]!)
      continue
    }
    if (/^[A-Za-z_$][\w$]*$/.test(token)) bindings.push(token)
  }

  return bindings
}

/** `\b` treats `$` as a boundary, so match the identifier character class directly. */
function referencedIn(body: string, binding: string): boolean {
  const escaped = binding.replace(/\$/g, '\\$&')
  return new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`).test(body)
}

const transpiler = new Bun.Transpiler({ loader: 'ts' })

function parses(source: string): boolean {
  try {
    transpiler.transformSync(source)
    return true
  } catch {
    return false
  }
}

/**
 * Whether `blankNonCode` stayed in sync with the file's grammar.
 *
 * Blanking only ever replaces comment and literal text with spaces, so the result
 * must still parse. When it does not, the lexer mistook code for a literal — and a
 * blanked reference reads as an unused import. This is the guard that makes a
 * lexical analysis safe to fail a build on, and it caught every desync this checker
 * has had: a regular expression holding a quote, `input! / 10` reading as a negated
 * regex test, `return false` accumulating into a single token, and a comment's last
 * word deciding how the next line lexed. All four are fixed; the guard stays.
 *
 * A file that never parsed is degraded too and needs no separate check, because
 * blanking cannot repair a syntax error.
 */
export function blankingIsSound(source: string): boolean {
  return parses(blankNonCode(source))
}

/**
 * Imports in `source` that nothing in `source` references.
 *
 * Side-effect imports declare no binding and cannot appear here.
 */
export function findDeadImports(source: string): Array<{ binding: string; line: number }> {
  const code = blankNonCode(source)
  const statements: Array<{ start: number; end: number; clause: string }> = []

  IMPORT_STATEMENT.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = IMPORT_STATEMENT.exec(code)) !== null) {
    statements.push({ start: match.index, end: match.index + match[0].length, clause: match[1]! })
  }

  // Every import statement is blanked before the scan: an import may only be kept
  // alive by code, never by another import that mentions the same name.
  const characters = code.split('')
  for (const statement of statements) {
    for (let index = statement.start; index < statement.end; index += 1) {
      if (characters[index] !== '\n') characters[index] = ' '
    }
  }
  const body = characters.join('')

  const dead: Array<{ binding: string; line: number }> = []
  for (const statement of statements) {
    const line = code.slice(0, statement.start).split('\n').length
    for (const binding of parseImportClause(statement.clause)) {
      if (!referencedIn(body, binding)) dead.push({ binding, line })
    }
  }
  return dead
}

const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', 'artifacts', 'target'])

function listSourceFiles(absoluteRoot: string, rootDir: string, out: string[] = []): string[] {
  let entries: string[]
  try {
    entries = readdirSync(absoluteRoot)
  } catch {
    return out
  }
  for (const entry of entries) {
    if (SKIPPED_DIRECTORIES.has(entry)) continue
    const fullPath = join(absoluteRoot, entry)
    if (statSync(fullPath).isDirectory()) {
      listSourceFiles(fullPath, rootDir, out)
      continue
    }
    if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      out.push(relative(rootDir, fullPath).split(sep).join('/'))
    }
  }
  return out
}

/**
 * Scan `roots` for imports nothing references.
 *
 * `degradedFiles` are the ones whose analysis was abandoned because blanking
 * desynced; they contribute no findings. They are returned rather than swallowed so
 * the check cannot quietly shrink to nothing.
 */
export function scanDeadImports(
  rootDir: string,
  roots: readonly string[] = DEAD_IMPORT_ROOTS,
): { dead: DeadImport[]; scannedFiles: string[]; degradedFiles: string[] } {
  const scannedFiles: string[] = []
  const degradedFiles: string[] = []
  const dead: DeadImport[] = []

  for (const root of roots) {
    for (const file of listSourceFiles(join(rootDir, root), rootDir).sort()) {
      scannedFiles.push(file)
      const source = readFileSync(join(rootDir, file), 'utf8')
      if (!blankingIsSound(source)) {
        degradedFiles.push(file)
        continue
      }
      for (const hit of findDeadImports(source)) {
        dead.push({ file, binding: hit.binding, line: hit.line })
      }
    }
  }

  return { dead, scannedFiles, degradedFiles }
}

/** Stable `file:line binding` key, used by the report and by the allowlist. */
export function deadImportKey(hit: DeadImport): string {
  return `${hit.file}:${hit.line} ${hit.binding}`
}
